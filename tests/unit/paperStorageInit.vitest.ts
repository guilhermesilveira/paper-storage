import { describe, it, expect } from 'vitest';
import { checkRequiredTools, initPaperStorageRepo, type CheckSpawnFn } from '../../src/lib/paperStorageInit';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a CheckSpawnFn that succeeds for a set of known commands. */
function makeCheckSpawn(found: Record<string, string>): CheckSpawnFn {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (Object.prototype.hasOwnProperty.call(found, key)) {
      return { status: 0, stdout: found[key], stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `command not found: ${cmd}` };
  };
}

const ALL_TOOLS_SPAWN: CheckSpawnFn = makeCheckSpawn({
  'git --version': 'git version 2.45.0\n',
  'gh --version': 'gh version 2.86.0 (2026-01-21)\n',
  'python3 --version': 'Python 3.12.0\n',
  'python3 -c import fitz; print(fitz.VersionBind)': '1.27.1\n',
  'tesseract --version': 'tesseract 5.5.2\n',
});

function missingGitSpawn(cmd: string, args: string[]): ReturnType<CheckSpawnFn> {
  if (cmd === 'git') return { status: 1, stdout: '', stderr: 'not found' };
  return ALL_TOOLS_SPAWN(cmd, args);
}

function missingPyMuPdfSpawn(cmd: string, args: string[]): ReturnType<CheckSpawnFn> {
  if (cmd === 'python3' && args.some((a) => a.includes('import fitz'))) {
    return { status: 1, stdout: '', stderr: 'ModuleNotFoundError' };
  }

  return ALL_TOOLS_SPAWN(cmd, args);
}

function missingAllToolsSpawn(): ReturnType<CheckSpawnFn> {
  return { status: 1, stdout: '', stderr: 'not found' };
}

function missingTesseractSpawn(cmd: string, args: string[]): ReturnType<CheckSpawnFn> {
  if (cmd === 'tesseract') return { status: 127, stdout: '', stderr: '' };
  return ALL_TOOLS_SPAWN(cmd, args);
}

// ── checkRequiredTools ───────────────────────────────────────────────────────

describe('checkRequiredTools', () => {
  it('returns ok=true when all tools are present', () => {
    const result = checkRequiredTools({ spawnFn: ALL_TOOLS_SPAWN });
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(5);
    expect(result.tools.every((t) => t.found)).toBe(true);
  });

  it('extracts versions correctly', () => {
    const result = checkRequiredTools({ spawnFn: ALL_TOOLS_SPAWN });
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    expect(byName.git.version).toBe('2.45.0');
    expect(byName.gh.version).toBe('2.86.0');
    expect(byName.python3.version).toBe('3.12.0');
    expect(byName.PyMuPDF.version).toBe('1.27.1');
    expect(byName.tesseract.version).toBe('5.5.2');
  });

  it('returns ok=false when git is missing', () => {
    const result = checkRequiredTools({ spawnFn: missingGitSpawn });
    expect(result.ok).toBe(false);
    const git = result.tools.find((t) => t.name === 'git');
    expect(git?.found).toBe(false);
    expect(git?.version).toBeUndefined();
  });

  it('returns ok=false when PyMuPDF is missing', () => {
    const result = checkRequiredTools({ spawnFn: missingPyMuPdfSpawn });
    expect(result.ok).toBe(false);
    const pymupdf = result.tools.find((t) => t.name === 'PyMuPDF');
    expect(pymupdf?.found).toBe(false);
  });

  it('returns ok=false when multiple tools are missing', () => {
    const result = checkRequiredTools({ spawnFn: missingAllToolsSpawn });
    expect(result.ok).toBe(false);
    expect(result.tools.filter((t) => t.found)).toHaveLength(0);
  });

  it('includes install hints for every tool', () => {
    const result = checkRequiredTools({ spawnFn: ALL_TOOLS_SPAWN });
    for (const tool of result.tools) {
      expect(tool.installHint).toBeTruthy();
    }
  });

  it('returns ok=false (not throws) when tesseract is missing', () => {
    expect(() => checkRequiredTools({ spawnFn: missingTesseractSpawn })).not.toThrow();
    expect(checkRequiredTools({ spawnFn: missingTesseractSpawn }).ok).toBe(false);
  });
});

// ── initPaperStorageRepo — mode='create' ─────────────────────────────────────

