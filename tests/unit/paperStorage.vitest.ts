import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { storePaper, dominantExtractionMethod, retrievePaper, movePaper, listPapers, type StorePaperDeps, type RetrievePaperDeps, type MovePaperDeps } from '../../src/lib/paperStorage';
import { addEntry, removeEntry, updateEntry, EMPTY_INDEX, type PaperIndex, type PaperIndexEntry } from '../../src/lib/paperStorageRepo';
import type { ExtractionResult } from '../../src/lib/paperStorageExtract';
import type { SplitResult } from '../../src/lib/paperStorageSplit';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = '/repo';
const FILE = '/source/paper.pdf';
const FILE_SIZE = 1024;

function goodExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    ok: true,
    pageCount: 10,
    availableMethods: ['pymupdf'],
    pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, method: 'pymupdf' as const, score: 0.85 })),
    overallScore: 0.85,
    lowQualityPages: [],
    ...overrides,
  };
}

function noSplit(): SplitResult {
  return { split: false, partCount: 0, partPaths: [] };
}

function yesSplit(): SplitResult {
  return { split: true, partCount: 3, partPaths: ['/repo/papers/uuid/parts/part-001.pdf', '/repo/papers/uuid/parts/part-002.pdf', '/repo/papers/uuid/parts/part-003.pdf'] };
}

function splitExists(p: string): boolean {
  return !p.endsWith('original.pdf');
}

/**
 * Build a full set of happy-path deps.
 * Every dep is a no-op / sensible default. Override per-test as needed.
 */
function makeDeps(overrides: Partial<StorePaperDeps> = {}): StorePaperDeps {
  return {
    existsSyncFn:          () => true,
    statSyncFn:            () => ({ size: FILE_SIZE }),
    mkdirSyncFn:           () => undefined,
    copyFileSyncFn:        () => undefined,
    writeFileSyncFn:       () => undefined,
    readFileSyncFn:        () => 'extracted text content',
    rmSyncFn:              () => undefined,
    pullRepoFn:            () => undefined,
    readIndexFn:           () => structuredClone(EMPTY_INDEX),
    writeIndexFn:          () => undefined,
    addEntryFn:            addEntry,
    removeEntryFn:         removeEntry,
    commitAndPushFn:       () => undefined,
    extractFn:             () => goodExtraction(),
    extractWithMarkerFn:   () => null,   // disabled in tests — prevents real Marker calls
    splitFn:               () => noSplit(),
    uuidFn:                () => 'test-uuid-1234',
    ...overrides,
  };
}

// ── dominantExtractionMethod ──────────────────────────────────────────────────

describe('dominantExtractionMethod', () => {
  it('returns pymupdf when all pages use pymupdf', () => {
    const r = goodExtraction();
    expect(dominantExtractionMethod(r)).toBe('pymupdf');
  });

  it('returns the majority method for mixed pages', () => {
    const r = goodExtraction({
      pages: [
        { page: 1, method: 'tesseract', score: 0.7 },
        { page: 2, method: 'tesseract', score: 0.7 },
        { page: 3, method: 'pymupdf',   score: 0.9 },
      ],
    });
    expect(dominantExtractionMethod(r)).toBe('tesseract');
  });

  it('returns failed when ok=false', () => {
    expect(dominantExtractionMethod({ ok: false, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [], error: 'crash' })).toBe('failed');
  });

  it('returns unsupported-format when error is unsupported-format', () => {
    expect(dominantExtractionMethod({ ok: false, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [], error: 'unsupported-format' })).toBe('unsupported-format');
  });

  it('returns unknown when ok=true but no pages', () => {
    const result = dominantExtractionMethod({ ok: true, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [] });
    expect(result === 'unknown').toBe(true);
  });
});

// ── storePaper — validation ───────────────────────────────────────────────────

describe('storePaper validation', () => {
  it('uses the default repo path when path is missing', () => {
    const pulled: string[] = [];
    storePaper({
      path: '', name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ pullRepoFn: (d) => { pulled.push(d); } }),
    });
    expect(pulled[0]).toContain('.local/paper-storage/research-papers');
  });

  it('throws when --name is missing', () => {
    expect(() => storePaper({ path: REPO, name: '', year: 2024, file: FILE, _deps: makeDeps() }))
      .toThrow('Missing --name');
  });

  it('throws when neither --pdf/--file nor --txt provided', () => {
    expect(() => storePaper({ path: REPO, name: 'x', year: 2024, _deps: makeDeps() }))
      .toThrow('Provide --pdf/--file');
  });

  it('throws when --pdf and --file are both provided', () => {
    expect(() => storePaper({ path: REPO, name: 'x', year: 2024, pdf: FILE, file: FILE, _deps: makeDeps() }))
      .toThrow('aliases');
  });

  it('throws when --year is not a number', () => {
    expect(() => storePaper({ path: REPO, name: 'x', year: NaN, file: FILE, _deps: makeDeps() }))
      .toThrow('--year must be a number');
  });

  it('throws when file does not exist', () => {
    expect(() => storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ existsSyncFn: (p) => p !== FILE }),
    })).toThrow(`File not found: ${FILE}`);
  });
});

// ── storePaper — happy path (small file) ─────────────────────────────────────

