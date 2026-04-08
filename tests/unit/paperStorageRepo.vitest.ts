import { describe, it, expect } from 'vitest';
import { type PaperIndex, type PaperIndexEntry, type GitSpawnFn, EMPTY_INDEX, addEntry, commitAndPush, lookupByDoi, lookupByName, lookupByUuid, prepareRepo, pullRepo, readIndex, removeEntry, resolveUuid, updateEntry, writeIndex } from '../../src/lib/paperStorageRepo';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(overrides: Partial<PaperIndexEntry> = {}): PaperIndexEntry {
  return {
    uuid: 'aaaa-1111',
    name: 'smith-2024-paper',
    year: 2024,
    storedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function indexWith(...entries: PaperIndexEntry[]): PaperIndex {
  return entries.reduce((idx, e) => addEntry(idx, e), structuredClone(EMPTY_INDEX));
}

function makeCommitAndPushSuccessSpawn(calls: string[][]): GitSpawnFn {
  return (_cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: 'ok', stderr: '' };
  };
}

function makeRetryingPushSpawn(calls: string[][], state: { pushAttempts: number }): GitSpawnFn {
  return (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'push') {
      state.pushAttempts++;
      if (state.pushAttempts === 1) return { status: 1, stdout: '', stderr: 'rejected' };
      return { status: 0, stdout: 'ok', stderr: '' };
    }

    return { status: 0, stdout: 'ok', stderr: '' };
  };
}

function addFailureSpawn(_cmd: string, args: string[]): ReturnType<GitSpawnFn> {
  if (args[0] === 'add') return { status: 1, stdout: '', stderr: 'add error' };
  return { status: 0, stdout: '', stderr: '' };
}

function commitFailureSpawn(_cmd: string, args: string[]): ReturnType<GitSpawnFn> {
  if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'nothing to commit' };
  return { status: 0, stdout: '', stderr: '' };
}

function pushFailureSpawn(_cmd: string, args: string[]): ReturnType<GitSpawnFn> {
  if (args[0] === 'push') return { status: 1, stdout: '', stderr: 'rejected' };
  return { status: 0, stdout: '', stderr: '' };
}

function pullFailureSpawn(_cmd: string, args: string[]): ReturnType<GitSpawnFn> {
  if (args[0] === 'pull') return { status: 1, stdout: '', stderr: 'conflict' };
  return { status: 0, stdout: '', stderr: '' };
}

function noUpstreamThenSetUpstreamSuccessSpawn(calls: string[][]): GitSpawnFn {
  return (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'push' && args[1] !== '--set-upstream') {
      return { status: 1, stdout: '', stderr: 'fatal: The current branch main has no upstream branch.' };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'main\n', stderr: '' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
}

function noUpstreamAndBranchResolveFailsSpawn(_cmd: string, args: string[]): ReturnType<GitSpawnFn> {
  if (args[0] === 'push' && args[1] !== '--set-upstream') {
    return { status: 1, stdout: '', stderr: 'fatal: The current branch main has no upstream branch.' };
  }
  if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: 'not a git repo' };
  return { status: 0, stdout: '', stderr: '' };
}

// ── readIndex / writeIndex (use real fs via tmp dir) ─────────────────────────