describe("initPaperStorageRepo mode='create'", () => {
  it('returns alreadyExists=true when .git already present', () => {
    const result = initPaperStorageRepo('/existing/repo', 'create', {
      existsFn: (p) => p.endsWith('.git'),
      mkdirFn: () => { throw new Error('should not mkdir'); },
      writeFileFn: () => { throw new Error('should not write'); },
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    expect(result.alreadyExists).toBe(true);
    expect(result.githubRepoCreated).toBe(false);
    expect(result.path).toBe('/existing/repo');
  });

  it('creates repo when .git does not exist', () => {
    const result = initPaperStorageRepo('/new/repo', 'create', {
      existsFn: () => false,
      mkdirFn: () => undefined,
      writeFileFn: () => undefined,
      spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(result.alreadyExists).toBe(false);
    expect(result.githubRepoCreated).toBe(true);
    expect(result.path).toBe('/new/repo');
  });

  it('writes index.json with empty indices', () => {
    const written: Record<string, string> = {};
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined,
      writeFileFn: (p, c) => { written[p] = c; },
      spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const indexPath = Object.keys(written).find((p) => p.endsWith('index.json'));
    expect(indexPath).toBeTruthy();
    expect(JSON.parse(written[indexPath!])).toEqual({ byUuid: {}, byDoi: {}, byName: {} });
  });

  it('writes .gitignore', () => {
    const written: Record<string, string> = {};
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined,
      writeFileFn: (p, c) => { written[p] = c; },
      spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const path = Object.keys(written).find((p) => p.endsWith('.gitignore'));
    expect(path).toBeTruthy();
    expect(written[path!]).toContain('*.tmp');
  });

  it('writes README.md', () => {
    const written: Record<string, string> = {};
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined,
      writeFileFn: (p, c) => { written[p] = c; },
      spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const path = Object.keys(written).find((p) => p.endsWith('README.md'));
    expect(path).toBeTruthy();
    expect(written[path!]).toContain('# paper-storage');
  });

  it('calls git init, git add, git commit, gh repo create in order', () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined, writeFileFn: () => undefined,
      spawnFn: (cmd, args) => { spawned.push({ cmd, args: [...args] }); return { status: 0, stdout: '', stderr: '' }; },
    });
    const cmds = spawned.map((s) => `${s.cmd} ${s.args[0]}`);
    expect(cmds).toContain('git init');
    expect(cmds).toContain('git add');
    expect(cmds).toContain('git commit');
    expect(cmds).toContain('gh repo');
    expect(cmds.indexOf('git init')).toBeLessThan(cmds.indexOf('git add'));
    expect(cmds.indexOf('git add')).toBeLessThan(cmds.indexOf('git commit'));
    expect(cmds.indexOf('git commit')).toBeLessThan(cmds.indexOf('gh repo'));
  });

  it('uses default repo name paper-storage when no repoName given', () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined, writeFileFn: () => undefined,
      spawnFn: (cmd, args) => { spawned.push({ cmd, args: [...args] }); return { status: 0, stdout: '', stderr: '' }; },
    });
    const ghCall = spawned.find((s) => s.cmd === 'gh');
    expect(ghCall?.args[2]).toBe('paper-storage');
  });

  it('uses custom repo name when repoName option is given', () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined, writeFileFn: () => undefined,
      repoName: 'research-papers',
      spawnFn: (cmd, args) => { spawned.push({ cmd, args: [...args] }); return { status: 0, stdout: '', stderr: '' }; },
    });
    const ghCall = spawned.find((s) => s.cmd === 'gh');
    expect(ghCall?.args[2]).toBe('research-papers');
  });

  it('throws when git init fails', () => {
    expect(() => initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined, writeFileFn: () => undefined,
      spawnFn: (cmd, args) => {
        if (cmd === 'git' && args[0] === 'init') return { status: 128, stdout: '', stderr: 'permission denied' };
        return { status: 0, stdout: '', stderr: '' };
      },
    })).toThrow('git init failed');
  });

  it('throws when gh repo create fails', () => {
    expect(() => initPaperStorageRepo('/repo', 'create', {
      existsFn: () => false, mkdirFn: () => undefined, writeFileFn: () => undefined,
      spawnFn: (cmd) => {
        if (cmd === 'gh') return { status: 1, stdout: '', stderr: 'gh auth error' };
        return { status: 0, stdout: '', stderr: '' };
      },
    })).toThrow('gh repo create failed');
  });
});

// ── initPaperStorageRepo — mode='clone' ───────────────────────────────────────

describe("initPaperStorageRepo mode='clone'", () => {
  const CLONE_URL = 'https://github.com/user/paper-storage.git';

  it('throws when cloneUrl is missing', () => {
    expect(() => initPaperStorageRepo('/repo', 'clone', {
      existsFn: () => false,
      spawnFn: () => { throw new Error('should not spawn'); },
    })).toThrow('--clone requires a URL.');
  });

  it('throws when cloneUrl is empty string', () => {
    expect(() => initPaperStorageRepo('/repo', 'clone', {
      existsFn: () => false,
      cloneUrl: '   ',
      spawnFn: () => { throw new Error('should not spawn'); },
    })).toThrow('--clone requires a URL.');
  });

  it('calls git clone with the URL and repoPath', () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    initPaperStorageRepo('/new/repo', 'clone', {
      existsFn: () => false,
      cloneUrl: CLONE_URL,
      spawnFn: (cmd, args) => { spawned.push({ cmd, args: [...args] }); return { status: 0, stdout: '', stderr: '' }; },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('git');
    expect(spawned[0].args).toEqual(['clone', CLONE_URL, '/new/repo']);
  });

  it('does NOT call gh or write any files', () => {
    const written: string[] = [];
    const spawned: string[] = [];
    initPaperStorageRepo('/new/repo', 'clone', {
      existsFn: () => false,
      cloneUrl: CLONE_URL,
      writeFileFn: (p) => { written.push(p); },
      spawnFn: (cmd, _args) => { spawned.push(cmd); return { status: 0, stdout: '', stderr: '' }; },
    });
    expect(spawned).not.toContain('gh');
    expect(written).toHaveLength(0);
  });

  it('returns alreadyExists=false, githubRepoCreated=false on success', () => {
    const result = initPaperStorageRepo('/new/repo', 'clone', {
      existsFn: () => false,
      cloneUrl: CLONE_URL,
      spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    expect(result.path).toBe('/new/repo');
    expect(result.alreadyExists).toBe(false);
    expect(result.githubRepoCreated).toBe(false);
  });

  it('returns alreadyExists=true when .git already present', () => {
    const result = initPaperStorageRepo('/existing/repo', 'clone', {
      existsFn: (p) => p.endsWith('.git'),
      cloneUrl: CLONE_URL,
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    expect(result.alreadyExists).toBe(true);
  });

  it('throws when git clone fails', () => {
    expect(() => initPaperStorageRepo('/repo', 'clone', {
      existsFn: () => false,
      cloneUrl: CLONE_URL,
      spawnFn: () => ({ status: 128, stdout: '', stderr: 'repository not found' }),
    })).toThrow('git clone failed');
  });
});