describe('storePaper happy path (small file)', () => {
  it('returns uuid, name, year, pageCount, extractionMethod, overallScore', () => {
    const result = storePaper({ path: REPO, name: 'ren-2024', year: 2024, file: FILE, _deps: makeDeps() });
    expect(result.uuid).toBe('test-uuid-1234');
    expect(result.name).toBe('ren-2024');
    expect(result.year).toBe(2024);
    expect(result.pageCount).toBe(10);
    expect(result.extractionMethod).toBe('pymupdf');
    expect(result.overallScore).toBe(0.85);
    expect(result.lowQualityPages).toEqual([]);
    expect(result.split).toBe(false);
    expect(result.partCount).toBe(0);
  });

  it('includes doi in result when provided', () => {
    const result = storePaper({ path: REPO, name: 'alpha', year: 2024, file: FILE, doi: '10.0/test', _deps: makeDeps() });
    expect(result.doi).toBe('10.0/test');
  });

  it('calls pullRepoFn with repoDir', () => {
    const pulled: string[] = [];
    storePaper({ path: REPO, name: 'x', year: 2024, file: FILE, _deps: makeDeps({ pullRepoFn: (d) => { pulled.push(d); } }) });
    expect(pulled).toEqual([REPO]);
  });

  it('calls mkdirSyncFn for the paper directory', () => {
    const dirs: string[] = [];
    storePaper({ path: REPO, name: 'x', year: 2024, file: FILE, _deps: makeDeps({ mkdirSyncFn: (p) => { dirs.push(p); } }) });
    expect(dirs.some((d) => d.includes('test-uuid-1234'))).toBe(true);
  });

  it('calls copyFileSyncFn to copy original.pdf for small files', () => {
    const copies: { src: string; dst: string }[] = [];
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ copyFileSyncFn: (src, dst) => { copies.push({ src, dst }); } }),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].src).toBe(FILE);
    expect(copies[0].dst).toBe(join(REPO, 'papers', 'test-uuid-1234', 'original.pdf'));
  });

  it('does NOT call copyFileSyncFn for large files (split path)', () => {
    const copies: string[] = [];
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        copyFileSyncFn: (src) => { copies.push(src); },
        splitFn: () => yesSplit(),
      }),
    });
    expect(copies).toHaveLength(0);
  });

  it('calls extractFn with pdfPath and outputDir inside paper folder', () => {
    const extractCalls: { pdfPath: string; outputDir: string }[] = [];
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ extractFn: (o) => { extractCalls.push(o); return goodExtraction(); } }),
    });
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0].pdfPath).toBe(FILE);
    expect(extractCalls[0].outputDir).toBe(join(REPO, 'papers', 'test-uuid-1234'));
  });

  it('writes metadata.json with correct fields', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'ren-2024', year: 2024, file: FILE,
      doi: '10.0/test', title: 'On things',
      _deps: makeDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const metaPath = join(REPO, 'papers', 'test-uuid-1234', 'metadata.json');
    expect(written[metaPath]).toBeTruthy();
    const meta = JSON.parse(written[metaPath]);
    expect(meta.uuid).toBe('test-uuid-1234');
    expect(meta.name).toBe('ren-2024');
    expect(meta.doi).toBe('10.0/test');
    expect(meta.title).toBe('On things');
    expect(meta.year).toBe(2024);
    expect(meta.pageCount).toBe(10);
    expect(meta.extractionMethod).toBe('pymupdf');
    expect(meta.split).toBe(false);
    expect(meta.originalFilename).toBe('paper.pdf');
    expect(meta.originalSizeBytes).toBe(FILE_SIZE);
    expect(meta.overallScore).toBe(0.85);
    expect(typeof meta.storedAt).toBe('string');
  });

  it('does NOT include doi or title in metadata when not provided', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'nodoi', year: 2024, file: FILE,
      _deps: makeDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect('doi'   in meta).toBe(false);
    expect('title' in meta).toBe(false);
  });

  it('calls writeIndexFn with updated index containing the new entry', () => {
    const written: PaperIndex[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, doi: '10.0/a',
      _deps: makeDeps({ writeIndexFn: (_, idx) => { written.push(idx); } }),
    });
    expect(written).toHaveLength(1);
    expect(written[0].byName.alpha).toBe('test-uuid-1234');
    expect(written[0].byDoi['10.0/a']).toBe('test-uuid-1234');
    expect(written[0].byUuid['test-uuid-1234']).toBeDefined();
  });

  it('calls commitAndPushFn with repoDir and commit message containing name', () => {
    const commits: { dir: string; msg: string }[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE,
      _deps: makeDeps({ commitAndPushFn: (d, m) => { commits.push({ dir: d, msg: m }); } }),
    });
    expect(commits).toHaveLength(1);
    expect(commits[0].dir).toBe(REPO);
    expect(commits[0].msg).toContain('alpha');
  });

  it('includes doi in commit message when provided', () => {
    const commits: string[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, doi: '10.0/test',
      _deps: makeDeps({ commitAndPushFn: (_, m) => { commits.push(m); } }),
    });
    expect(commits[0]).toContain('10.0/test');
  });
});

// ── storePaper — collision errors ─────────────────────────────────────────────