import { mkdtempSync, rmSync, existsSync , writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('readIndex', () => {
  it('returns EMPTY_INDEX when index.json does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-test-'));
    try {
      const result = readIndex(dir);
      expect(result).toEqual(EMPTY_INDEX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a valid index.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-test-'));
    try {
      const index: PaperIndex = {
        byUuid: { 'u1': { name: 'alpha', year: 2020, storedAt: 'T' } },
        byDoi: { '10.0/x': 'u1' },
        byName: { alpha: 'u1' },
      };
      writeFileSync(join(dir, 'index.json'), JSON.stringify(index), 'utf-8');
      expect(readIndex(dir)).toEqual(index);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns EMPTY_INDEX on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-test-'));
    try {
      writeFileSync(join(dir, 'index.json'), '{broken', 'utf-8');
      expect(readIndex(dir)).toEqual(EMPTY_INDEX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeIndex', () => {
  it('writes and re-reads correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-test-'));
    try {
      const index = indexWith(entry());
      writeIndex(dir, index);
      expect(existsSync(join(dir, 'index.json'))).toBe(true);
      expect(readIndex(dir)).toEqual(index);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Lookups ──────────────────────────────────────────────────────────────────

describe('lookupByUuid', () => {
  it('returns entry when UUID exists', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }));
    const result = lookupByUuid(idx, 'u1');
    expect(result).not.toBeNull();
    expect(result?.uuid).toBe('u1');
    expect(result?.name).toBe('alpha');
    expect(result?.doi).toBe('10.0/a');
  });

  it('returns null when UUID does not exist', () => {
    expect(lookupByUuid(structuredClone(EMPTY_INDEX), 'missing')).toBeNull();
  });
});

describe('lookupByDoi', () => {
  it('returns UUID when DOI exists', () => {
    const idx = indexWith(entry({ uuid: 'u2', doi: '10.0/b' }));
    expect(lookupByDoi(idx, '10.0/b')).toBe('u2');
  });

  it('returns null when DOI not found', () => {
    expect(lookupByDoi(structuredClone(EMPTY_INDEX), '10.0/missing')).toBeNull();
  });
});

describe('lookupByName', () => {
  it('returns UUID when name exists', () => {
    const idx = indexWith(entry({ uuid: 'u3', name: 'jones-1999' }));
    expect(lookupByName(idx, 'jones-1999')).toBe('u3');
  });

  it('returns null when name not found', () => {
    expect(lookupByName(structuredClone(EMPTY_INDEX), 'nobody')).toBeNull();
  });
});

describe('resolveUuid', () => {
  const idx = indexWith(
    entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }),
    entry({ uuid: 'u2', name: 'beta' }),
  );

  it('resolves by uuid first', () => {
    expect(resolveUuid(idx, { uuid: 'u1', doi: '10.0/a', name: 'alpha' })).toBe('u1');
  });

  it('resolves by doi when no uuid', () => {
    expect(resolveUuid(idx, { doi: '10.0/a', name: 'alpha' })).toBe('u1');
  });

  it('resolves by name when no uuid or doi', () => {
    expect(resolveUuid(idx, { name: 'beta' })).toBe('u2');
  });

  it('returns null when uuid not in index', () => {
    expect(resolveUuid(idx, { uuid: 'nonexistent' })).toBeNull();
  });

  it('returns null when nothing provided', () => {
    expect(resolveUuid(idx, {})).toBeNull();
  });
});

// ── addEntry ─────────────────────────────────────────────────────────────────

describe('addEntry', () => {
  it('adds an entry with doi', () => {
    const idx = addEntry(structuredClone(EMPTY_INDEX), entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }));
    expect(idx.byUuid.u1).toMatchObject({ name: 'alpha', doi: '10.0/a', year: 2024 });
    expect(idx.byName.alpha).toBe('u1');
    expect(idx.byDoi['10.0/a']).toBe('u1');
  });

  it('adds an entry without doi', () => {
    const idx = addEntry(structuredClone(EMPTY_INDEX), entry({ uuid: 'u2', name: 'nodoi', doi: undefined }));
    expect(idx.byUuid.u2).toMatchObject({ name: 'nodoi' });
    expect(idx.byName.nodoi).toBe('u2');
    expect(Object.keys(idx.byDoi)).toHaveLength(0);
  });

  it('throws on name collision', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha' }));
    expect(() => addEntry(idx, entry({ uuid: 'u2', name: 'alpha' }))).toThrow(
      "Name 'alpha' already stored (uuid=u1). Use --force.",
    );
  });

  it('throws on doi collision', () => {
    const idx = indexWith(entry({ uuid: 'u1', doi: '10.0/a' }));
    expect(() => addEntry(idx, entry({ uuid: 'u2', name: 'beta', doi: '10.0/a' }))).toThrow(
      "DOI '10.0/a' already stored (uuid=u1). Use --force.",
    );
  });

  it('does not mutate the original index', () => {
    const original = structuredClone(EMPTY_INDEX);
    addEntry(original, entry());
    expect(original).toEqual(EMPTY_INDEX);
  });
});

// ── updateEntry ──────────────────────────────────────────────────────────────

