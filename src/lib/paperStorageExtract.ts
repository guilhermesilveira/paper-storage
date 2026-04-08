import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { paperStorageVenvBin } from './paperStorageSetup';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageExtractionResult {
  page: number;
  method: 'pymupdf' | 'pdftotext' | 'tesseract' | 'marker' | 'provided';
  score: number;
}

export interface ExtractionResult {
  ok: boolean;
  pageCount: number;
  availableMethods: string[];
  pages: PageExtractionResult[];
  overallScore: number;
  lowQualityPages: number[];
  error?: string;
}

export type ExtractSpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

// ── Python extraction script ─────────────────────────────────────────────────

/**
 * The Python script is written to a temp file and executed once per PDF.
 * It runs all available methods per page, scores each result, picks the
 * best per page, then writes full.txt + pages/page-NNN.txt and prints
 * a single JSON object to stdout.
 *
 * Quality scoring uses three independent signals:
 *   1. CID ratio     — (cid:N) sequences = unmapped glyphs = definitive garbage
 *   2. Alpha ratio   — letters / non-whitespace, real text is mostly letters
 *   3. Tesseract conf — per-word confidence from TSV output (0–100), only when
 *                       tesseract ran; trusted more than heuristics because it
 *                       is internal to the OCR engine
 */
