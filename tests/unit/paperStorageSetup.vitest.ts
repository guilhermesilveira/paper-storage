import { describe, it, expect } from 'vitest';
import { defaultPaperStorageHome, defaultPaperStorageRepoDir, resolvePaperStorageRepoDir, setupPaperStorage, findCompatiblePython, paperStorageVenvBin, type SetupSpawnFn, type SetupDeps } from '../../src/lib/paperStorageSetup';

const PYTHON_OK: SetupSpawnFn = (cmd, args) => {
  const key = `${cmd} ${args[0] ?? ''}`.trim();
  if (key === 'python3 --version') return { status: 0, stdout: 'Python 3.12.0\n', stderr: '' };
  if (key === 'python3 -c') return { status: 0, stdout: '', stderr: '' }; // lzma check
  return { status: 1, stdout: '', stderr: '' };
};

// ── findCompatiblePython ──────────────────────────────────────────────────────

describe('findCompatiblePython', () => {
  it('returns python3 when >= 3.10 and has lzma', () => {
    const result = findCompatiblePython(PYTHON_OK);
    expect(result).not.toBeNull();
    expect(result!.bin).toBe('python3');
    expect(result!.version).toBe('3.12');
  });

  it('returns null when python3 is too old', () => {
    const result = findCompatiblePython((cmd, args) => {
      if (args[0] === '--version') return { status: 0, stdout: 'Python 3.8.10\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(result).toBeNull();
  });

  it('returns null when no python3 found', () => {
    const result = findCompatiblePython(() => ({ status: 1, stdout: '', stderr: 'not found' }));
    expect(result).toBeNull();
  });

  it('skips python3 without lzma and tries python3.12', () => {
    const result = findCompatiblePython((cmd, args) => {
      // python3 has no lzma
      if (cmd === 'python3' && args[0] === '--version') return { status: 0, stdout: 'Python 3.13.5\n', stderr: '' };
      if (cmd === 'python3' && args[0] === '-c') return { status: 1, stdout: '', stderr: 'no lzma' };
      // python3.12 works
      if (cmd === 'python3.12' && args[0] === '--version') return { status: 0, stdout: 'Python 3.12.4\n', stderr: '' };
      if (cmd === 'python3.12' && args[0] === '-c') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(result).not.toBeNull();
    expect(result!.bin).toBe('python3.12');
  });
});

// ── paperStorageVenvBin ───────────────────────────────────────────────────────

describe('paperStorageVenvBin', () => {
  it('returns path when exists', () => {
    const result = paperStorageVenvBin('marker_single', () => true);
    expect(result).toContain('marker_single');
    expect(result).toContain('venv/bin');
  });

  it('returns null when not exists', () => {
    expect(paperStorageVenvBin('marker_single', () => false)).toBeNull();
  });
});

describe('default path helpers', () => {
  it('uses ~/.local/paper-storage as the default managed home', () => {
    expect(defaultPaperStorageHome()).toContain('.local/paper-storage');
  });

  it('uses research-papers as the default repo dir under the managed home', () => {
    expect(defaultPaperStorageRepoDir()).toContain('.local/paper-storage/research-papers');
  });

  it('prefers explicit repo path over env/default', () => {
    expect(resolvePaperStorageRepoDir('/tmp/custom-repo')).toBe('/tmp/custom-repo');
  });
});

// ── setupPaperStorage ─────────────────────────────────────────────────────────

function makeSetupDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    existsSyncFn: (p) => p.includes('venv/bin'), // venv exists
    mkdirSyncFn:  () => undefined,
    spawnFn: (cmd, args) => {
      const key = `${cmd} ${args[0] ?? ''}`.trim();
      // Python
      if (key === 'python3 --version') return { status: 0, stdout: 'Python 3.12.0\n', stderr: '' };
      if (cmd === 'python3' && args[0] === '-c') return { status: 0, stdout: '', stderr: '' };
      // venv creation
      if (cmd === 'python3' && args[0] === '-m') return { status: 0, stdout: '', stderr: '' };
      // pip install
      if (cmd.includes('pip')) return { status: 0, stdout: '', stderr: '' };
      // Verification
      if (cmd.includes('venv') && args[0] === '-c') return { status: 0, stdout: '1.27.1', stderr: '' };
      // System tools
      if (key === 'git --version') return { status: 0, stdout: 'git version 2.52.0', stderr: '' };
      if (key === 'gh --version') return { status: 0, stdout: 'gh version 2.86.0', stderr: '' };
      if (key === 'tesseract --version') return { status: 0, stdout: 'tesseract 5.5.2', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  };
}

describe('setupPaperStorage', () => {
  it('returns ok=true when everything succeeds', () => {
    const result = setupPaperStorage(makeSetupDeps());
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.status !== 'failed')).toBe(true);
  });

  it('creates home dir when it does not exist', () => {
    const dirs: string[] = [];
    setupPaperStorage(makeSetupDeps({
      existsSyncFn: () => false,
      mkdirSyncFn: (p) => { dirs.push(p); },
    }));
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs[0]).toContain('paper-storage');
    expect(dirs[0]).toContain('.local');
  });

  it('returns ok=false when no compatible python found', () => {
    const result = setupPaperStorage(makeSetupDeps({
      spawnFn: () => ({ status: 1, stdout: '', stderr: 'not found' }),
    }));
    expect(result.ok).toBe(false);
    const pyStep = result.steps.find((s) => s.name === 'python');
    expect(pyStep?.status).toBe('failed');
  });

  it('returns ok=false when pip install fails', () => {
    const result = setupPaperStorage(makeSetupDeps({
      spawnFn: (cmd, args) => {
        if (cmd.includes('pip')) return { status: 1, stdout: '', stderr: 'pip error' };
        // rest OK
        if (args[0] === '--version' || args[0] === '-c' || args[0] === '-m') {
          return { status: 0, stdout: 'Python 3.12.0\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    }));
    expect(result.ok).toBe(false);
    const pipStep = result.steps.find((s) => s.name === 'pip-install');
    expect(pipStep?.status).toBe('failed');
  });

  it('reports system tool status', () => {
    const result = setupPaperStorage(makeSetupDeps());
    const gitStep = result.steps.find((s) => s.name === 'git');
    expect(gitStep?.status).toBe('ok');
    expect(gitStep?.detail).toContain('git version');
  });

  it('reports missing system tool as failed', () => {
    const result = setupPaperStorage(makeSetupDeps({
      spawnFn: (cmd, args) => {
        if (cmd === 'tesseract') return { status: 1, stdout: '', stderr: '' };
        return makeSetupDeps().spawnFn!(cmd, args, {});
      },
    }));
    const tessStep = result.steps.find((s) => s.name === 'tesseract');
    expect(tessStep?.status).toBe('failed');
  });
});
