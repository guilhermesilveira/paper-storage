import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCommandSync } from './processUtils';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PaperIndexEntry {
  uuid: string;
  name: string;
  doi?: string;
  year: number;
  storedAt: string;
}

/** What lives inside byUuid — the UUID is the map key, not stored inside. */
export type PaperIndexValue = Omit<PaperIndexEntry, 'uuid'>;

export interface PaperIndex {
  byUuid: Record<string, PaperIndexValue>;
  byDoi: Record<string, string>;   // doi → uuid
  byName: Record<string, string>;  // name → uuid
}

export interface UpdateEntryChanges {
  name?: string;
  doi?: string | null;   // null = remove doi
  year?: number;
}

// Injected spawn signature used by all git helpers (allows mocking in tests).
export type GitSpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

// ── Constants ────────────────────────────────────────────────────────────────

export const EMPTY_INDEX: PaperIndex = { byUuid: {}, byDoi: {}, byName: {} };

function hasOwnKey<TValue>(record: Record<string, TValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// ── Index read / write ───────────────────────────────────────────────────────

export function readIndex(repoDir: string): PaperIndex {
  const indexPath = join(repoDir, 'index.json');
  if (!existsSync(indexPath)) return structuredClone(EMPTY_INDEX);
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf-8')) as Partial<PaperIndex>;
    return {
      byUuid: raw.byUuid ?? {},
      byDoi: raw.byDoi ?? {},
      byName: raw.byName ?? {},
    };
  } catch {
    return structuredClone(EMPTY_INDEX);
  }
}

