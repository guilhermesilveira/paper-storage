import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { addEntry, commitAndPush, pullRepo, readIndex, removeEntry, resolveUuid, updateEntry, writeIndex, type PaperIndex, type PaperIndexEntry, type UpdateEntryChanges } from './paperStorageRepo';
import { extractPdfText, extractWithMarker, type ExtractionResult } from './paperStorageExtract';
import { resolvePaperStorageRepoDir } from './paperStorageSetup';
import { reassemblePdf, splitPdfIfNeeded, type SplitResult } from './paperStorageSplit';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PaperMetadata {
  uuid: string;
  name: string;
  doi?: string;
  year: number;
  title?: string;
  storedAt: string;
  originalFilename: string;
  originalSizeBytes: number;
  split: boolean;
  partCount: number;
  pageCount: number;
  extractionMethod: string;
  overallScore: number;
  lowQualityPages: number[];
  markerTried?: boolean;
  markerError?: string;
  fallbackUsed?: boolean;
}

export interface StorePaperResult {
  uuid: string;
  name: string;
  doi?: string;
  year: number;
  pageCount: number;
  extractionMethod: string;
  overallScore: number;
  lowQualityPages: number[];
  split: boolean;
  partCount: number;
}

/**
 * Injectable dependencies — all optional, defaulting to real implementations.
 * Provide these in tests to avoid touching the file system, git, or Python.
 */