const EXTRACTION_SCRIPT = `
import sys, os, re, json, shutil, subprocess, tempfile

pdf_path   = sys.argv[1]
output_dir = sys.argv[2]

# ── helpers ──────────────────────────────────────────────────────────────────

def page_score(text, tesseract_conf=None):
    if not text or not text.strip():
        return 0.0
    non_ws = re.sub(r'\\s+', '', text)
    if not non_ws:
        return 0.0
    # Signal 1: CID sequences — definitive encoding failure
    cid_count = len(re.findall(r'\\(cid:\\d+\\)', text))
    cid_ratio  = (cid_count * 5) / max(len(non_ws), 1)
    if cid_ratio > 0.05:
        return 0.0
    # Signal 2: alphabetic ratio
    alpha_ratio = sum(1 for c in non_ws if c.isalpha()) / len(non_ws)
    # Signal 3: character diversity
    diversity = min(1.0, len(set(non_ws)) / 40)
    base = alpha_ratio * 0.6 + diversity * 0.4
    if tesseract_conf is not None:
        return base * 0.4 + tesseract_conf * 0.6
    return base

def ocr_page(img_path):
    """Run tesseract on an image, return (text, confidence 0-1)."""
    try:
        # Get text
        txt_result = subprocess.run(
            ['tesseract', img_path, 'stdout', '-l', 'eng', '--psm', '1'],
            capture_output=True, text=True, timeout=60
        )
        text = txt_result.stdout if txt_result.returncode == 0 else ''
        # Get per-word confidence via TSV
        tsv_result = subprocess.run(
            ['tesseract', img_path, 'stdout', '-l', 'eng', '--psm', '1', 'tsv'],
            capture_output=True, text=True, timeout=60
        )
        conf = 0.0
        if tsv_result.returncode == 0 and tsv_result.stdout.strip():
            lines = tsv_result.stdout.strip().split('\\n')
            if len(lines) > 1:
                confs = []
                for line in lines[1:]:
                    parts = line.split('\\t')
                    if len(parts) >= 12:
                        try:
                            c = int(parts[10])
                            if c >= 0:
                                confs.append(c)
                        except (ValueError, IndexError):
                            pass
                if confs:
                    conf = sum(confs) / len(confs) / 100.0
        return text, conf
    except Exception:
        return '', 0.0

# ── probe available tools ─────────────────────────────────────────────────────

has_pdftotext = shutil.which('pdftotext') is not None
has_tesseract = shutil.which('tesseract') is not None

available = ['pymupdf']
if has_pdftotext:
    available.append('pdftotext')
if has_tesseract:
    available.append('tesseract')

# ── open PDF ──────────────────────────────────────────────────────────────────

try:
    import fitz
except ImportError:
    json.dump({'ok': False, 'error': 'PyMuPDF not installed'}, sys.stdout)
    sys.exit(1)

if not pdf_path.lower().endswith('.pdf'):
    json.dump({'ok': False, 'error': 'unsupported-format'}, sys.stdout)
    sys.exit(0)

try:
    doc = fitz.open(pdf_path)
except Exception as e:
    json.dump({'ok': False, 'error': f'cannot-open: {e}'}, sys.stdout)
    sys.exit(0)

page_count = len(doc)
os.makedirs(os.path.join(output_dir, 'pages'), exist_ok=True)

# ── extract each page ────────────────────────────────────────────────────────

QUALITY_THRESHOLD = 0.4   # below this on both native methods → run tesseract
page_results = []
full_text_parts = []

with tempfile.TemporaryDirectory() as ocr_tmp:
    for i in range(page_count):
        page_num = i + 1
        candidates = []  # (score, method, text)

        # ① PyMuPDF
        try:
            text_mu = doc[i].get_text()
        except Exception:
            text_mu = ''
        score_mu = page_score(text_mu)
        candidates.append((score_mu, 'pymupdf', text_mu))

        # ② pdftotext (if available)
        if has_pdftotext:
            try:
                r = subprocess.run(
                    ['pdftotext', '-layout', '-f', str(page_num), '-l', str(page_num),
                     pdf_path, '-'],
                    capture_output=True, text=True, timeout=30
                )
                text_pt = r.stdout if r.returncode == 0 else ''
            except Exception:
                text_pt = ''
            score_pt = page_score(text_pt)
            candidates.append((score_pt, 'pdftotext', text_pt))

        # ③ tesseract — only when both native methods score poorly
        best_native = max(c[0] for c in candidates)
        if has_tesseract and best_native < QUALITY_THRESHOLD:
            try:
                img_path = os.path.join(ocr_tmp, f'page-{page_num:03d}.png')
                pix = doc[i].get_pixmap(dpi=300)
                pix.save(img_path)
                text_tess, conf_tess = ocr_page(img_path)
            except Exception:
                text_tess, conf_tess = '', 0.0
            score_tess = page_score(text_tess, tesseract_conf=conf_tess)
            candidates.append((score_tess, 'tesseract', text_tess))

        # Pick best
        best_score, best_method, best_text = max(candidates, key=lambda c: c[0])
        page_file = os.path.join(output_dir, 'pages', f'page-{page_num:03d}.txt')
        with open(page_file, 'w', encoding='utf-8') as f:
            f.write(best_text)
        full_text_parts.append(best_text)
        page_results.append({
            'page': page_num,
            'method': best_method,
            'score': round(best_score, 4),
        })

# ── write full.txt ────────────────────────────────────────────────────────────

with open(os.path.join(output_dir, 'full.txt'), 'w', encoding='utf-8') as f:
    f.write('\\n\\n'.join(full_text_parts))

# ── build summary ─────────────────────────────────────────────────────────────

scores = [p['score'] for p in page_results]
overall = round(sum(scores) / len(scores), 4) if scores else 0.0
low_quality = [p['page'] for p in page_results if p['score'] < QUALITY_THRESHOLD]

result = {
    'ok': True,
    'pageCount': page_count,
    'availableMethods': available,
    'pages': page_results,
    'overallScore': overall,
    'lowQualityPages': low_quality,
}
json.dump(result, sys.stdout)
`.trim();

// ── TypeScript module ─────────────────────────────────────────────────────────

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024, // 64MB — large PDFs produce a lot of text
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

/**
 * Extract text from a PDF into outputDir/full.txt + outputDir/pages/page-NNN.txt.
 *
 * Strategy: run all available methods per page (PyMuPDF always, pdftotext if
 * installed, tesseract when native methods score poorly), score each result,
 * pick the best per page. Quality over speed — this is a store-once operation.
 *
 * Accepts an injectable spawnFn for testing.
 */