export function writeIndex(repoDir: string, index: PaperIndex): void {
  writeFileSync(join(repoDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf-8');
}

// ── Index lookups ────────────────────────────────────────────────────────────

export function lookupByUuid(index: PaperIndex, uuid: string): PaperIndexEntry | null {
  if (!hasOwnKey(index.byUuid, uuid)) return null;
  const value = index.byUuid[uuid];
  return { uuid, ...value };
}

/** Returns the UUID for the given DOI, or null if not found. */
export function lookupByDoi(index: PaperIndex, doi: string): string | null {
  return index.byDoi[doi] ?? null;
}

/** Returns the UUID for the given name, or null if not found. */
export function lookupByName(index: PaperIndex, name: string): string | null {
  return index.byName[name] ?? null;
}

/**
 * Resolve a UUID from whichever key is provided.
 * Priority: uuid > doi > name.
 * Returns null if nothing matches.
 */
export function resolveUuid(
  index: PaperIndex,
  keys: { uuid?: string; doi?: string; name?: string },
): string | null {
  if (keys.uuid) return hasOwnKey(index.byUuid, keys.uuid) ? keys.uuid : null;
  if (keys.doi) return lookupByDoi(index, keys.doi);
  if (keys.name) return lookupByName(index, keys.name);
  return null;
}

// ── Index mutations ──────────────────────────────────────────────────────────

/**
 * Add a new entry to the index.
 * Throws with a descriptive error when name or doi already exists.
 */
export function addEntry(index: PaperIndex, entry: PaperIndexEntry): PaperIndex {
  const existingByName = index.byName[entry.name];
  if (existingByName) {
    throw new Error(
      `Name '${entry.name}' already stored (uuid=${existingByName}). Use --force.`,
    );
  }
  if (entry.doi) {
    const existingByDoi = index.byDoi[entry.doi];
    if (existingByDoi) {
      throw new Error(
        `DOI '${entry.doi}' already stored (uuid=${existingByDoi}). Use --force.`,
      );
    }
  }

  const { uuid, ...value } = entry;
  const next: PaperIndex = {
    byUuid: { ...index.byUuid, [uuid]: value },
    byDoi: { ...index.byDoi },
    byName: { ...index.byName, [entry.name]: uuid },
  };
  if (entry.doi) next.byDoi[entry.doi] = uuid;
  return next;
}

/**
 * Update metadata for an existing entry.
 * Rekeys byName / byDoi when name or doi change.
 * Pass doi: null to remove the doi entirely.
 */
export function updateEntry(
  index: PaperIndex,
  uuid: string,
  changes: UpdateEntryChanges,
): PaperIndex {
  if (!hasOwnKey(index.byUuid, uuid)) throw new Error(`Paper not found: uuid=${uuid}`);
  const existing = index.byUuid[uuid];

  if (changes.name !== undefined && changes.name !== existing.name) {
    const collision = index.byName[changes.name];
    if (collision && collision !== uuid) {
      throw new Error(`Name '${changes.name}' already taken by uuid=${collision}`);
    }
  }
  if (changes.doi && changes.doi !== existing.doi) {
    const collision = index.byDoi[changes.doi];
    if (collision && collision !== uuid) {
      throw new Error(`DOI '${changes.doi}' already taken by uuid=${collision}`);
    }
  }

  const updated: PaperIndexValue = { ...existing };
  if (changes.name !== undefined) updated.name = changes.name;
  if (changes.year !== undefined) updated.year = changes.year;
  if (changes.doi === null) {
    delete updated.doi;
  } else if (changes.doi !== undefined) {
    updated.doi = changes.doi;
  }

  const newByName = { ...index.byName };
  if (changes.name !== undefined && changes.name !== existing.name) {
    delete newByName[existing.name];
    newByName[changes.name] = uuid;
  }

  const newByDoi = { ...index.byDoi };
  if (changes.doi !== undefined) {
    if (existing.doi) delete newByDoi[existing.doi];
    if (changes.doi !== null) newByDoi[changes.doi] = uuid;
  }

  return { byUuid: { ...index.byUuid, [uuid]: updated }, byDoi: newByDoi, byName: newByName };
}

/** Remove an entry from all three indices. No-op when UUID not found. */
export function removeEntry(index: PaperIndex, uuid: string): PaperIndex {
  if (!hasOwnKey(index.byUuid, uuid)) return index;
  const existing = index.byUuid[uuid];

  const newByUuid = { ...index.byUuid };
  delete newByUuid[uuid];

  const newByName = { ...index.byName };
  delete newByName[existing.name];

  const newByDoi = { ...index.byDoi };
  if (existing.doi) delete newByDoi[existing.doi];

  return { byUuid: newByUuid, byDoi: newByDoi, byName: newByName };
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function defaultGitSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnCommandSync(cmd, args, {
    cwd: opts.cwd,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function runGit(
  cwd: string,
  args: string[],
  spawnFn: GitSpawnFn,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnFn('git', args, { cwd });
  return {
    ok: (result.status ?? 1) === 0 && !result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function isNoUpstreamPushError(stderr: string): boolean {
  return /no upstream branch|set upstream/i.test(stderr);
}

function resolveCurrentBranch(repoDir: string, spawn: GitSpawnFn): string {
  const branchResult = runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'], spawn);
  if (!branchResult.ok) {
    throw new Error(`git rev-parse --abbrev-ref HEAD failed: ${branchResult.stderr}`);
  }
  const branch = branchResult.stdout.trim();
  if (!branch) throw new Error('Unable to resolve current git branch for push.');
  return branch;
}

export interface PullRepoResult { ok: boolean; stdout: string; stderr: string }

/**
 * Prepare a paper-storage repo for use:
 *   1. `git reset --hard HEAD`  — discard staged/unstaged changes to tracked files
 *   2. `git clean -fd`          — remove untracked files/dirs (partial writes from
 *                                  crashed store operations)
 *   3. `git pull --rebase`      — integrate latest from remote
 *
 * Steps 1 and 2 are non-fatal: a failure (e.g. fresh repo with no HEAD yet, or
 * a repo with no remote) is swallowed so the pull can still proceed.
 * Step 3 is propagated as usual.
 */
export function prepareRepo(repoDir: string, opts?: { spawnFn?: GitSpawnFn }): PullRepoResult {
  const spawn = opts?.spawnFn ?? defaultGitSpawn;
  // Non-fatal: discard any uncommitted tracked changes
  runGit(repoDir, ['reset', '--hard', 'HEAD'], spawn);
  // Non-fatal: remove untracked files and directories
  runGit(repoDir, ['clean', '-fd'], spawn);
  // Pull latest — propagate failure
  return runGit(repoDir, ['pull', '--rebase'], spawn);
}

/** Backward-compatible alias — all callers may keep using pullRepo. */
export const pullRepo = prepareRepo;

export interface CommitAndPushResult { ok: boolean; stdout: string; stderr: string }

/**
 * Stage all changes, commit, then push.
 * Retries up to 3 times on push conflict (pull --rebase between attempts).
 */
export function commitAndPush(
  repoDir: string,
  message: string,
  opts?: { spawnFn?: GitSpawnFn },
): CommitAndPushResult {
  const spawn = opts?.spawnFn ?? defaultGitSpawn;
  const MAX_PUSH_ATTEMPTS = 3;

  const add = runGit(repoDir, ['add', '-A'], spawn);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);

  const commit = runGit(repoDir, ['commit', '-m', message], spawn);
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const push = runGit(repoDir, ['push'], spawn);
    if (push.ok) return { ok: true, stdout: push.stdout, stderr: push.stderr };
    if (isNoUpstreamPushError(push.stderr)) {
      const branch = resolveCurrentBranch(repoDir, spawn);
      const pushSetUpstream = runGit(repoDir, ['push', '--set-upstream', 'origin', branch], spawn);
      if (pushSetUpstream.ok) {
        return { ok: true, stdout: pushSetUpstream.stdout, stderr: pushSetUpstream.stderr };
      }
      throw new Error(`git push --set-upstream origin ${branch} failed: ${pushSetUpstream.stderr}`);
    }
    if (attempt < MAX_PUSH_ATTEMPTS) {
      const pull = runGit(repoDir, ['pull', '--rebase'], spawn);
      if (!pull.ok) {
        throw new Error(`git pull --rebase failed on push retry ${attempt}: ${pull.stderr}`);
      }
    } else {
      throw new Error(`git push failed after ${MAX_PUSH_ATTEMPTS} attempts: ${push.stderr}`);
    }
  }

  // unreachable — satisfies TypeScript
  return { ok: false, stdout: '', stderr: '' };
}