describe('storePaper collision errors', () => {
  it('throws on name collision without --force', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'alpha', year: 2020, storedAt: 'T',
    });
    expect(() => storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE,
      _deps: makeDeps({ readIndexFn: () => structuredClone(existingIndex) }),
    })).toThrow("Name 'alpha' already stored (uuid=old-uuid). Use --force.");
  });

  it('throws on doi collision without --force', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'old-name', year: 2020, storedAt: 'T', doi: '10.0/x',
    });
    expect(() => storePaper({
      path: REPO, name: 'new-name', year: 2024, file: FILE, doi: '10.0/x',
      _deps: makeDeps({ readIndexFn: () => structuredClone(existingIndex) }),
    })).toThrow("DOI '10.0/x' already stored (uuid=old-uuid). Use --force.");
  });
});

// ── storePaper — --force overwrite ────────────────────────────────────────────

describe('storePaper --force', () => {
  it('reuses existing UUID when name already exists', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'alpha', year: 2020, storedAt: 'T',
    });
    const result = storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, force: true,
      _deps: makeDeps({
        readIndexFn: () => structuredClone(existingIndex),
        uuidFn: () => 'should-not-be-used',
      }),
    });
    expect(result.uuid).toBe('old-uuid');
  });

  it('deletes the old folder before recreating', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'alpha', year: 2020, storedAt: 'T',
    });
    const removed: string[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, force: true,
      _deps: makeDeps({
        readIndexFn: () => structuredClone(existingIndex),
        existsSyncFn: () => true,
        rmSyncFn: (p) => { removed.push(p); },
      }),
    });
    expect(removed.some((p) => p.includes('old-uuid'))).toBe(true);
  });

  it('does not delete old folder when it does not exist', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'alpha', year: 2020, storedAt: 'T',
    });
    const removed: string[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, force: true,
      _deps: makeDeps({
        readIndexFn: () => structuredClone(existingIndex),
        // folder does not exist
        existsSyncFn: (p) => !p.includes('old-uuid'),
        rmSyncFn: (p) => { removed.push(p); },
      }),
    });
    expect(removed.every((p) => !p.includes('old-uuid'))).toBe(true);
  });

  it('removes old entry from index before adding new one', () => {
    const existingIndex = addEntry(structuredClone(EMPTY_INDEX), {
      uuid: 'old-uuid', name: 'alpha', year: 2020, storedAt: 'T', doi: '10.0/old',
    });
    const written: PaperIndex[] = [];
    storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, doi: '10.0/new', force: true,
      _deps: makeDeps({
        readIndexFn: () => structuredClone(existingIndex),
        writeIndexFn: (_, idx) => { written.push(idx); },
      }),
    });
    expect(written[0].byDoi['10.0/old']).toBeUndefined();
    expect(written[0].byDoi['10.0/new']).toBe('old-uuid');
    expect(written[0].byName.alpha).toBe('old-uuid');
  });

  it('throws when --force has name and doi pointing to different entries', () => {
    // uuid-A owns 'alpha'; uuid-B owns '10.0/x' — ambiguous force
    const idx = addEntry(
      addEntry(structuredClone(EMPTY_INDEX), { uuid: 'uuid-A', name: 'alpha', year: 2020, storedAt: 'T' }),
      { uuid: 'uuid-B', name: 'other-name', year: 2021, storedAt: 'T', doi: '10.0/x' },
    );
    expect(() => storePaper({
      path: REPO, name: 'alpha', year: 2024, file: FILE, doi: '10.0/x', force: true,
      _deps: makeDeps({ readIndexFn: () => structuredClone(idx) }),
    })).toThrow('belong to different stored entries');
  });
});

// ── storePaper — pull failure propagates ──────────────────────────────────────

describe('storePaper pull failure', () => {
  it('throws with init hint when pull returns ok=false with git-repo message', () => {
    expect(() => storePaper({
      path: '/not/a/repo', name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        pullRepoFn: () => { throw new Error('Repo not initialized at /not/a/repo. Run: paper-storage init --path /not/a/repo --create'); },
      }),
    })).toThrow('Repo not initialized');
  });

  it('throws generic error when pull fails for another reason', () => {
    expect(() => storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        pullRepoFn: () => { throw new Error('git pull failed: network unreachable'); },
      }),
    })).toThrow('git pull failed');
  });
});

// ── storePaper — extraction failures ─────────────────────────────────────────

describe('storePaper extraction failures', () => {
  it('stores with extractionMethod=failed when extraction returns ok=false', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        writeFileSyncFn: (p, c) => { written[p] = c; },
        extractFn: () => ({ ok: false, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [], error: 'crash' }),
      }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('failed');
    expect(meta.pageCount).toBe(0);
  });

  it('stores with extractionMethod=unsupported-format for unsupported files', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        writeFileSyncFn: (p, c) => { written[p] = c; },
        extractFn: () => ({ ok: false, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [], error: 'unsupported-format' }),
      }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('unsupported-format');
  });

  it('still commits even when extraction fails', () => {
    const commits: string[] = [];
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        commitAndPushFn: (_, m) => { commits.push(m); },
        extractFn: () => ({ ok: false, pageCount: 0, availableMethods: [], pages: [], overallScore: 0, lowQualityPages: [], error: 'crash' }),
      }),
    });
    expect(commits).toHaveLength(1);
  });
});

// ── storePaper — Marker extraction ───────────────────────────────────────────