export interface StorePaperDeps {
  existsSyncFn?: (p: string) => boolean;
  statSyncFn?: (p: string) => { size: number };
  mkdirSyncFn?: (p: string, opts?: { recursive?: boolean }) => void;
  copyFileSyncFn?: (src: string, dst: string) => void;
  writeFileSyncFn?: (p: string, content: string) => void;
  readFileSyncFn?: (p: string) => string;
  rmSyncFn?: (p: string, opts?: { recursive?: boolean; force?: boolean }) => void;
  pullRepoFn?: (repoDir: string) => void;
  readIndexFn?: (repoDir: string) => PaperIndex;
  writeIndexFn?: (repoDir: string, index: PaperIndex) => void;
  addEntryFn?: (index: PaperIndex, entry: PaperIndexEntry) => PaperIndex;
  removeEntryFn?: (index: PaperIndex, uuid: string) => PaperIndex;
  commitAndPushFn?: (repoDir: string, message: string) => void;
  extractFn?: (opts: { pdfPath: string; outputDir: string }) => ExtractionResult;
  /** Marker extraction — tried before extractFn. Return null to skip (Marker not available). */
  extractWithMarkerFn?: (opts: { pdfPath: string; outputDir: string }) => ExtractionResult | null;
  splitFn?: (opts: { pdfPath: string; outputDir: string }) => SplitResult;
  uuidFn?: () => string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine the single best label for extractionMethod from a full result.
 * Uses the method that won on the most pages. Falls back to 'failed' / 'unsupported-format'.
 */
export function dominantExtractionMethod(extraction: ExtractionResult): string {
  if (!extraction.ok) {
    return extraction.error === 'unsupported-format' ? 'unsupported-format' : 'failed';
  }
  if (extraction.pages.length === 0) return extraction.availableMethods[0] ?? 'unknown';
  const counts: Record<string, number> = {};
  for (const p of extraction.pages) {
    counts[p.method] = (counts[p.method] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ── storePaper ────────────────────────────────────────────────────────────────

/**
 * Build the default pullRepoFn: calls prepareRepo, checks the return value
 * (which never throws but returns { ok: false } on failure), and converts a
 * "not a git repository" result into a user-friendly init hint.
 */
function defaultPullRepoFn(dir: string): void {
  const result = pullRepo(dir);
  if (!result.ok) {
    if (/not a git repository|no such file/i.test(result.stderr)) {
      throw new Error(
        `Repo not initialized at ${dir}. Run: paper-storage init --path ${dir} --create`,
      );
    }
    throw new Error(`git pull failed: ${result.stderr.trim() || 'unknown error'}`);
  }
}

/**
 * Store a paper in the paper-storage repo.
 *
 * Pipeline:
 *   pullRepo → uniqueness check → (force: delete old) → UUID → mkdir → copy/split
 *   → extractText → metadata.json → writeIndex → commitAndPush
 */
export function storePaper(opts: {
  path: string;
  name: string;
  year: number;
  /** PDF file. Alias: `file` (backward compat). At least one of pdf/file/txt required. */
  pdf?: string;
  /** Backward-compat alias for `pdf`. */
  file?: string;
  /** Pre-extracted text file. When provided, skips extraction entirely. */
  txt?: string;
  doi?: string;
  title?: string;
  force?: boolean;
  _deps?: StorePaperDeps;
}): StorePaperResult {
  const deps = opts._deps ?? {};
  const existsSyncFn    = deps.existsSyncFn    ?? existsSync;
  const statSyncFn      = deps.statSyncFn      ?? ((p: string) => statSync(p));
  const mkdirSyncFn     = deps.mkdirSyncFn     ?? ((p: string, o?: { recursive?: boolean }) => mkdirSync(p, { recursive: true, ...o }));
  const copyFileSyncFn  = deps.copyFileSyncFn  ?? copyFileSync;
  const writeFileSyncFn = deps.writeFileSyncFn ?? ((p: string, c: string) => writeFileSync(p, c, 'utf-8'));
  const readFileSyncFn  = deps.readFileSyncFn  ?? ((p: string) => readFileSync(p, 'utf-8'));
  const rmSyncFn        = deps.rmSyncFn        ?? ((p: string, o?: { recursive?: boolean; force?: boolean }) => rmSync(p, { recursive: true, force: true, ...o }));
  const pullRepoFn      = deps.pullRepoFn ?? defaultPullRepoFn;
  const readIndexFn     = deps.readIndexFn     ?? readIndex;
  const writeIndexFn    = deps.writeIndexFn    ?? writeIndex;
  const addEntryFn      = deps.addEntryFn      ?? addEntry;
  const removeEntryFn   = deps.removeEntryFn   ?? removeEntry;
  const commitAndPushFn = deps.commitAndPushFn ?? ((dir: string, msg: string) => commitAndPush(dir, msg));
  const extractFn           = deps.extractFn           ?? extractPdfText;
  const extractWithMarkerFn = deps.extractWithMarkerFn ?? extractWithMarker;
  const splitFn             = deps.splitFn             ?? splitPdfIfNeeded;
  const uuidFn              = deps.uuidFn              ?? randomUUID;

  // ── Validate inputs ──────────────────────────────────────────────────────
  const repoDir  = resolvePaperStorageRepoDir(opts.path);
  const name     = String(opts.name || '').trim();
  const year     = Number(opts.year);

  // pdf / file are aliases — resolve to a single pdfFile
  if (opts.pdf && opts.file) throw new Error('--pdf and --file are aliases; provide only one.');
  const pdfFile = (String(opts.pdf || opts.file || '').trim()) || undefined;
  const txtFile = (String(opts.txt || '').trim()) || undefined;

  if (!name)    throw new Error('Missing --name');
  if (!Number.isFinite(year)) throw new Error('--year must be a number');
  if (!pdfFile && !txtFile) throw new Error('Provide --pdf/--file (PDF) and/or --txt (extracted text).');
  if (pdfFile  && !existsSyncFn(pdfFile)) throw new Error(`File not found: ${pdfFile}`);
  if (txtFile  && !existsSyncFn(txtFile)) throw new Error(`File not found: ${txtFile}`);

  // ── Pull latest ──────────────────────────────────────────────────────────
  pullRepoFn(repoDir);

  // ── Uniqueness check ─────────────────────────────────────────────────────
  let index = readIndexFn(repoDir);
  let existingUuid: string | undefined;

  const nameCollision = index.byName[name];
  if (nameCollision) {
    if (!opts.force) throw new Error(`Name '${name}' already stored (uuid=${nameCollision}). Use --force.`);
    existingUuid = nameCollision;
  }

  if (opts.doi) {
    const doiCollision = index.byDoi[opts.doi];
    if (doiCollision && doiCollision !== existingUuid) {
      if (!opts.force) {
        throw new Error(`DOI '${opts.doi}' already stored (uuid=${doiCollision}). Use --force.`);
      }
      // --force but name and doi point to different entries — ambiguous; refuse
      if (existingUuid) {
        throw new Error(
          `Cannot --force: name '${name}' (uuid=${existingUuid}) and doi '${opts.doi}' (uuid=${doiCollision}) belong to different stored entries. Correct them with 'paper-storage move' first.`,
        );
      }
      existingUuid = doiCollision;
    }
  }

  // ── Force: remove old folder and index entry ─────────────────────────────
  const uuid = existingUuid ?? uuidFn();
  if (existingUuid) {
    const oldFolder = join(repoDir, 'papers', existingUuid);
    if (existsSyncFn(oldFolder)) rmSyncFn(oldFolder);
    index = removeEntryFn(index, existingUuid);
  }

  // ── Create paper directory ────────────────────────────────────────────────
  const paperDir = join(repoDir, 'papers', uuid);
  mkdirSyncFn(paperDir, { recursive: true });

  // ── Store the PDF (if provided) ───────────────────────────────────────────
  let splitResult: SplitResult = { split: false, partCount: 0, partPaths: [] };
  if (pdfFile) {
    splitResult = splitFn({ pdfPath: pdfFile, outputDir: join(paperDir, 'parts') });
    if (!splitResult.split) {
      copyFileSyncFn(pdfFile, join(paperDir, 'original.pdf'));
    }
  }

  // ── Extract / obtain text ─────────────────────────────────────────────────
  let extractResult: ExtractionResult;
  let markerTried = false;
  let markerError: string | undefined;
  let fallbackUsed = false;

  if (txtFile) {
    // User provided pre-extracted text — copy directly, skip extraction
    const content = readFileSyncFn(txtFile);
    writeFileSyncFn(join(paperDir, 'full.txt'), content);
    extractResult = {
      ok: true,
      pageCount: 0,
      availableMethods: ['provided'],
      pages: [],
      overallScore: 0.9,  // assume user-supplied text is good
      lowQualityPages: [],
    };
  } else if (pdfFile) {
    // PDF only — try Marker first, fall back to Python pipeline
    const markerResult = extractWithMarkerFn({ pdfPath: pdfFile, outputDir: paperDir });
    markerTried = markerResult !== null;
    if (markerResult?.ok) {
      extractResult = markerResult;
    } else {
      if (markerResult && !markerResult.ok) markerError = markerResult.error;
      fallbackUsed = true;
      extractResult = extractFn({ pdfPath: pdfFile, outputDir: paperDir });
    }
  } else {
    // Should be unreachable (validated above)
    throw new Error('Internal error: no input file');
  }

  // ── Write metadata.json ───────────────────────────────────────────────────
  const sourceFile = pdfFile ?? txtFile!;
  const { size: originalSizeBytes } = statSyncFn(sourceFile);
  const storedAt = new Date().toISOString();
  const metadata: PaperMetadata = {
    uuid,
    name,
    year,
    storedAt,
    originalFilename: basename(sourceFile),
    originalSizeBytes,
    split: splitResult.split,
    partCount: splitResult.partCount,
    pageCount: extractResult.pageCount,
    extractionMethod: dominantExtractionMethod(extractResult),
    overallScore: extractResult.overallScore,
    lowQualityPages: extractResult.lowQualityPages,
  };
  if (opts.doi)   metadata.doi   = opts.doi;
  if (opts.title) metadata.title = opts.title;
  if (pdfFile && !txtFile) {
    metadata.markerTried = markerTried;
    metadata.fallbackUsed = fallbackUsed;
    if (markerError) metadata.markerError = markerError;
  }

  writeFileSyncFn(join(paperDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  // ── Update index ──────────────────────────────────────────────────────────
  const entry: PaperIndexEntry = { uuid, name, year, storedAt };
  if (opts.doi) entry.doi = opts.doi;
  index = addEntryFn(index, entry);
  writeIndexFn(repoDir, index);

  // ── Commit and push ───────────────────────────────────────────────────────
  const doiTag = opts.doi ? ` (${opts.doi})` : '';
  commitAndPushFn(repoDir, `store: ${name}${doiTag}`);

  return {
    uuid,
    name,
    doi: opts.doi,
    year,
    pageCount: metadata.pageCount,
    extractionMethod: metadata.extractionMethod,
    overallScore: metadata.overallScore,
    lowQualityPages: metadata.lowQualityPages,
    split: splitResult.split,
    partCount: splitResult.partCount,
  };
}

// ── retrievePaper ─────────────────────────────────────────────────────────────

export interface RetrievePaperResult {
  uuid: string;
  savedTo: string;
  sizeBytes: number;
}

export interface RetrievePaperDeps {
  pullRepoFn?: (repoDir: string) => void;
  readIndexFn?: (repoDir: string) => PaperIndex;
  existsSyncFn?: (p: string) => boolean;
  mkdirSyncFn?: (p: string, opts?: { recursive?: boolean }) => void;
  copyFileSyncFn?: (src: string, dst: string) => void;
  statSyncFn?: (p: string) => { size: number };
  reassemblePdfFn?: (opts: { partsDir: string; outputPath: string }) => void;
}

/**
 * Retrieve a stored paper (original PDF or extracted text) and save it to a
 * local path. Looks up the entry by --uuid, --doi, or --name (first provided).
 *
 * For split papers (>90MB originals), the original PDF is reassembled from
 * parts on the fly and written directly to saveAt.
 */
export function retrievePaper(opts: {
  path: string;
  uuid?: string;
  doi?: string;
  name?: string;
  retrieve: 'original' | 'text';
  saveAt: string;
  _deps?: RetrievePaperDeps;
}): RetrievePaperResult {
  const deps = opts._deps ?? {};
  const pullRepoFn     = deps.pullRepoFn ?? defaultPullRepoFn;
  const readIndexFn    = deps.readIndexFn    ?? readIndex;
  const existsSyncFn   = deps.existsSyncFn   ?? existsSync;
  const mkdirSyncFn    = deps.mkdirSyncFn    ?? ((p: string, o?: { recursive?: boolean }) => mkdirSync(p, { recursive: true, ...o }));
  const copyFileSyncFn = deps.copyFileSyncFn ?? copyFileSync;
  const statSyncFn     = deps.statSyncFn     ?? ((p: string) => statSync(p));
  const reassemblePdfFn = deps.reassemblePdfFn ?? reassemblePdf;

  // ── Validate inputs ──────────────────────────────────────────────────────
  const repoDir = resolvePaperStorageRepoDir(opts.path);
  const saveAt  = String(opts.saveAt || '').trim();
  if (!saveAt)   throw new Error('Missing --save-at');
  if (!opts.uuid && !opts.doi && !opts.name) {
    throw new Error('Provide --uuid, --doi, or --name.');
  }

  // ── Pull + resolve ───────────────────────────────────────────────────────
  pullRepoFn(repoDir);
  const index = readIndexFn(repoDir);
  const uuid = resolveUuid(index, { uuid: opts.uuid, doi: opts.doi, name: opts.name });
  if (!uuid) {
    const key = opts.uuid ? `uuid=${opts.uuid}` : opts.doi ? `doi=${opts.doi}` : `name=${opts.name}`;
    throw new Error(`Paper not found: ${key}`);
  }

  const paperDir = join(repoDir, 'papers', uuid);
  mkdirSyncFn(dirname(saveAt), { recursive: true });

  // ── Retrieve text ────────────────────────────────────────────────────────
  if (opts.retrieve === 'text') {
    const fullTxtPath = join(paperDir, 'full.txt');
    if (!existsSyncFn(fullTxtPath)) throw new Error(`Extracted text not found for uuid=${uuid}`);
    copyFileSyncFn(fullTxtPath, saveAt);
    return { uuid, savedTo: saveAt, sizeBytes: statSyncFn(fullTxtPath).size };
  }

  // ── Retrieve original — single file ─────────────────────────────────────
  const originalPath = join(paperDir, 'original.pdf');
  if (existsSyncFn(originalPath)) {
    copyFileSyncFn(originalPath, saveAt);
    return { uuid, savedTo: saveAt, sizeBytes: statSyncFn(originalPath).size };
  }

  // ── Retrieve original — split paper (reassemble from parts) ──────────────
  const partsDir = join(paperDir, 'parts');
  if (existsSyncFn(partsDir)) {
    reassemblePdfFn({ partsDir, outputPath: saveAt });
    return { uuid, savedTo: saveAt, sizeBytes: statSyncFn(saveAt).size };
  }

  throw new Error(`Original file not found for uuid=${uuid} (neither original.pdf nor parts/ exist)`);
}

// ── movePaper ─────────────────────────────────────────────────────────────────

export interface MovePaperResult {
  uuid: string;
  previousName: string;
  newName: string;
  previousDoi?: string;
  newDoi?: string;
}

export interface MovePaperDeps {
  pullRepoFn?: (repoDir: string) => void;
  readIndexFn?: (repoDir: string) => PaperIndex;
  writeIndexFn?: (repoDir: string, index: PaperIndex) => void;
  updateEntryFn?: (index: PaperIndex, uuid: string, changes: UpdateEntryChanges) => PaperIndex;
  readFileSyncFn?: (p: string) => string;
  writeFileSyncFn?: (p: string, content: string) => void;
  existsSyncFn?: (p: string) => boolean;
  commitAndPushFn?: (repoDir: string, message: string) => void;
}

/**
 * Correct metadata for a stored paper without changing its UUID.
 * Rekeys byName / byDoi in the index when name or doi change.
 * Updates metadata.json in the paper folder.
 * At least one of newName / newDoi / newYear / newTitle / removeDoi must be provided.
 */
export function movePaper(opts: {
  path: string;
  uuid?: string;
  doi?: string;
  name?: string;
  newName?: string;
  newDoi?: string;
  newYear?: number;
  newTitle?: string;
  removeDoi?: boolean;
  _deps?: MovePaperDeps;
}): MovePaperResult {
  const deps = opts._deps ?? {};
  const pullRepoFn     = deps.pullRepoFn ?? defaultPullRepoFn;
  const readIndexFn    = deps.readIndexFn    ?? readIndex;
  const writeIndexFn   = deps.writeIndexFn   ?? writeIndex;
  const updateEntryFn  = deps.updateEntryFn  ?? updateEntry;
  const readFileSyncFn = deps.readFileSyncFn ?? ((p: string) => readFileSync(p, 'utf-8'));
  const writeFileSyncFn = deps.writeFileSyncFn ?? ((p: string, c: string) => writeFileSync(p, c, 'utf-8'));
  const existsSyncFn   = deps.existsSyncFn   ?? existsSync;
  const commitAndPushFn = deps.commitAndPushFn ?? ((dir: string, msg: string) => commitAndPush(dir, msg));

  // ── Validate inputs ──────────────────────────────────────────────────────
  const repoDir = resolvePaperStorageRepoDir(opts.path);
  if (!opts.uuid && !opts.doi && !opts.name) throw new Error('Provide --uuid, --doi, or --name.');

  const hasChange = opts.newName !== undefined
    || opts.newDoi !== undefined
    || opts.newYear !== undefined
    || opts.newTitle !== undefined
    || opts.removeDoi === true;
  if (!hasChange) throw new Error('Provide at least one change: --new-name, --new-doi, --new-year, --new-title, or --remove-doi.');

  if (opts.newDoi !== undefined && opts.removeDoi === true) {
    throw new Error('--new-doi and --remove-doi are mutually exclusive.');
  }
  if (opts.newYear !== undefined && !Number.isFinite(opts.newYear)) {
    throw new Error('--new-year must be a finite number.');
  }

  // ── Pull + resolve ───────────────────────────────────────────────────────
  pullRepoFn(repoDir);
  let index = readIndexFn(repoDir);
  const uuid = resolveUuid(index, { uuid: opts.uuid, doi: opts.doi, name: opts.name });
  if (!uuid) {
    const key = opts.uuid ? `uuid=${opts.uuid}` : opts.doi ? `doi=${opts.doi}` : `name=${opts.name}`;
    throw new Error(`Paper not found: ${key}`);
  }

  if (!Object.prototype.hasOwnProperty.call(index.byUuid, uuid)) throw new Error(`Paper not found: uuid=${uuid}`);
  const existing = index.byUuid[uuid];

  const previousName = existing.name;
  const previousDoi  = existing.doi;

  // ── Build index changes ──────────────────────────────────────────────────
  const indexChanges: UpdateEntryChanges = {};
  if (opts.newName  !== undefined) indexChanges.name = opts.newName;
  if (opts.newYear  !== undefined) indexChanges.year = opts.newYear;
  if (opts.removeDoi === true)     indexChanges.doi  = null;
  else if (opts.newDoi !== undefined) indexChanges.doi = opts.newDoi;

  // updateEntry validates uniqueness and rekeys byName/byDoi
  if (Object.keys(indexChanges).length > 0) {
    index = updateEntryFn(index, uuid, indexChanges);
  }
  writeIndexFn(repoDir, index);

  // ── Update metadata.json ─────────────────────────────────────────────────
  const metaPath = join(repoDir, 'papers', uuid, 'metadata.json');
  if (existsSyncFn(metaPath)) {
    let meta: PaperMetadata;
    try {
      meta = JSON.parse(readFileSyncFn(metaPath)) as PaperMetadata;
    } catch {
      meta = {} as PaperMetadata;
    }
    if (opts.newName  !== undefined) meta.name  = opts.newName;
    if (opts.newYear  !== undefined) meta.year  = opts.newYear;
    if (opts.newTitle !== undefined) meta.title = opts.newTitle;
    if (opts.removeDoi === true)     delete meta.doi;
    else if (opts.newDoi !== undefined) meta.doi = opts.newDoi;
    writeFileSyncFn(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }

  // ── Commit and push ───────────────────────────────────────────────────────
  const newName = opts.newName ?? previousName;
  commitAndPushFn(repoDir, `move: ${previousName} → ${newName}`);

  const updatedEntry = index.byUuid[uuid];
  return {
    uuid,
    previousName,
    newName,
    previousDoi,
    newDoi: updatedEntry.doi,
  };
}

// ── listPapers ────────────────────────────────────────────────────────────────

export interface ListPapersEntry {
  uuid: string;
  name: string;
  year: number;
  doi?: string;
  storedAt: string;
}

export interface ListPapersDeps {
  pullRepoFn?: (repoDir: string) => void;
  readIndexFn?: (repoDir: string) => PaperIndex;
}

/**
 * List all stored papers, sorted by name.
 */
export function listPapers(opts: {
  path: string;
  _deps?: ListPapersDeps;
}): ListPapersEntry[] {
  const deps = opts._deps ?? {};
  const pullRepoFn  = deps.pullRepoFn ?? defaultPullRepoFn;
  const readIndexFn = deps.readIndexFn ?? readIndex;

  const repoDir = resolvePaperStorageRepoDir(opts.path);

  pullRepoFn(repoDir);
  const index = readIndexFn(repoDir);

  return Object.entries(index.byUuid)
    .map(([uuid, value]) => ({ uuid, ...value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
