import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPdfIfNeeded, reassemblePdf, DEFAULT_SPLIT_THRESHOLD_BYTES, DEFAULT_PART_MAX_BYTES, type SplitSpawnFn } from '../../src/lib/paperStorageSplit';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a SplitSpawnFn that always returns a fixed stdout JSON. */
function makeSpawn(payload: Record<string, unknown>, exitCode = 0): SplitSpawnFn {
  return () => ({
    status: exitCode,
    stdout: JSON.stringify(payload),
    stderr: '',
  });
}

function malformedJsonSpawn(): ReturnType<SplitSpawnFn> {
  return { status: 0, stdout: 'not-json', stderr: '' };
}

function failedReassembleSpawn(): ReturnType<SplitSpawnFn> {
  return { status: 1, stdout: '', stderr: 'fitz error' };
}

/** Create a temp file of the given byte size. */
function makeTempFile(dir: string, name: string, bytes: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 0x25));   // fill with '%'
  return p;
}

// ── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_SPLIT_THRESHOLD_BYTES is 90MB', () => {
    expect(DEFAULT_SPLIT_THRESHOLD_BYTES).toBe(90 * 1024 * 1024);
  });

  it('DEFAULT_PART_MAX_BYTES is 80MB', () => {
    expect(DEFAULT_PART_MAX_BYTES).toBe(80 * 1024 * 1024);
  });
});

// ── splitPdfIfNeeded ─────────────────────────────────────────────────────────

describe('splitPdfIfNeeded', () => {
  it('returns split=false for a file at or below the threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'small.pdf', 1024);   // 1 KB
      const result = splitPdfIfNeeded({
        pdfPath,
        outputDir: join(dir, 'parts'),
        thresholdBytes: 2048,
        spawnFn: () => { throw new Error('should not spawn'); },
      });
      expect(result.split).toBe(false);
      expect(result.partCount).toBe(0);
      expect(result.partPaths).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns split=false for a file exactly at the threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'exact.pdf', 2048);
      const result = splitPdfIfNeeded({
        pdfPath,
        outputDir: join(dir, 'parts'),
        thresholdBytes: 2048,
        spawnFn: () => { throw new Error('should not spawn'); },
      });
      expect(result.split).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invokes python3 for a file above the threshold', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      const calls: { cmd: string; args: string[] }[] = [];
      const spawnFn: SplitSpawnFn = (cmd, args) => {
        calls.push({ cmd, args: [...args] });
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, partCount: 2, partPaths: ['/a/part-001.pdf', '/a/part-002.pdf'] }),
          stderr: '',
        };
      };

      splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, spawnFn });

      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('python3');
      // args[1] = pdfPath, args[2] = outputDir, args[3] = partMax
      expect(calls[0].args[1]).toBe(pdfPath);
      expect(calls[0].args[3]).toBe(String(DEFAULT_PART_MAX_BYTES));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes custom partMaxBytes to the script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      let capturedPartMax = '';
      const spawnFn: SplitSpawnFn = (_cmd, args) => {
        capturedPartMax = args[3] ?? '';
        return { status: 0, stdout: JSON.stringify({ ok: true, partCount: 1, partPaths: ['/a/part-001.pdf'] }), stderr: '' };
      };

      splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, partMaxBytes: 512, spawnFn });

      expect(capturedPartMax).toBe('512');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns correct partCount and partPaths from subprocess result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      const expectedParts = ['/repo/papers/uuid/parts/part-001.pdf', '/repo/papers/uuid/parts/part-002.pdf', '/repo/papers/uuid/parts/part-003.pdf'];
      const spawnFn = makeSpawn({ ok: true, partCount: 3, partPaths: expectedParts });

      const result = splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, spawnFn });

      expect(result.split).toBe(true);
      expect(result.partCount).toBe(3);
      expect(result.partPaths).toEqual(expectedParts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when subprocess exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      const spawnFn: SplitSpawnFn = () => ({ status: 1, stdout: '', stderr: 'fitz error' });

      expect(() =>
        splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, spawnFn }),
      ).toThrow('PDF split failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when subprocess returns ok=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      const spawnFn = makeSpawn({ ok: false, error: 'cannot open' });

      expect(() =>
        splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, spawnFn }),
      ).toThrow('PDF split failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when subprocess returns malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pss-test-'));
    try {
      const pdfPath = makeTempFile(dir, 'large.pdf', 3000);
      const spawnFn: SplitSpawnFn = () => ({ status: 0, stdout: '{broken', stderr: '' });

      expect(() =>
        splitPdfIfNeeded({ pdfPath, outputDir: join(dir, 'parts'), thresholdBytes: 2048, spawnFn }),
      ).toThrow('PDF split failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── reassemblePdf ─────────────────────────────────────────────────────────────

describe('reassemblePdf', () => {
  it('passes partsDir and outputPath to python3', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: SplitSpawnFn = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    };

    reassemblePdf({ partsDir: '/parts', outputPath: '/out/paper.pdf', spawnFn });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('python3');
    // args[1] = partsDir, args[2] = outputPath
    expect(calls[0].args[1]).toBe('/parts');
    expect(calls[0].args[2]).toBe('/out/paper.pdf');
  });

  it('succeeds when subprocess returns ok=true', () => {
    const spawnFn = makeSpawn({ ok: true });
    expect(() =>
      reassemblePdf({ partsDir: '/parts', outputPath: '/out/paper.pdf', spawnFn }),
    ).not.toThrow();
  });

  it('throws when subprocess exits non-zero', () => {
    expect(() =>
      reassemblePdf({ partsDir: '/parts', outputPath: '/out/paper.pdf', spawnFn: failedReassembleSpawn }),
    ).toThrow('PDF reassemble failed');
  });

  it('throws when subprocess returns ok=false with error message', () => {
    const spawnFn = makeSpawn({ ok: false, error: 'no parts found' });
    expect(() =>
      reassemblePdf({ partsDir: '/empty', outputPath: '/out/paper.pdf', spawnFn }),
    ).toThrow('no parts found');
  });

  it('throws when subprocess returns malformed JSON', () => {
    expect(() =>
      reassemblePdf({ partsDir: '/parts', outputPath: '/out/paper.pdf', spawnFn: malformedJsonSpawn }),
    ).toThrow('PDF reassemble failed');
  });
});