describe('storePaper Marker extraction', () => {
  const MARKER_RESULT = {
    ok: true as const,
    pageCount: 9,
    availableMethods: ['marker'],
    pages: Array.from({ length: 9 }, (_, i) => ({ page: i + 1, method: 'marker' as const, score: 0.88 })),
    overallScore: 0.88,
    lowQualityPages: [],
  };

  it('uses Marker result when extractWithMarkerFn returns ok=true', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        extractWithMarkerFn: () => MARKER_RESULT,
        writeFileSyncFn: (p, c) => { written[p] = c; },
      }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('marker');
    expect(meta.overallScore).toBe(0.88);
    expect(meta.pageCount).toBe(9);
    expect(meta.markerTried).toBe(true);
    expect(meta.fallbackUsed).toBe(false);
    expect('markerError' in meta).toBe(false);
  });

  it('falls back to extractFn when extractWithMarkerFn returns null', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        extractWithMarkerFn: () => null,
        writeFileSyncFn: (p, c) => { written[p] = c; },
      }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('pymupdf');  // from goodExtraction() fallback
    expect(meta.markerTried).toBe(false);
    expect(meta.fallbackUsed).toBe(true);
    expect('markerError' in meta).toBe(false);
  });

  it('falls back to extractFn when extractWithMarkerFn returns ok=false', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        extractWithMarkerFn: () => ({ ok: false, pageCount: 0, availableMethods: ['marker'], pages: [], overallScore: 0, lowQualityPages: [], error: 'fail' }),
        writeFileSyncFn: (p, c) => { written[p] = c; },
      }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('pymupdf');
    expect(meta.markerTried).toBe(true);
    expect(meta.fallbackUsed).toBe(true);
    expect(meta.markerError).toBe('fail');
  });

  it('does NOT call extractFn when Marker succeeds', () => {
    let extractCalled = false;
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({
        extractWithMarkerFn: () => MARKER_RESULT,
        extractFn: () => { extractCalled = true; return goodExtraction(); },
      }),
    });
    expect(extractCalled).toBe(false);
  });
});

// ── storePaper — txt-only mode ────────────────────────────────────────────────

const TXT_FILE = '/source/paper.txt';
const TXT_CONTENT = 'This is the extracted text from the paper.';

describe('storePaper txt-only', () => {
  it('does not call splitFn when no PDF provided', () => {
    let splitCalled = false;
    storePaper({
      path: REPO, name: 'x', year: 2024, txt: TXT_FILE,
      _deps: makeDeps({ splitFn: () => { splitCalled = true; return noSplit(); } }),
    });
    expect(splitCalled).toBe(false);
  });

  it('does not call extractFn or extractWithMarkerFn when txt provided', () => {
    let extractCalled = false;
    let markerCalled = false;
    storePaper({
      path: REPO, name: 'x', year: 2024, txt: TXT_FILE,
      _deps: makeDeps({
        extractFn: () => { extractCalled = true; return goodExtraction(); },
        extractWithMarkerFn: () => { markerCalled = true; return null; },
      }),
    });
    expect(extractCalled).toBe(false);
    expect(markerCalled).toBe(false);
  });

  it('reads txt file and writes it as full.txt', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'txt-paper', year: 2024, txt: TXT_FILE,
      _deps: makeDeps({
        readFileSyncFn: (p) => p === TXT_FILE ? TXT_CONTENT : '',
        writeFileSyncFn: (p, c) => { written[p] = c; },
      }),
    });
    expect(written[join(REPO, 'papers', 'test-uuid-1234', 'full.txt')]).toBe(TXT_CONTENT);
  });

  it('sets extractionMethod=provided in metadata', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, txt: TXT_FILE,
      _deps: makeDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.extractionMethod).toBe('provided');
    expect(meta.overallScore).toBe(0.9);
    expect(meta.pageCount).toBe(0);
  });

  it('uses txt basename as originalFilename', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, txt: TXT_FILE,
      _deps: makeDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.originalFilename).toBe('paper.txt');
  });
});

// ── storePaper — pdf+txt mode ─────────────────────────────────────────────────

describe('storePaper pdf+txt', () => {
  it('stores the PDF (copies original.pdf) and uses txt as full.txt', () => {
    const copies: { src: string; dst: string }[] = [];
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, pdf: FILE, txt: TXT_FILE,
      _deps: makeDeps({
        copyFileSyncFn: (src, dst) => { copies.push({ src, dst }); },
        readFileSyncFn: (p) => p === TXT_FILE ? TXT_CONTENT : '',
        writeFileSyncFn: (p, c) => { written[p] = c; },
      }),
    });
    expect(copies.some((c) => c.dst.endsWith('original.pdf'))).toBe(true);
    expect(written[join(REPO, 'papers', 'test-uuid-1234', 'full.txt')]).toBe(TXT_CONTENT);
  });

  it('does not call extractFn or Marker when txt is provided alongside PDF', () => {
    let extractCalled = false;
    let markerCalled = false;
    storePaper({
      path: REPO, name: 'x', year: 2024, pdf: FILE, txt: TXT_FILE,
      _deps: makeDeps({
        extractFn: () => { extractCalled = true; return goodExtraction(); },
        extractWithMarkerFn: () => { markerCalled = true; return null; },
      }),
    });
    expect(extractCalled).toBe(false);
    expect(markerCalled).toBe(false);
  });

  it('uses pdf basename as originalFilename when pdf provided with txt', () => {
    const written: Record<string, string> = {};
    storePaper({
      path: REPO, name: 'x', year: 2024, pdf: FILE, txt: TXT_FILE,
      _deps: makeDeps({ writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const meta = JSON.parse(written[join(REPO, 'papers', 'test-uuid-1234', 'metadata.json')]);
    expect(meta.originalFilename).toBe('paper.pdf');
  });

  it('throws if --pdf and --file both set', () => {
    expect(() => storePaper({ path: REPO, name: 'x', year: 2024, pdf: FILE, file: FILE, _deps: makeDeps() }))
      .toThrow('aliases');
  });
});

// ── storePaper — large file (split path) ─────────────────────────────────────

describe('storePaper large file', () => {
  it('returns split=true and partCount from splitFn result', () => {
    const result = storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ splitFn: () => yesSplit() }),
    });
    expect(result.split).toBe(true);
    expect(result.partCount).toBe(3);
  });

  it('passes parts outputDir inside paper folder', () => {
    const splitCalls: string[] = [];
    storePaper({
      path: REPO, name: 'x', year: 2024, file: FILE,
      _deps: makeDeps({ splitFn: (o) => { splitCalls.push(o.outputDir); return yesSplit(); } }),
    });
    expect(splitCalls[0]).toBe(join(REPO, 'papers', 'test-uuid-1234', 'parts'));
  });
});

