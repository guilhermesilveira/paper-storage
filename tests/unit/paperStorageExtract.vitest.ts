import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdfText, extractWithMarker, computeTextScore, type ExtractSpawnFn, type ExtractionResult, type MarkerExtractDeps } from '../../src/lib/paperStorageExtract';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSpawnFn(result: Partial<{ status: number; stdout: string; stderr: string }>): ExtractSpawnFn {
  return () => ({
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
}

function goodResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    ok: true,
    pageCount: 3,
    availableMethods: ['pymupdf', 'pdftotext', 'tesseract'],
    pages: [
      { page: 1, method: 'pymupdf',   score: 0.85 },
      { page: 2, method: 'pdftotext', score: 0.91 },
      { page: 3, method: 'tesseract', score: 0.74 },
    ],
    overallScore: 0.83,
    lowQualityPages: [],
    ...overrides,
  };
}

// ── extractPdfText ────────────────────────────────────────────────────────────

describe('extractPdfText', () => {
  it('returns parsed JSON from the Python subprocess', () => {
    const result = goodResult();
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.ok).toBe(true);
      expect(out.pageCount).toBe(3);
      expect(out.overallScore).toBe(0.83);
      expect(out.pages).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes pdfPath and outputDir as positional args to python3', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnFn: ExtractSpawnFn = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0, stdout: JSON.stringify(goodResult()), stderr: '' };
    };
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      extractPdfText({ pdfPath: '/some/paper.pdf', outputDir: dir, spawnFn, python3Bin: 'python3' });
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe('python3');
      // args[0] = script path, args[1] = pdfPath, args[2] = outputDir
      expect(calls[0].args[1]).toBe('/some/paper.pdf');
      expect(calls[0].args[2]).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok=false when subprocess exits non-zero', () => {
    const spawnFn = makeSpawnFn({ status: 1, stdout: '', stderr: 'python crash' });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/exited with code 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok=false when subprocess output is malformed JSON', () => {
    const spawnFn = makeSpawnFn({ status: 0, stdout: '{broken json' });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/malformed JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok=false with unsupported-format error for non-PDF', () => {
    const spawnFn = makeSpawnFn({
      status: 0,
      stdout: JSON.stringify({ ok: false, error: 'unsupported-format' }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.djvu', outputDir: dir, spawnFn });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('unsupported-format');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates outputDir if it does not exist', () => {
    const base = mkdtempSync(join(tmpdir(), 'pse-test-'));
    const nested = join(base, 'deep', 'output');
    try {
      extractPdfText({
        pdfPath: '/tmp/paper.pdf',
        outputDir: nested,
        spawnFn: makeSpawnFn({ stdout: JSON.stringify(goodResult()) }),
      });
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns lowQualityPages from the subprocess result', () => {
    const result = goodResult({ lowQualityPages: [2, 7, 14] });
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.lowQualityPages).toEqual([2, 7, 14]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('all-pymupdf result: only pymupdf in pages', () => {
    const result = goodResult({
      availableMethods: ['pymupdf'],
      pages: [
        { page: 1, method: 'pymupdf', score: 0.88 },
        { page: 2, method: 'pymupdf', score: 0.91 },
      ],
      pageCount: 2,
      overallScore: 0.895,
    });
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.ok).toBe(true);
      expect(out.pages.every((p) => p.method === 'pymupdf')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scanned PDF result: all pages use tesseract', () => {
    const result = goodResult({
      availableMethods: ['pymupdf', 'tesseract'],
      pages: [
        { page: 1, method: 'tesseract', score: 0.72 },
        { page: 2, method: 'tesseract', score: 0.68 },
        { page: 3, method: 'tesseract', score: 0.75 },
      ],
      overallScore: 0.72,
    });
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.ok).toBe(true);
      expect(out.pages.every((p) => p.method === 'tesseract')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mixed PDF result: different methods win on different pages', () => {
    const result = goodResult({
      pages: [
        { page: 1, method: 'pdftotext', score: 0.94 },
        { page: 2, method: 'tesseract', score: 0.71 }, // scanned figure page
        { page: 3, method: 'pymupdf',   score: 0.87 },
      ],
    });
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.pages[0].method).toBe('pdftotext');
      expect(out.pages[1].method).toBe('tesseract');
      expect(out.pages[2].method).toBe('pymupdf');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pdftotext not available: pymupdf and tesseract compete', () => {
    const result = goodResult({
      availableMethods: ['pymupdf', 'tesseract'],
      pages: [
        { page: 1, method: 'pymupdf',   score: 0.83 },
        { page: 2, method: 'tesseract', score: 0.77 },
        { page: 3, method: 'pymupdf',   score: 0.89 },
      ],
    });
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.availableMethods).not.toContain('pdftotext');
      expect(out.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates overallScore and lowQualityPages correctly', () => {
    const result: ExtractionResult = {
      ok: true,
      pageCount: 5,
      availableMethods: ['pymupdf', 'tesseract'],
      pages: [
        { page: 1, method: 'pymupdf',   score: 0.90 },
        { page: 2, method: 'tesseract', score: 0.30 }, // low
        { page: 3, method: 'pymupdf',   score: 0.85 },
        { page: 4, method: 'tesseract', score: 0.25 }, // low
        { page: 5, method: 'pymupdf',   score: 0.88 },
      ],
      overallScore: 0.636,
      lowQualityPages: [2, 4],
    };
    const spawnFn = makeSpawnFn({ stdout: JSON.stringify(result) });
    const dir = mkdtempSync(join(tmpdir(), 'pse-test-'));
    try {
      const out = extractPdfText({ pdfPath: '/tmp/paper.pdf', outputDir: dir, spawnFn });
      expect(out.overallScore).toBeCloseTo(0.636, 2);
      expect(out.lowQualityPages).toEqual([2, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── computeTextScore ──────────────────────────────────────────────────────────

describe('computeTextScore', () => {
  it('returns 0 for empty string', () => {
    expect(computeTextScore('')).toBe(0);
    expect(computeTextScore('   ')).toBe(0);
  });

  it('returns a score between 0 and 1 for normal text', () => {
    const score = computeTextScore('Hello world, this is a test of the scoring function.');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores alpha-heavy text higher than symbol-heavy text', () => {
    const alpha = computeTextScore('This is a natural English sentence with lots of words.');
    const syms  = computeTextScore('12345 !@#$% 67890 ^&*() +-=/');
    expect(alpha).toBeGreaterThan(syms);
  });
});

// ── extractWithMarker ─────────────────────────────────────────────────────────

function makeMarkerDeps(overrides: Partial<MarkerExtractDeps> = {}): MarkerExtractDeps {
  const MARKDOWN = '# Title\n\nSome extracted text with equations $x^2$.\n\nMore content here.';
  const META     = JSON.stringify({ page_stats: [{}, {}, {}] }); // 3 pages
  return {
    spawnFn: (cmd, _args) => {
      if (cmd === 'which') return { status: 0, stdout: '/usr/bin/marker_single', stderr: '' };
      if (cmd === 'marker_single' || cmd === '/usr/bin/marker_single') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    },
    mkdtempSyncFn: () => '/tmp/psr-marker-test',
    existsSyncFn:  (p) => p.endsWith('.md') || p.endsWith('_meta.json'),
    readFileSyncFn: (p) => {
      if (p.endsWith('.md'))       return MARKDOWN;
      if (p.endsWith('_meta.json')) return META;
      return '';
    },
    writeFileSyncFn: () => undefined,
    mkdirSyncFn:     () => undefined,
    rmSyncFn:        () => undefined,
    ...overrides,
  };
}

describe('extractWithMarker', () => {
  it('returns null when marker_single is not in PATH', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({
        spawnFn: () => ({ status: 1, stdout: '', stderr: 'not found' }),
      }),
    });
    expect(result).toBeNull();
  });

  it('returns ok=false when marker_single exits non-zero', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({
        spawnFn: (cmd) => {
          if (cmd === 'which') return { status: 0, stdout: '/usr/bin/marker_single', stderr: '' };
          return { status: 1, stdout: '', stderr: 'marker crashed' };
        },
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.error).toMatch(/marker_single failed/);
  });

  it('returns ok=false when markdown output file is missing', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({ existsSyncFn: () => false }),
    });
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });

  it('returns ok=true with correct pageCount from meta.json', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps(),
    });
    expect(result!.ok).toBe(true);
    expect(result!.pageCount).toBe(3);
    expect(result!.availableMethods).toEqual(['marker']);
  });

  it('returns pages array with method=marker for each page', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps(),
    });
    expect(result!.pages).toHaveLength(3);
    expect(result!.pages.every((p) => p.method === 'marker')).toBe(true);
  });

  it('writes markdown to full.txt via writeFileSyncFn', () => {
    const written: Record<string, string> = {};
    extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    expect(written['/tmp/out/full.txt']).toContain('Title');
  });

  it('copies image files to outputDir/images/', () => {
    const copies: { src: string; dst: string }[] = [];
    const IMAGES = ['_page_0_Figure_1.jpeg', '_page_1_Figure_2.png', 'not-an-image.txt'];
    extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({
        readdirSyncFn: () => ['paper.md', 'paper_meta.json', ...IMAGES],
        copyFileSyncFn: (src, dst) => { copies.push({ src, dst }); },
      }),
    });
    expect(copies).toHaveLength(2);  // only .jpeg and .png, not .txt
    expect(copies[0].dst).toContain('/images/_page_0_Figure_1.jpeg');
    expect(copies[1].dst).toContain('/images/_page_1_Figure_2.png');
  });

  it('skips image copy gracefully when readdir fails', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({
        readdirSyncFn: () => { throw new Error('readdir boom'); },
      }),
    });
    // Should still return ok=true (image copy is best-effort)
    expect(result!.ok).toBe(true);
  });

  it('uses pageCount=1 when meta.json is missing', () => {
    const result = extractWithMarker({
      pdfPath: '/tmp/paper.pdf', outputDir: '/tmp/out',
      _deps: makeMarkerDeps({ existsSyncFn: (p) => p.endsWith('.md') }),
    });
    expect(result!.ok).toBe(true);
    expect(result!.pageCount).toBe(0);  // no meta → 0
    expect(result!.pages).toHaveLength(1);  // fallback to 1 page record
  });
});