export function extractPdfText(opts: {
  pdfPath: string;
  outputDir: string;
  spawnFn?: ExtractSpawnFn;
  /** Override python3 binary path. Defaults to managed venv, then system. */
  python3Bin?: string;
}): ExtractionResult {
  const spawn = opts.spawnFn ?? defaultSpawn;
  const python3 = opts.python3Bin ?? paperStorageVenvBin('python3') ?? 'python3';

  mkdirSync(opts.outputDir, { recursive: true });

  // Write Python script to a temp file
  const tmpDir = mkdtempSync(join(tmpdir(), 'psr-extract-'));
  const scriptPath = join(tmpDir, 'extract.py');
  try {
    writeFileSync(scriptPath, EXTRACTION_SCRIPT, 'utf-8');

    const result = spawn(python3, [scriptPath, opts.pdfPath, opts.outputDir], {});

    if (result.status !== 0) {
      return {
        ok: false,
        pageCount: 0,
        availableMethods: [],
        pages: [],
        overallScore: 0,
        lowQualityPages: [],
        error: `python3 exited with code ${result.status ?? 'null'}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    let parsed: ExtractionResult;
    try {
      parsed = JSON.parse(result.stdout) as ExtractionResult;
    } catch {
      return {
        ok: false,
        pageCount: 0,
        availableMethods: [],
        pages: [],
        overallScore: 0,
        lowQualityPages: [],
        error: `malformed JSON from extraction script: ${result.stdout.slice(0, 200)}`,
      };
    }

    return parsed;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ── Text scoring (TypeScript port of Python page_score) ───────────────────────

/**
 * Score a plain-text string on a 0–1 scale.
 * Mirrors the Python `page_score()` in the extraction script.
 * Used for Marker output scoring (CID check omitted — Marker never emits CIDs).
 */
export function computeTextScore(text: string): number {
  const nonWs = text.replace(/\s+/g, '');
  if (!nonWs) return 0;
  const alphaCount = [...nonWs].filter((c) => /[a-zA-Z]/.test(c)).length;
  const alphaRatio  = alphaCount / nonWs.length;
  const uniqueChars = new Set(nonWs).size;
  const diversity   = Math.min(1.0, uniqueChars / 40);
  return Math.round((alphaRatio * 0.6 + diversity * 0.4) * 10000) / 10000;
}

// ── Marker extraction ─────────────────────────────────────────────────────────

export interface MarkerExtractDeps {
  spawnFn?: ExtractSpawnFn;
  mkdtempSyncFn?: (prefix: string) => string;
  existsSyncFn?: (p: string) => boolean;
  readFileSyncFn?: (p: string) => string;
  writeFileSyncFn?: (p: string, content: string) => void;
  copyFileSyncFn?: (src: string, dst: string) => void;
  readdirSyncFn?: (dir: string) => string[];
  mkdirSyncFn?: (p: string, opts?: { recursive?: boolean }) => void;
  rmSyncFn?: (p: string, opts?: { recursive?: boolean; force?: boolean }) => void;
}

/**
 * Extract text from a PDF using Marker (marker_single CLI).
 *
 * Returns null when marker_single is not found in PATH.
 * Returns an ExtractionResult with ok=false when Marker is available but fails.
 * Returns an ExtractionResult with ok=true and markdown as full.txt on success.
 *
 * Per-page text files (pages/) are NOT written — Marker produces a single document.
 * Page count is read from Marker's _meta.json (page_stats array length).
 */
export function extractWithMarker(opts: {
  pdfPath: string;
  outputDir: string;
  _deps?: MarkerExtractDeps;
}): ExtractionResult | null {
  const deps = opts._deps ?? {};
  const spawn    = deps.spawnFn        ?? defaultSpawn;
  const mkdtemp_ = deps.mkdtempSyncFn  ?? ((p: string) => mkdtempSync(p));
  const exists_  = deps.existsSyncFn   ?? existsSync;
  const read_    = deps.readFileSyncFn ?? ((p: string) => readFileSync(p, 'utf-8'));
  const write_   = deps.writeFileSyncFn ?? ((p: string, c: string) => writeFileSync(p, c, 'utf-8'));
  const copy_    = deps.copyFileSyncFn ?? copyFileSync;
  const readdir_ = deps.readdirSyncFn ?? ((d: string) => readdirSync(d));
  const mkdir_   = deps.mkdirSyncFn    ?? ((p: string, o?: { recursive?: boolean }) => mkdirSync(p, { recursive: true, ...o }));
  const rm_      = deps.rmSyncFn       ?? ((p: string, o?: { recursive?: boolean; force?: boolean }) => rmSync(p, { recursive: true, force: true, ...o }));

  // ── Resolve marker_single binary ─────────────────────────────────────────
  // 1. Check managed venv first
  const venvMarkerPath = paperStorageVenvBin('marker_single', exists_);
  let markerBin: string | null = venvMarkerPath;
  if (!markerBin) {
    // 2. Check system PATH
    const whichResult = spawn('which', ['marker_single'], {});
    if ((whichResult.status ?? 1) !== 0) return null;
    markerBin = whichResult.stdout.trim() || 'marker_single';
  }

  // ── Run marker_single ──────────────────────────────────────────────────────
  const tmpDir = mkdtemp_(join(tmpdir(), 'psr-marker-'));
  try {
    const run = spawn(markerBin, [
      opts.pdfPath,
      '--output_dir', tmpDir,
      '--output_format', 'markdown',
      '--disable_multiprocessing',
    ], {});

    if ((run.status ?? 1) !== 0) {
      return {
        ok: false,
        pageCount: 0,
        availableMethods: ['marker'],
        pages: [],
        overallScore: 0,
        lowQualityPages: [],
        error: `marker_single failed: ${run.stderr.trim() || run.stdout.trim() || 'unknown error'}`,
      };
    }

    // ── Find output files ──────────────────────────────────────────────────
    const pdfBase  = basename(opts.pdfPath, '.pdf');
    const subdir   = join(tmpDir, pdfBase);
    const mdPath   = join(subdir, `${pdfBase}.md`);
    const metaPath = join(subdir, `${pdfBase}_meta.json`);

    if (!exists_(mdPath)) {
      return {
        ok: false,
        pageCount: 0,
        availableMethods: ['marker'],
        pages: [],
        overallScore: 0,
        lowQualityPages: [],
        error: `marker_single produced no output at ${mdPath}`,
      };
    }

    const markdown = read_(mdPath);

    // ── Page count from meta.json ──────────────────────────────────────────
    let pageCount = 0;
    if (exists_(metaPath)) {
      try {
        const meta = JSON.parse(read_(metaPath)) as { page_stats?: unknown[] };
        pageCount = meta.page_stats?.length ?? 0;
      } catch { /* ignore parse errors */ }
    }

    // ── Write full.txt (markdown) ──────────────────────────────────────────
    mkdir_(opts.outputDir, { recursive: true });
    write_(join(opts.outputDir, 'full.txt'), markdown);

    // ── Copy extracted images ────────────────────────────────────────────
    // Marker writes figures as *.jpeg / *.png alongside the .md file.
    // We copy them into outputDir/images/ so they get committed to the repo.
    try {
      const IMAGE_EXTS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);
      const files = readdir_(subdir);
      const imageFiles = files.filter((f) => IMAGE_EXTS.has(f.slice(f.lastIndexOf('.')).toLowerCase()));
      if (imageFiles.length > 0) {
        const imagesDir = join(opts.outputDir, 'images');
        mkdir_(imagesDir, { recursive: true });
        for (const img of imageFiles) {
          copy_(join(subdir, img), join(imagesDir, img));
        }
      }
    } catch {
      // best-effort — don't fail extraction over image copy errors
    }

    // ── Score the text (strip LaTeX/markdown noise first) ─────────────────
    const plainish = markdown
      .replace(/\$\$[\s\S]*?\$\$/g, ' equation ')    // block math
      .replace(/\$[^$\n]*?\$/g, ' equation ')         // inline math
      .replace(/[#*`!]/g, '')                        // markdown markup: core chars
      .replace(/\[/g, '')                            // markdown: link/source brackets
    const score = computeTextScore(plainish);

    const nPages = pageCount > 0 ? pageCount : 1;
    const pages: PageExtractionResult[] = Array.from({ length: nPages }, (_, i) => ({
      page: i + 1,
      method: 'marker' as const,
      score,
    }));

    return {
      ok: true,
      pageCount,
      availableMethods: ['marker'],
      pages,
      overallScore: score,
      lowQualityPages: pages.filter((p) => p.score < 0.4).map((p) => p.page),
    };
  } finally {
    try { rm_(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
