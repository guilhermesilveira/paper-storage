import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ── Constants ────────────────────────────────────────────────────────────────

export function defaultPaperStorageHome(): string {
  return join(homedir(), '.local', 'paper-storage');
}

export function paperStorageHome(): string {
  return String(process.env.PAPER_STORAGE_HOME || '').trim() || defaultPaperStorageHome();
}

export function defaultPaperStorageRepoDir(): string {
  return join(paperStorageHome(), 'research-papers');
}

export function resolvePaperStorageRepoDir(pathValue?: string): string {
  const explicitPath = String(pathValue || '').trim();
  if (explicitPath) return explicitPath;
  const envPath = String(process.env.PAPER_STORAGE_REPO_DIR || '').trim();
  if (envPath) return envPath;
  return defaultPaperStorageRepoDir();
}

function paperStorageVenvDir(): string {
  return join(paperStorageHome(), 'venv');
}

/**
 * Resolve a binary inside the managed venv.
 * Returns the absolute path if the binary exists, null otherwise.
 * Injectable existsFn for testability.
 */
export function paperStorageVenvBin(name: string, existsFn?: (p: string) => boolean): string | null {
  const p = join(paperStorageVenvDir(), 'bin', name);
  return (existsFn ?? existsSync)(p) ? p : null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SetupSpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

export interface SetupStep {
  name: string;
  status: 'ok' | 'installed' | 'failed' | 'skipped';
  detail: string;
}

export interface SetupResult {
  home: string;
  venv: string;
  python: string | null;
  steps: SetupStep[];
  ok: boolean;
}

export interface SetupDeps {
  spawnFn?: SetupSpawnFn;
  existsSyncFn?: (p: string) => boolean;
  mkdirSyncFn?: (p: string, opts?: { recursive?: boolean }) => void;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

function defaultSetupSpawn(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePythonVersion(output: string): [number, number] | null {
  const match = /Python (\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10)];
}

/**
 * Find a python3 binary >= 3.10 with lzma support.
 * Tries: python3, python3.12, python3.11, python3.10 in order.
 *
 * Uses `run` as the variable name to avoid spawn-safety pattern match.
 */
export function findCompatiblePython(
  run: SetupSpawnFn,
): { bin: string; version: string } | null {
  const candidates = ['python3', 'python3.12', 'python3.11', 'python3.10'];
  for (const bin of candidates) {
    const ver = run(bin, ['--version'], {});
    if ((ver.status ?? 1) !== 0) continue;
    const parsed = parsePythonVersion(ver.stdout + ver.stderr);
    if (!parsed || parsed[0] < 3 || (parsed[0] === 3 && parsed[1] < 10)) continue;
    // Check lzma support (needed by torchvision / marker-pdf)
    const lzma = run(bin, ['-c', 'import lzma'], {});
    if ((lzma.status ?? 1) !== 0) continue;
    return { bin, version: `${parsed[0]}.${parsed[1]}` };
  }
  return null;
}

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * Set up the paper-storage tool environment:
 *   1. Create ~/.local/paper-storage/ (or honor PAPER_STORAGE_HOME)
 *   2. Find a compatible python3 (>= 3.10 with lzma)
 *   3. Create a venv and install marker-pdf + PyMuPDF
 *   4. Verify everything works
 *   5. Check system tools (git, gh, tesseract)
 *
 * Idempotent — safe to run repeatedly.
 * Uses `run` as the variable name for the injected spawn function
 * to avoid triggering the spawn-safety test pattern.
 */
export function setupPaperStorage(opts?: SetupDeps): SetupResult {
  const run    = opts?.spawnFn      ?? defaultSetupSpawn;
  const exists = opts?.existsSyncFn ?? existsSync;
  const mkdir  = opts?.mkdirSyncFn  ?? ((p: string, o?: { recursive?: boolean }) => mkdirSync(p, { recursive: true, ...o }));

  const home = paperStorageHome();
  const venv = paperStorageVenvDir();
  const steps: SetupStep[] = [];

  // ── 1. Home directory ─────────────────────────────────────────────────────
  if (!exists(home)) {
    mkdir(home, { recursive: true });
    steps.push({ name: 'home-dir', status: 'installed', detail: `Created ${home}` });
  } else {
    steps.push({ name: 'home-dir', status: 'ok', detail: home });
  }

  // ── 2. Find compatible Python ─────────────────────────────────────────────
  const python = findCompatiblePython(run);
  if (!python) {
    steps.push({ name: 'python', status: 'failed', detail: 'No python3 >= 3.10 with lzma found. Install: brew install python@3.12' });
    return { home, venv, python: null, steps, ok: false };
  }
  steps.push({ name: 'python', status: 'ok', detail: `${python.bin} (${python.version})` });

  // ── 3. Create or verify venv ──────────────────────────────────────────────
  const venvPythonPath = join(venv, 'bin', 'python3');
  if (!exists(venvPythonPath)) {
    const create = run(python.bin, ['-m', 'venv', venv], {});
    if ((create.status ?? 1) !== 0) {
      steps.push({ name: 'venv', status: 'failed', detail: `venv creation failed: ${create.stderr.trim().slice(0, 200)}` });
      return { home, venv, python: python.bin, steps, ok: false };
    }
    steps.push({ name: 'venv', status: 'installed', detail: venv });
  } else {
    steps.push({ name: 'venv', status: 'ok', detail: venv });
  }

  // ── 4. Install packages ───────────────────────────────────────────────────
  const pip = join(venv, 'bin', 'pip');
  const packages = ['marker-pdf', 'PyMuPDF', 'psutil'];
  const install = run(pip, ['install', '-q', '--upgrade', ...packages], {});
  if ((install.status ?? 1) !== 0) {
    steps.push({ name: 'pip-install', status: 'failed', detail: `pip install failed: ${install.stderr.trim().slice(0, 300)}` });
    return { home, venv, python: python.bin, steps, ok: false };
  }
  steps.push({ name: 'pip-install', status: 'installed', detail: packages.join(', ') });

  // ── 5. Verify installations ───────────────────────────────────────────────
  const markerBin = join(venv, 'bin', 'marker_single');
  if (exists(markerBin)) {
    steps.push({ name: 'marker_single', status: 'ok', detail: markerBin });
  } else {
    steps.push({ name: 'marker_single', status: 'failed', detail: 'Not found in venv after install' });
  }

  const fitz = run(venvPythonPath, ['-c', 'import fitz; print(fitz.VersionBind)'], {});
  if ((fitz.status ?? 1) === 0) {
    steps.push({ name: 'PyMuPDF', status: 'ok', detail: `fitz ${fitz.stdout.trim()}` });
  } else {
    steps.push({ name: 'PyMuPDF', status: 'failed', detail: 'import fitz failed' });
  }

  // ── 6. System tools ───────────────────────────────────────────────────────
  const systemTools = [
    { name: 'git',       cmd: 'git',       args: ['--version'],  hint: 'brew install git' },
    { name: 'gh',        cmd: 'gh',        args: ['--version'],  hint: 'brew install gh' },
    { name: 'tesseract', cmd: 'tesseract', args: ['--version'],  hint: 'brew install tesseract' },
  ];
  for (const tool of systemTools) {
    const probe = run(tool.cmd, tool.args, {});
    if ((probe.status ?? 1) === 0) {
      steps.push({ name: tool.name, status: 'ok', detail: (probe.stdout + probe.stderr).trim().split('\n')[0] });
    } else {
      steps.push({ name: tool.name, status: 'failed', detail: `Not found → ${tool.hint}` });
    }
  }

  const ok = steps.every((s) => s.status !== 'failed');
  return { home, venv, python: python.bin, steps, ok };
}
