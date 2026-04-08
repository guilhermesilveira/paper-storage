import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCommandSync } from './processUtils';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCheckItem {
  name: string;
  found: boolean;
  version?: string;
  installHint: string;
}

export interface ToolCheckResult {
  ok: boolean;
  tools: ToolCheckItem[];
}

export interface InitRepoResult {
  path: string;
  alreadyExists: boolean;
  githubRepoCreated: boolean;
}

// Injected functions for testability.
export type CheckSpawnFn = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

export type InitSpawnFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

// ── Defaults ─────────────────────────────────────────────────────────────────

function defaultCheckSpawn(
  cmd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnCommandSync(cmd, args);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function defaultInitSpawn(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnCommandSync(cmd, args, opts?.cwd ? { cwd: opts.cwd } : {});
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ── Tool check ───────────────────────────────────────────────────────────────

function extractVersion(output: string, pattern: RegExp): string | undefined {
  return output.match(pattern)?.[1]?.trim() || undefined;
}

/**
 * Check that all tools required by paper-storage are present.
 * Accepts injectable functions so tests can run without real binaries.
 */
export function checkRequiredTools(opts?: { spawnFn?: CheckSpawnFn }): ToolCheckResult {
  const spawn = opts?.spawnFn ?? defaultCheckSpawn;
  const tools: ToolCheckItem[] = [];

  // git
  const gitProbe = spawn('git', ['--version']);
  const gitFound = (gitProbe.status ?? 1) === 0;
  tools.push({
    name: 'git',
    found: gitFound,
    version: gitFound ? extractVersion(gitProbe.stdout, /git version (\S+)/) : undefined,
    installHint: 'brew install git',
  });

  // gh
  const ghProbe = spawn('gh', ['--version']);
  const ghFound = (ghProbe.status ?? 1) === 0;
  tools.push({
    name: 'gh',
    found: ghFound,
    version: ghFound ? extractVersion(ghProbe.stdout, /gh version (\S+)/) : undefined,
    installHint: 'brew install gh',
  });

  // python3
  const pythonProbe = spawn('python3', ['--version']);
  const pythonFound = (pythonProbe.status ?? 1) === 0;
  tools.push({
    name: 'python3',
    found: pythonFound,
    // python3 --version prints to stdout on 3.x, stderr on older 2.x
    version: pythonFound
      ? extractVersion(pythonProbe.stdout + pythonProbe.stderr, /Python (\S+)/)
      : undefined,
    installHint: 'brew install python3',
  });

  // PyMuPDF — checked via python3 import
  const pymupdfProbe = spawn('python3', ['-c', 'import fitz; print(fitz.VersionBind)']);
  const pymupdfFound = (pymupdfProbe.status ?? 1) === 0 && !!pymupdfProbe.stdout.trim();
  tools.push({
    name: 'PyMuPDF',
    found: pymupdfFound,
    version: pymupdfFound ? pymupdfProbe.stdout.trim() : undefined,
    installHint: 'pip3 install PyMuPDF',
  });

  // tesseract
  const tesseractProbe = spawn('tesseract', ['--version']);
  const tesseractFound = (tesseractProbe.status ?? 1) === 0;
  tools.push({
    name: 'tesseract',
    found: tesseractFound,
    // tesseract prints version to stderr
    version: tesseractFound
      ? extractVersion(tesseractProbe.stdout + tesseractProbe.stderr, /tesseract (\S+)/)
      : undefined,
    installHint: 'brew install tesseract',
  });

  return { ok: tools.every((t) => t.found), tools };
}

// ── Repo files ───────────────────────────────────────────────────────────────

const INDEX_JSON_INITIAL =
  JSON.stringify({ byUuid: {}, byDoi: {}, byName: {} }, null, 2) + '\n';

const GITIGNORE_CONTENT = '*.tmp\n/tmp/\n.DS_Store\n';

function buildReadme(): string {
  return `# paper-storage

Private paper storage repo managed by \`paper-storage\`.

## Structure

\`\`\`
index.json          # lookup indices (byUuid, byDoi, byName)
papers/
  <uuid>/
    metadata.json   # paper metadata
    original.pdf    # original file (if ≤90MB)
    parts/          # split parts (if >90MB)
    full.txt        # extracted text
    pages/          # per-page text files
\`\`\`

## Usage

\`\`\`bash
# Store a paper (auto stages, commits, and pushes)
paper-storage store --path . --name "author-year-topic" --year 2024 --file paper.pdf

# Retrieve
paper-storage retrieve --path . --name "author-year-topic" --retrieve text --save-at /tmp/out.txt

# List all papers
paper-storage list --path .
\`\`\`

Do not edit \`index.json\` or \`papers/\` manually.
`;
}

// ── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize a paper-storage repo at the given path.
 *
 * mode='create' — create a new local git repo, write the initial files,
 *   commit, then create a private GitHub repo via `gh` and push.
 *   This is the first-time setup on the first machine.
 *
 * mode='clone' — clone an existing GitHub repo to repoPath.
 *   Use this on a second machine where the repo already exists on GitHub.
 *   opts.cloneUrl is required in this mode.
 *
 * In both modes, if .git already exists at repoPath the function returns
 * early with alreadyExists: true.
 *
 * Accepts injectable functions so tests can run without real git / gh / fs.
 */
export function initPaperStorageRepo(
  repoPath: string,
  mode: 'create' | 'clone',
  opts?: {
    cloneUrl?: string;
    repoName?: string;       // GitHub repo name for --create (default: paper-storage)
    existsFn?: (p: string) => boolean;
    mkdirFn?: (p: string) => void;
    writeFileFn?: (p: string, content: string) => void;
    spawnFn?: InitSpawnFn;
  },
): InitRepoResult {
  const exists = opts?.existsFn ?? existsSync;
  const mkdir  = opts?.mkdirFn  ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const write  = opts?.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c, 'utf-8'));
  const spawn  = opts?.spawnFn  ?? defaultInitSpawn;

  const gitDir = join(repoPath, '.git');
  if (exists(gitDir)) {
    return { path: repoPath, alreadyExists: true, githubRepoCreated: false };
  }

  // ── Clone mode ────────────────────────────────────────────────────────────
  if (mode === 'clone') {
    const cloneUrl = opts?.cloneUrl?.trim();
    if (!cloneUrl) throw new Error('--clone requires a URL.');

    const cloneResult = spawn('git', ['clone', cloneUrl, repoPath]);
    if ((cloneResult.status ?? 1) !== 0) {
      throw new Error(`git clone failed: ${cloneResult.stderr || cloneResult.stdout}`);
    }
    return { path: repoPath, alreadyExists: false, githubRepoCreated: false };
  }

  // ── Create mode ───────────────────────────────────────────────────────────
  mkdir(repoPath);

  const initResult = spawn('git', ['init', repoPath]);
  if ((initResult.status ?? 1) !== 0) {
    throw new Error(`git init failed: ${initResult.stderr || initResult.stdout}`);
  }

  write(join(repoPath, 'index.json'), INDEX_JSON_INITIAL);
  write(join(repoPath, '.gitignore'), GITIGNORE_CONTENT);
  write(join(repoPath, 'README.md'), buildReadme());

  const addResult = spawn('git', ['add', '-A'], { cwd: repoPath });
  if ((addResult.status ?? 1) !== 0) {
    throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
  }

  const commitResult = spawn('git', ['commit', '-m', 'init: paper storage'], { cwd: repoPath });
  if ((commitResult.status ?? 1) !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
  }

  const ghRepoName = opts?.repoName?.trim() || 'paper-storage';
  const ghResult = spawn('gh', ['repo', 'create', ghRepoName, '--private', '--source', repoPath, '--push']);
  if ((ghResult.status ?? 1) !== 0) {
    throw new Error(`gh repo create failed: ${ghResult.stderr || ghResult.stdout}`);
  }

  return { path: repoPath, alreadyExists: false, githubRepoCreated: true };
}