// ── retrievePaper helpers ─────────────────────────────────────────────────────

const UUID   = 'stored-uuid-abcd';
const SAVE   = '/tmp/out/paper.pdf';
const SIZE   = 9999;

/** Index with one paper stored under UUID. */
function indexWithPaper(overrides: Partial<PaperIndexEntry> = {}): PaperIndex {
  return addEntry(structuredClone(EMPTY_INDEX), {
    uuid: UUID, name: 'stored-paper', year: 2024, storedAt: 'T',
    doi: '10.0/stored',
    ...overrides,
  });
}

function makeRetrieveDeps(overrides: Partial<RetrievePaperDeps> = {}): RetrievePaperDeps {
  return {
    pullRepoFn:       () => undefined,
    readIndexFn:      () => indexWithPaper(),
    existsSyncFn:     () => true,
    mkdirSyncFn:      () => undefined,
    copyFileSyncFn:   () => undefined,
    statSyncFn:       () => ({ size: SIZE }),
    reassemblePdfFn:  () => undefined,
    ...overrides,
  };
}

// ── retrievePaper — validation ────────────────────────────────────────────────

describe('retrievePaper validation', () => {
  it('throws when no lookup key provided', () => {
    expect(() => retrievePaper({ path: REPO, retrieve: 'text', saveAt: SAVE, _deps: makeRetrieveDeps() }))
      .toThrow('Provide --uuid, --doi, or --name.');
  });

  it('uses the default repo path when path is missing', () => {
    const pulled: string[] = [];
    retrievePaper({
      path: '', uuid: UUID, retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps({ pullRepoFn: (d) => { pulled.push(d); } }),
    });
    expect(pulled[0]).toContain('.local/paper-storage/research-papers');
  });

  it('throws when --save-at is missing', () => {
    expect(() => retrievePaper({ path: REPO, uuid: UUID, retrieve: 'text', saveAt: '', _deps: makeRetrieveDeps() }))
      .toThrow('Missing --save-at');
  });

  it('throws when uuid not in index', () => {
    expect(() => retrievePaper({
      path: REPO, uuid: 'ghost-uuid', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps(),
    })).toThrow('Paper not found: uuid=ghost-uuid');
  });

  it('throws when doi not in index', () => {
    expect(() => retrievePaper({
      path: REPO, doi: '10.0/missing', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps(),
    })).toThrow('Paper not found: doi=10.0/missing');
  });

  it('throws when name not in index', () => {
    expect(() => retrievePaper({
      path: REPO, name: 'ghost-name', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps(),
    })).toThrow('Paper not found: name=ghost-name');
  });
});

// ── retrievePaper — lookup by doi and name ────────────────────────────────────

describe('retrievePaper lookup', () => {
  it('resolves by doi', () => {
    const copies: string[] = [];
    retrievePaper({
      path: REPO, doi: '10.0/stored', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps({ copyFileSyncFn: (src) => { copies.push(src); } }),
    });
    expect(copies[0]).toContain(UUID);
  });

  it('resolves by name', () => {
    const copies: string[] = [];
    retrievePaper({
      path: REPO, name: 'stored-paper', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps({ copyFileSyncFn: (src) => { copies.push(src); } }),
    });
    expect(copies[0]).toContain(UUID);
  });

  it('uuid takes priority over doi', () => {
    // uuid=UUID is valid, doi=ghost would not be found alone
    const result = retrievePaper({
      path: REPO, uuid: UUID, doi: '10.0/ghost', retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps(),
    });
    expect(result.uuid).toBe(UUID);
  });
});

// ── retrievePaper — retrieve text ─────────────────────────────────────────────