describe('updateEntry', () => {
  it('renames: rekeys byName, keeps uuid', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha' }));
    const updated = updateEntry(idx, 'u1', { name: 'alpha-v2' });
    expect(updated.byName.alpha).toBeUndefined();
    expect(updated.byName['alpha-v2']).toBe('u1');
    expect(updated.byUuid.u1.name).toBe('alpha-v2');
  });

  it('updates doi: rekeys byDoi', () => {
    const idx = indexWith(entry({ uuid: 'u1', doi: '10.0/old' }));
    const updated = updateEntry(idx, 'u1', { doi: '10.0/new' });
    expect(updated.byDoi['10.0/old']).toBeUndefined();
    expect(updated.byDoi['10.0/new']).toBe('u1');
  });

  it('removes doi when doi is null', () => {
    const idx = indexWith(entry({ uuid: 'u1', doi: '10.0/a' }));
    const updated = updateEntry(idx, 'u1', { doi: null });
    expect(updated.byDoi['10.0/a']).toBeUndefined();
    expect(updated.byUuid.u1.doi).toBeUndefined();
  });

  it('updates year', () => {
    const idx = indexWith(entry({ uuid: 'u1', year: 2020 }));
    const updated = updateEntry(idx, 'u1', { year: 2025 });
    expect(updated.byUuid.u1.year).toBe(2025);
  });

  it('throws when uuid not found', () => {
    expect(() => updateEntry(structuredClone(EMPTY_INDEX), 'ghost', { name: 'x' })).toThrow(
      'Paper not found: uuid=ghost',
    );
  });

  it('throws on new-name collision with a different entry', () => {
    const idx = indexWith(
      entry({ uuid: 'u1', name: 'alpha' }),
      entry({ uuid: 'u2', name: 'beta' }),
    );
    expect(() => updateEntry(idx, 'u1', { name: 'beta' })).toThrow(
      "Name 'beta' already taken by uuid=u2",
    );
  });

  it('allows same name (no-op rename)', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha' }));
    const updated = updateEntry(idx, 'u1', { name: 'alpha' });
    expect(updated.byName.alpha).toBe('u1');
  });

  it('throws on new-doi collision with a different entry', () => {
    const idx = indexWith(
      entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }),
      entry({ uuid: 'u2', name: 'beta',  doi: '10.0/b' }),
    );
    expect(() => updateEntry(idx, 'u1', { doi: '10.0/b' })).toThrow(
      "DOI '10.0/b' already taken by uuid=u2",
    );
  });

  it('allows setting the same doi (no-op doi update)', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }));
    const updated = updateEntry(idx, 'u1', { doi: '10.0/a' });
    expect(updated.byDoi['10.0/a']).toBe('u1');
  });
});

// ── removeEntry ──────────────────────────────────────────────────────────────

describe('removeEntry', () => {
  it('removes entry with doi from all three indices', () => {
    const idx = indexWith(entry({ uuid: 'u1', name: 'alpha', doi: '10.0/a' }));
    const result = removeEntry(idx, 'u1');
    expect(result.byUuid.u1).toBeUndefined();
    expect(result.byName.alpha).toBeUndefined();
    expect(result.byDoi['10.0/a']).toBeUndefined();
  });

  it('removes entry without doi', () => {
    const idx = indexWith(entry({ uuid: 'u2', name: 'nodoi', doi: undefined }));
    const result = removeEntry(idx, 'u2');
    expect(result.byUuid.u2).toBeUndefined();
    expect(result.byName.nodoi).toBeUndefined();
  });

  it('is a no-op when uuid not found', () => {
    const idx = indexWith(entry());
    const result = removeEntry(idx, 'nonexistent');
    expect(result).toEqual(idx);
  });

  it('does not affect other entries', () => {
    const idx = indexWith(
      entry({ uuid: 'u1', name: 'alpha' }),
      entry({ uuid: 'u2', name: 'beta' }),
    );
    const result = removeEntry(idx, 'u1');
    expect(result.byUuid.u2).toBeDefined();
    expect(result.byName.beta).toBe('u2');
  });
});

// ── prepareRepo / pullRepo ────────────────────────────────────────────────────

