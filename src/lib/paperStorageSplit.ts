import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SplitResult {
  split: boolean;
  partCount: number;
  /** Absolute paths to each part file, in order. Empty when split=false. */
  partPaths: string[];
}

export type SplitSpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

// ── Constants ────────────────────────────────────────────────────────────────

/** Files larger than this are split. Default: 90 MB. */
export const DEFAULT_SPLIT_THRESHOLD_BYTES = 90 * 1024 * 1024;

/** Each part must fit within this size. Default: 80 MB. */
export const DEFAULT_PART_MAX_BYTES = 80 * 1024 * 1024;

// ── Python scripts ───────────────────────────────────────────────────────────

/**
 * Splits a PDF into parts each ≤ partMaxBytes.
 * Uses binary search per part to find the largest page range that fits.
 * Prints a JSON object: { ok, partCount, partPaths: [...] }
 */
const SPLIT_SCRIPT = `
import sys, os, json
import fitz

pdf_path    = sys.argv[1]
output_dir  = sys.argv[2]
part_max    = int(sys.argv[3])   # bytes

os.makedirs(output_dir, exist_ok=True)
doc = fitz.open(pdf_path)
total = len(doc)

part_num  = 1
start     = 0
part_paths = []

while start < total:
    # Binary-search for largest page range [start, end) that fits part_max
    lo, hi = start + 1, total
    best   = start + 1   # at minimum one page

    while lo <= hi:
        mid = (lo + hi) // 2
        sub = fitz.open()
        sub.insert_pdf(doc, from_page=start, to_page=mid - 1)
        with open(os.devnull, 'wb') as nul:
            data = sub.tobytes()
        if len(data) <= part_max:
            best = mid
            lo   = mid + 1
        else:
            hi   = mid - 1
        sub.close()

    # Write this part
    part_path = os.path.join(output_dir, f'part-{part_num:03d}.pdf')
    sub = fitz.open()
    sub.insert_pdf(doc, from_page=start, to_page=best - 1)
    sub.save(part_path)
    sub.close()
    part_paths.append(part_path)
    part_num += 1
    start = best

doc.close()
print(json.dumps({'ok': True, 'partCount': len(part_paths), 'partPaths': part_paths}))
`.trim();

/**
 * Reassembles split parts back into a single PDF.
 * Prints a JSON object: { ok }
 */
const REASSEMBLE_SCRIPT = `
import sys, os, json, glob
import fitz

parts_dir   = sys.argv[1]
output_path = sys.argv[2]

pattern = os.path.join(parts_dir, 'part-*.pdf')
parts   = sorted(glob.glob(pattern))

if not parts:
    print(json.dumps({'ok': False, 'error': 'no parts found'}))
    sys.exit(0)

out = fitz.open()
for part_path in parts:
    src = fitz.open(part_path)
    out.insert_pdf(src)
    src.close()

os.makedirs(os.path.dirname(output_path), exist_ok=True)
out.save(output_path)
out.close()
print(json.dumps({'ok': True}))
`.trim();

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function runPythonScript(
  script: string,
  scriptArgs: string[],
  spawn: SplitSpawnFn,
): { ok: boolean; stdout: string; stderr: string; parsed?: Record<string, unknown> } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'prs-'));
  const scriptPath = join(tmpDir, 'script.py');
  try {
    writeFileSync(scriptPath, script, 'utf-8');
    const result = spawn('python3', [scriptPath, ...scriptArgs], {});
    if (result.status !== 0) {
      return { ok: false, stdout: result.stdout, stderr: result.stderr };
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return { ok: false, stdout: result.stdout, stderr: `malformed JSON: ${result.stdout.slice(0, 200)}` };
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr, parsed };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Split a PDF into parts if it exceeds the size threshold.
 * Parts are written to `outputDir/part-NNN.pdf`.
 * Returns { split: false } when the file is within the threshold.
 */
export function splitPdfIfNeeded(opts: {
  pdfPath: string;
  outputDir: string;
  thresholdBytes?: number;
  partMaxBytes?: number;
  spawnFn?: SplitSpawnFn;
}): SplitResult {
  const threshold = opts.thresholdBytes ?? DEFAULT_SPLIT_THRESHOLD_BYTES;
  const partMax   = opts.partMaxBytes   ?? DEFAULT_PART_MAX_BYTES;
  const spawn     = opts.spawnFn        ?? defaultSpawn;

  const size = statSync(opts.pdfPath).size;
  if (size <= threshold) {
    return { split: false, partCount: 0, partPaths: [] };
  }

  mkdirSync(opts.outputDir, { recursive: true });

  const result = runPythonScript(
    SPLIT_SCRIPT,
    [opts.pdfPath, opts.outputDir, String(partMax)],
    spawn,
  );

  if (!result.ok || !result.parsed?.ok) {
    throw new Error(
      `PDF split failed: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`,
    );
  }

  const partPaths = (result.parsed.partPaths as string[]);
  return {
    split: true,
    partCount: partPaths.length,
    partPaths,
  };
}

/**
 * Reassemble split PDF parts back into a single file.
 * Reads all `part-NNN.pdf` files from `partsDir` in sorted order.
 */
export function reassemblePdf(opts: {
  partsDir: string;
  outputPath: string;
  spawnFn?: SplitSpawnFn;
}): void {
  const spawn = opts.spawnFn ?? defaultSpawn;

  const result = runPythonScript(
    REASSEMBLE_SCRIPT,
    [opts.partsDir, opts.outputPath],
    spawn,
  );

  if (!result.ok || !result.parsed?.ok) {
    throw new Error(
      `PDF reassemble failed: ${result.stderr.trim() || result.stdout.trim() || String(result.parsed?.error ?? 'unknown error')}`,
    );
  }
}