describe('retrievePaper retrieve=text', () => {
  it('copies full.txt to saveAt and returns sizeBytes', () => {
    const copies: { src: string; dst: string }[] = [];
    const result = retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps({ copyFileSyncFn: (src, dst) => { copies.push({ src, dst }); } }),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].src).toBe(join(REPO, 'papers', UUID, 'full.txt'));
    expect(copies[0].dst).toBe(SAVE);
    expect(result.uuid).toBe(UUID);
    expect(result.savedTo).toBe(SAVE);
    expect(result.sizeBytes).toBe(SIZE);
  });

  it('throws when full.txt does not exist', () => {
    expect(() => retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'text', saveAt: SAVE,
      _deps: makeRetrieveDeps({
        existsSyncFn: (p) => !p.endsWith('full.txt'),
      }),
    })).toThrow(`Extracted text not found for uuid=${UUID}`);
  });
});

// ── retrievePaper — retrieve original (single file) ───────────────────────────

describe('retrievePaper retrieve=original (single file)', () => {
  it('copies original.pdf to saveAt and returns sizeBytes', () => {
    const copies: { src: string; dst: string }[] = [];
    const result = retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: SAVE,
      _deps: makeRetrieveDeps({ copyFileSyncFn: (src, dst) => { copies.push({ src, dst }); } }),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0].src).toBe(join(REPO, 'papers', UUID, 'original.pdf'));
    expect(copies[0].dst).toBe(SAVE);
    expect(result.sizeBytes).toBe(SIZE);
  });

  it('creates parent directory of saveAt', () => {
    const dirs: string[] = [];
    retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: '/deep/new/dir/out.pdf',
      _deps: makeRetrieveDeps({ mkdirSyncFn: (p) => { dirs.push(p); } }),
    });
    expect(dirs.some((d) => d.includes('/deep/new/dir'))).toBe(true);
  });
});

// ── retrievePaper — retrieve original (split paper) ───────────────────────────

describe('retrievePaper retrieve=original (split paper)', () => {
  it('calls reassemblePdfFn with correct partsDir and outputPath', () => {
    const reassembleCalls: { partsDir: string; outputPath: string }[] = [];
    retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: SAVE,
      _deps: makeRetrieveDeps({
        existsSyncFn: splitExists,
        reassemblePdfFn: (o) => { reassembleCalls.push(o); },
      }),
    });
    expect(reassembleCalls).toHaveLength(1);
    expect(reassembleCalls[0].partsDir).toBe(join(REPO, 'papers', UUID, 'parts'));
    expect(reassembleCalls[0].outputPath).toBe(SAVE);
  });

  it('does NOT call copyFileSyncFn when reassembling', () => {
    const copies: string[] = [];
    retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: SAVE,
      _deps: makeRetrieveDeps({
        existsSyncFn: splitExists,
        copyFileSyncFn: (src) => { copies.push(src); },
        reassemblePdfFn: () => undefined,
      }),
    });
    expect(copies).toHaveLength(0);
  });

  it('stats saveAt (the assembled output) for sizeBytes', () => {
    const statted: string[] = [];
    retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: SAVE,
      _deps: makeRetrieveDeps({
        existsSyncFn: splitExists,
        reassemblePdfFn: () => undefined,
        statSyncFn: (p) => { statted.push(p); return { size: SIZE }; },
      }),
    });
    expect(statted.some((p) => p === SAVE)).toBe(true);
  });

  it('throws when neither original.pdf nor parts/ exist', () => {
    expect(() => retrievePaper({
      path: REPO, uuid: UUID, retrieve: 'original', saveAt: SAVE,
      _deps: makeRetrieveDeps({
        existsSyncFn: (p) => !p.endsWith('original.pdf') && !p.endsWith('parts'),
      }),
    })).toThrow(`Original file not found for uuid=${UUID}`);
  });
});

// ── movePaper helpers ─────────────────────────────────────────────────────────

const META_CONTENT = JSON.stringify({
  uuid: UUID, name: 'stored-paper', year: 2024, doi: '10.0/stored',
  title: 'Old title', storedAt: 'T', originalFilename: 'p.pdf',
  originalSizeBytes: 1024, split: false, partCount: 0,
  pageCount: 10, extractionMethod: 'pymupdf', overallScore: 0.85, lowQualityPages: [],
}, null, 2) + '\n';

function makeMoveDeps(
  startIndex: PaperIndex,
  overrides: Partial<MovePaperDeps> = {},
): MovePaperDeps {
  const currentIndex = { value: startIndex };
  return {
    pullRepoFn:       () => undefined,
    readIndexFn:      () => currentIndex.value,
    writeIndexFn:     (_, idx) => { currentIndex.value = idx; },
    updateEntryFn:    (idx, u, changes) => updateEntry(idx, u, changes),
    readFileSyncFn:   () => META_CONTENT,
    writeFileSyncFn:  () => undefined,
    existsSyncFn:     () => true,
    commitAndPushFn:  () => undefined,
    ...overrides,
  };
}

// ── movePaper — validation ────────────────────────────────────────────────────