describe('prepareRepo (pullRepo alias)', () => {
  it('runs reset → clean → pull in order', () => {
    const calls: string[][] = [];
    const spawnFn: GitSpawnFn = (_cmd, args) => {
      calls.push([...args]);
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    const result = prepareRepo('/repo/path', { spawnFn });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['reset', '--hard', 'HEAD']);
    expect(calls[1]).toEqual(['clean', '-fd']);
    expect(calls[2]).toEqual(['pull', '--rebase']);
  });

  it('uses the given repoDir as cwd for all three calls', () => {
    const cwds: string[] = [];
    const spawnFn: GitSpawnFn = (_cmd, _args, opts) => {
      cwds.push(opts.cwd);
      return { status: 0, stdout: '', stderr: '' };
    };

    prepareRepo('/my/repo', { spawnFn });

    expect(cwds).toEqual(['/my/repo', '/my/repo', '/my/repo']);
  });

  it('swallows reset failure and continues to clean and pull', () => {
    const calls: string[][] = [];
    const spawnFn: GitSpawnFn = (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === 'reset') return { status: 128, stdout: '', stderr: 'fatal: no HEAD' };
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    const result = prepareRepo('/repo', { spawnFn });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(['pull', '--rebase']);
  });

  it('swallows clean failure and continues to pull', () => {
    const calls: string[][] = [];
    const spawnFn: GitSpawnFn = (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === 'clean') return { status: 1, stdout: '', stderr: 'clean error' };
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    const result = prepareRepo('/repo', { spawnFn });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('propagates pull failure (returns ok=false)', () => {
    const result = prepareRepo('/repo', { spawnFn: pullFailureSpawn });

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('conflict');
  });

  it('pullRepo is an alias for prepareRepo', () => {
    expect(pullRepo).toBe(prepareRepo);
  });
});

// ── commitAndPush ────────────────────────────────────────────────────────────

describe('commitAndPush', () => {
  it('calls add, commit, push in sequence on success', () => {
    const calls: string[][] = [];
    const spawnFn = makeCommitAndPushSuccessSpawn(calls);

    const result = commitAndPush('/repo', 'store: paper', { spawnFn });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(['-A', 'add', '-A'].includes(calls[0][0]) ? calls[0] : ['add', '-A']);
    expect(calls[0]).toEqual(['add', '-A']);
    expect(calls[1]).toEqual(['commit', '-m', 'store: paper']);
    expect(calls[2]).toEqual(['push']);
  });

  it('retries push once after pull --rebase on conflict', () => {
    const calls: string[][] = [];
    const state = { pushAttempts: 0 };
    const spawnFn = makeRetryingPushSpawn(calls, state);

    const result = commitAndPush('/repo', 'msg', { spawnFn });

    expect(result.ok).toBe(true);
    expect(state.pushAttempts).toBe(2);
    const cmds = calls.map((a) => a[0]);
    expect(cmds).toContain('pull');
  });

  it('sets upstream and pushes when branch has no upstream configured', () => {
    const calls: string[][] = [];
    const spawnFn = noUpstreamThenSetUpstreamSuccessSpawn(calls);

    const result = commitAndPush('/repo', 'msg', { spawnFn });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(['add', '-A']);
    expect(calls[1]).toEqual(['commit', '-m', 'msg']);
    expect(calls[2]).toEqual(['push']);
    expect(calls[3]).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(calls[4]).toEqual(['push', '--set-upstream', 'origin', 'main']);
  });

  it('throws when add fails', () => {
    expect(() => commitAndPush('/repo', 'msg', { spawnFn: addFailureSpawn })).toThrow('git add failed');
  });

  it('throws when commit fails', () => {
    expect(() => commitAndPush('/repo', 'msg', { spawnFn: commitFailureSpawn })).toThrow('git commit failed');
  });

  it('throws after 3 failed push attempts', () => {
    expect(() => commitAndPush('/repo', 'msg', { spawnFn: pushFailureSpawn })).toThrow(
      'git push failed after 3 attempts',
    );
  });

  it('throws when upstream push fallback cannot resolve current branch', () => {
    expect(() => commitAndPush('/repo', 'msg', { spawnFn: noUpstreamAndBranchResolveFailsSpawn })).toThrow(
      'git rev-parse --abbrev-ref HEAD failed',
    );
  });
});