describe('movePaper validation', () => {
  it('throws when no lookup key provided', () => {
    expect(() => movePaper({ path: REPO, newName: 'x', _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('Provide --uuid, --doi, or --name.');
  });

  it('throws when no change provided', () => {
    expect(() => movePaper({ path: REPO, uuid: UUID, _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('Provide at least one change');
  });

  it('throws when --new-doi and --remove-doi are both set', () => {
    expect(() => movePaper({ path: REPO, uuid: UUID, newDoi: '10.0/x', removeDoi: true, _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('mutually exclusive');
  });

  it('throws when --new-year is NaN', () => {
    expect(() => movePaper({ path: REPO, uuid: UUID, newYear: NaN, _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('finite number');
  });

  it('throws when paper not found by uuid', () => {
    expect(() => movePaper({ path: REPO, uuid: 'ghost', newName: 'x', _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('Paper not found: uuid=ghost');
  });

  it('throws when paper not found by name', () => {
    expect(() => movePaper({ path: REPO, name: 'ghost', newName: 'x', _deps: makeMoveDeps(indexWithPaper()) }))
      .toThrow('Paper not found: name=ghost');
  });
});

// ── movePaper — name change ───────────────────────────────────────────────────

describe('movePaper name change', () => {
  it('rekeys byName in the index', () => {
    const writtenIndexes: PaperIndex[] = [];
    movePaper({
      path: REPO, uuid: UUID, newName: 'new-name',
      _deps: makeMoveDeps(indexWithPaper(), { writeIndexFn: (_, idx) => { writtenIndexes.push(idx); } }),
    });
    const idx = writtenIndexes[0];
    expect(idx.byName['stored-paper']).toBeUndefined();
    expect(idx.byName['new-name']).toBe(UUID);
  });

  it('returns previousName and newName', () => {
    const result = movePaper({ path: REPO, uuid: UUID, newName: 'updated', _deps: makeMoveDeps(indexWithPaper()) });
    expect(result.previousName).toBe('stored-paper');
    expect(result.newName).toBe('updated');
    expect(result.uuid).toBe(UUID);
  });

  it('throws on new-name collision with another entry', () => {
    const idx = addEntry(indexWithPaper(), { uuid: 'other-uuid', name: 'taken', year: 2020, storedAt: 'T' });
    expect(() => movePaper({ path: REPO, uuid: UUID, newName: 'taken', _deps: makeMoveDeps(idx) }))
      .toThrow("Name 'taken' already taken");
  });

  it('updates name in metadata.json', () => {
    const written: Record<string, string> = {};
    movePaper({
      path: REPO, uuid: UUID, newName: 'better-name',
      _deps: makeMoveDeps(indexWithPaper(), { writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const metaPath = join(REPO, 'papers', UUID, 'metadata.json');
    expect(JSON.parse(written[metaPath]).name).toBe('better-name');
  });
});

// ── movePaper — doi change ────────────────────────────────────────────────────

describe('movePaper doi change', () => {
  it('rekeys byDoi in the index', () => {
    const written: PaperIndex[] = [];
    movePaper({
      path: REPO, uuid: UUID, newDoi: '10.0/new',
      _deps: makeMoveDeps(indexWithPaper(), { writeIndexFn: (_, idx) => { written.push(idx); } }),
    });
    expect(written[0].byDoi['10.0/stored']).toBeUndefined();
    expect(written[0].byDoi['10.0/new']).toBe(UUID);
  });

  it('throws on new-doi collision with another entry', () => {
    const idx = addEntry(indexWithPaper(), { uuid: 'other', name: 'other', year: 2020, storedAt: 'T', doi: '10.0/taken' });
    expect(() => movePaper({ path: REPO, uuid: UUID, newDoi: '10.0/taken', _deps: makeMoveDeps(idx) }))
      .toThrow("DOI '10.0/taken' already taken");
  });

  it('updates doi in metadata.json', () => {
    const written: Record<string, string> = {};
    movePaper({
      path: REPO, uuid: UUID, newDoi: '10.0/new',
      _deps: makeMoveDeps(indexWithPaper(), { writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const metaPath = join(REPO, 'papers', UUID, 'metadata.json');
    expect(JSON.parse(written[metaPath]).doi).toBe('10.0/new');
  });
});

// ── movePaper — remove doi ────────────────────────────────────────────────────

describe('movePaper --remove-doi', () => {
  it('removes doi from byDoi index', () => {
    const written: PaperIndex[] = [];
    movePaper({
      path: REPO, uuid: UUID, removeDoi: true,
      _deps: makeMoveDeps(indexWithPaper(), { writeIndexFn: (_, idx) => { written.push(idx); } }),
    });
    expect(written[0].byDoi['10.0/stored']).toBeUndefined();
    expect(written[0].byUuid[UUID].doi).toBeUndefined();
  });

  it('removes doi from metadata.json', () => {
    const written: Record<string, string> = {};
    movePaper({
      path: REPO, uuid: UUID, removeDoi: true,
      _deps: makeMoveDeps(indexWithPaper(), { writeFileSyncFn: (p, c) => { written[p] = c; } }),
    });
    const metaPath = join(REPO, 'papers', UUID, 'metadata.json');
    expect('doi' in JSON.parse(written[metaPath])).toBe(false);
  });

  it('returns newDoi=undefined in result', () => {
    const result = movePaper({ path: REPO, uuid: UUID, removeDoi: true, _deps: makeMoveDeps(indexWithPaper()) });
    expect(result.newDoi).toBeUndefined();
    expect(result.previousDoi).toBe('10.0/stored');
  });
});

// ── movePaper — year and title ────────────────────────────────────────────────

describe('movePaper year and title', () => {
  it('updates year in index and metadata.json', () => {
    const writtenIndexes: PaperIndex[] = [];
    const writtenFiles: Record<string, string> = {};
    movePaper({
      path: REPO, uuid: UUID, newYear: 2025,
      _deps: makeMoveDeps(indexWithPaper(), {
        writeIndexFn: (_, idx) => { writtenIndexes.push(idx); },
        writeFileSyncFn: (p, c) => { writtenFiles[p] = c; },
      }),
    });
    expect(writtenIndexes[0].byUuid[UUID].year).toBe(2025);
    const metaPath = join(REPO, 'papers', UUID, 'metadata.json');
    expect(JSON.parse(writtenFiles[metaPath]).year).toBe(2025);
  });

  it('updates title in metadata.json only (not in index)', () => {
    const writtenFiles: Record<string, string> = {};
    movePaper({
      path: REPO, uuid: UUID, newTitle: 'New Title',
      _deps: makeMoveDeps(indexWithPaper(), { writeFileSyncFn: (p, c) => { writtenFiles[p] = c; } }),
    });
    const metaPath = join(REPO, 'papers', UUID, 'metadata.json');
    expect(JSON.parse(writtenFiles[metaPath]).title).toBe('New Title');
  });

  it('skips metadata.json update when file does not exist', () => {
    const writtenFiles: string[] = [];
    movePaper({
      path: REPO, uuid: UUID, newTitle: 'Title',
      _deps: makeMoveDeps(indexWithPaper(), {
        existsSyncFn: () => false,
        writeFileSyncFn: (p) => { writtenFiles.push(p); },
      }),
    });
    expect(writtenFiles.filter((p) => p.endsWith('metadata.json'))).toHaveLength(0);
  });
});

// ── movePaper — commit ────────────────────────────────────────────────────────

describe('movePaper commit', () => {
  it('commits with message containing old and new name', () => {
    const commits: string[] = [];
    movePaper({
      path: REPO, uuid: UUID, newName: 'updated-name',
      _deps: makeMoveDeps(indexWithPaper(), { commitAndPushFn: (_, m) => { commits.push(m); } }),
    });
    expect(commits[0]).toContain('stored-paper');
    expect(commits[0]).toContain('updated-name');
  });

  it('commit message uses original name when only doi changes', () => {
    const commits: string[] = [];
    movePaper({
      path: REPO, uuid: UUID, newDoi: '10.0/new',
      _deps: makeMoveDeps(indexWithPaper(), { commitAndPushFn: (_, m) => { commits.push(m); } }),
    });
    expect(commits[0]).toContain('stored-paper');
  });
});

// ── listPapers ────────────────────────────────────────────────────────────────

describe('listPapers', () => {
  it('returns empty array for an empty index', () => {
    const result = listPapers({
      path: REPO,
      _deps: { pullRepoFn: () => undefined, readIndexFn: () => structuredClone(EMPTY_INDEX) },
    });
    expect(result).toEqual([]);
  });

  it('returns all entries sorted by name', () => {
    const idx = [
      { uuid: 'u3', name: 'zebra', year: 2021, storedAt: 'T' },
      { uuid: 'u1', name: 'alpha', year: 2020, storedAt: 'T' },
      { uuid: 'u2', name: 'middle', year: 2022, storedAt: 'T' },
    ].reduce((i, e) => addEntry(i, e), structuredClone(EMPTY_INDEX));

    const result = listPapers({ path: REPO, _deps: { pullRepoFn: () => undefined, readIndexFn: () => idx } });

    expect(result.map((e) => e.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('entry contains uuid, name, year, storedAt', () => {
    const idx = addEntry(structuredClone(EMPTY_INDEX), { uuid: 'u1', name: 'alpha', year: 2020, storedAt: '2026-01-01T00:00:00Z' });
    const [entry] = listPapers({ path: REPO, _deps: { pullRepoFn: () => undefined, readIndexFn: () => idx } });
    expect(entry.uuid).toBe('u1');
    expect(entry.name).toBe('alpha');
    expect(entry.year).toBe(2020);
    expect(entry.storedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('entry includes doi when present, omits it when absent', () => {
    const idx = [
      { uuid: 'u1', name: 'with-doi',    year: 2020, storedAt: 'T', doi: '10.0/x' },
      { uuid: 'u2', name: 'without-doi', year: 2021, storedAt: 'T' },
    ].reduce((i, e) => addEntry(i, e), structuredClone(EMPTY_INDEX));

    const result = listPapers({ path: REPO, _deps: { pullRepoFn: () => undefined, readIndexFn: () => idx } });
    const withDoi    = result.find((e) => e.name === 'with-doi')!;
    const withoutDoi = result.find((e) => e.name === 'without-doi')!;
    expect(withDoi.doi).toBe('10.0/x');
    expect(withoutDoi.doi).toBeUndefined();
  });

  it('calls pullRepoFn with repoDir', () => {
    const pulled: string[] = [];
    listPapers({ path: REPO, _deps: { pullRepoFn: (d) => { pulled.push(d); }, readIndexFn: () => structuredClone(EMPTY_INDEX) } });
    expect(pulled).toEqual([REPO]);
  });

  it('uses the default repo path when path is missing', () => {
    const pulled: string[] = [];
    listPapers({ path: '', _deps: { pullRepoFn: (d) => { pulled.push(d); }, readIndexFn: () => structuredClone(EMPTY_INDEX) } });
    expect(pulled[0]).toContain('.local/paper-storage/research-papers');
  });
});
