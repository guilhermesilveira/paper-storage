#!/usr/bin/env node
/**
 * Standalone CLI for paper-storage commands.
 * Imports only the paper-storage modules — no server/DB dependencies.
 *
 * Usage:
 *   paper-storage init     --path PATH [--create --repo-name NAME | --clone URL]
 *   paper-storage store    --path PATH --name NAME --year YEAR [--pdf FILE] [--file FILE] [--txt FILE] [--doi DOI] [--title TEXT] [--force] [--json]
 *   paper-storage retrieve --path PATH --uuid|--doi|--name KEY --retrieve original|text --save-at PATH [--json]
 *   paper-storage move     --path PATH --uuid|--doi|--name KEY [--new-name X] [--new-doi X] [--new-year N] [--new-title X] [--remove-doi] [--json]
 *   paper-storage list     --path PATH [--json]
 */

import { listPapers, movePaper, retrievePaper, storePaper } from '../lib/paperStorage';
import { getFlag, getPaperStorageUsage, hasFlag, isPaperStorageCommand, type PaperStorageCommand } from '../lib/paperStorageCli';
import { checkRequiredTools, initPaperStorageRepo } from '../lib/paperStorageInit';
import { resolvePaperStorageRepoDir, setupPaperStorage } from '../lib/paperStorageSetup';

interface CommandContext {
  args: string[];
  asJson: boolean;
}

function writeToolCheck(toolCheck: ReturnType<typeof checkRequiredTools>) {
  const maxNameLen = Math.max(...toolCheck.tools.map((tool) => tool.name.length));
  for (const tool of toolCheck.tools) {
    const icon = tool.found ? '✓' : '✗';
    const version = tool.version ? ` (${tool.version})` : '';
    const hint = tool.found ? '' : `  → ${tool.installHint}`;
    process.stdout.write(`  ${icon} ${tool.name.padEnd(maxNameLen)}${version}${hint}\n`);
  }
}

function writeListEntries(entries: ReturnType<typeof listPapers>) {
  if (entries.length === 0) {
    process.stdout.write('No papers stored.\n');
    return;
  }

  const uuidW = 36;
  const nameW = 30;
  const yearW = 6;
  const header = `${'UUID'.padEnd(uuidW)}  ${'NAME'.padEnd(nameW)}  ${'YEAR'.padEnd(yearW)}  DOI`;
  process.stdout.write(`${header}\n${'─'.repeat(header.length)}\n`);
  for (const entry of entries) {
    process.stdout.write(
      `${entry.uuid.padEnd(uuidW)}  ${entry.name.padEnd(nameW)}  ${String(entry.year).padEnd(yearW)}  ${entry.doi ?? '—'}\n`,
    );
  }
}

function runSetupCommand({ asJson }: CommandContext) {
  process.stdout.write('Paper Storage Setup\n\n');
  const result = setupPaperStorage();

  for (const step of result.steps) {
    const icon = step.status === 'failed' ? '✗' : step.status === 'installed' ? '⬇' : '✓';
    process.stdout.write(`  ${icon} ${step.name.padEnd(16)} ${step.detail}\n`);
  }

  process.stdout.write('\n');
  if (result.ok) {
    process.stdout.write('All set! Extraction will use the managed venv automatically.\n');
    process.stdout.write(`  Home: ${result.home}\n`);
    process.stdout.write(`  Venv: ${result.venv}\n`);
  } else {
    process.stderr.write('Setup incomplete — fix the failed steps above and re-run.\n');
    process.exitCode = 1;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

function runInitCommand({ args, asJson }: CommandContext) {
  const repoPath = resolvePaperStorageRepoDir(getFlag(args, '--path'));
  const cloneUrl = String(getFlag(args, '--clone') || '').trim() || undefined;
  const repoName = String(getFlag(args, '--repo-name') || '').trim() || undefined;
  const doCreate = hasFlag(args, '--create');

  if (doCreate && cloneUrl) throw new Error('--create and --clone are mutually exclusive.');
  if (doCreate && !repoName) throw new Error('--create requires --repo-name NAME (the GitHub repo to create)');

  const toolCheck = checkRequiredTools();
  writeToolCheck(toolCheck);

  if (!toolCheck.ok) {
    const missing = toolCheck.tools.filter((tool) => !tool.found).map((tool) => tool.name).join(', ');
    if (asJson) {
      process.stdout.write(JSON.stringify({ ok: false, tools: toolCheck.tools }, null, 2) + '\n');
    } else {
      process.stderr.write(`\nMissing required tools: ${missing}\nInstall them and re-run.\n`);
    }
    process.exit(1);
  }

  process.stdout.write('\nAll required tools found.\n\n');

  if (!doCreate && !cloneUrl) {
    process.stdout.write(`Default repo path:       ${repoPath}\n`);
    process.stdout.write('To create a new repo:    paper-storage init [--path PATH] --create --repo-name NAME\n');
    process.stdout.write('To clone existing repo:  paper-storage init [--path PATH] --clone URL\n');
    return;
  }

  const mode = cloneUrl ? 'clone' : 'create';
  const result = initPaperStorageRepo(repoPath, mode, { cloneUrl, repoName });

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, mode, ...result, tools: toolCheck.tools }, null, 2) + '\n');
    return;
  }

  if (result.alreadyExists) {
    process.stdout.write(`Repo already initialized at ${result.path}\n`);
    return;
  }

  if (mode === 'clone') {
    process.stdout.write(`Cloned paper storage repo to ${result.path}\n`);
    return;
  }

  process.stdout.write(`Initialized paper storage repo at ${result.path}\n`);
  if (result.githubRepoCreated) {
    const name = repoName ?? 'paper-storage';
    process.stdout.write(`Private GitHub repo '${name}' created and pushed.\n`);
  }
}

function runStoreCommand({ args, asJson }: CommandContext) {
  const repoPath = resolvePaperStorageRepoDir(getFlag(args, '--path'));
  const name = String(getFlag(args, '--name') || '').trim();
  const yearRaw = String(getFlag(args, '--year') || '').trim();
  const pdf = String(getFlag(args, '--pdf') || '').trim() || undefined;
  const file = String(getFlag(args, '--file') || '').trim() || undefined;
  const txt = String(getFlag(args, '--txt') || '').trim() || undefined;
  const doi = String(getFlag(args, '--doi') || '').trim() || undefined;
  const title = String(getFlag(args, '--title') || '').trim() || undefined;
  const force = hasFlag(args, '--force');

  if (!name) throw new Error('Missing --name NAME');
  if (!yearRaw) throw new Error('Missing --year YEAR');
  if (!pdf && !file && !txt) throw new Error('Provide --pdf/--file (PDF) and/or --txt (extracted text).');
  if (pdf && file) throw new Error('--pdf and --file are aliases; provide only one.');

  const year = parseInt(yearRaw, 10);
  if (!Number.isFinite(year)) throw new Error('--year must be a number');

  const result = storePaper({ path: repoPath, name, year, pdf, file, txt, doi, title, force });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write(`uuid:   ${result.uuid}\n`);
  process.stdout.write(`name:   ${result.name}\n`);
  if (result.doi) process.stdout.write(`doi:    ${result.doi}\n`);
  process.stdout.write(`pages:  ${result.pageCount}\n`);
  process.stdout.write(`method: ${result.extractionMethod}\n`);
  process.stdout.write(`score:  ${result.overallScore}\n`);
  if (result.split) process.stdout.write(`parts:  ${result.partCount}\n`);
}

function runRetrieveCommand({ args, asJson }: CommandContext) {
  const repoPath = resolvePaperStorageRepoDir(getFlag(args, '--path'));
  const uuid = String(getFlag(args, '--uuid') || '').trim() || undefined;
  const doi = String(getFlag(args, '--doi') || '').trim() || undefined;
  const name = String(getFlag(args, '--name') || '').trim() || undefined;
  const retrieve = String(getFlag(args, '--retrieve') || '').trim();
  const saveAt = String(getFlag(args, '--save-at') || '').trim();

  if (!retrieve || !['original', 'text'].includes(retrieve)) {
    throw new Error('--retrieve must be "original" or "text"');
  }
  if (!saveAt) throw new Error('Missing --save-at PATH');
  if (!uuid && !doi && !name) throw new Error('Provide --uuid, --doi, or --name.');

  const result = retrievePaper({
    path: repoPath,
    uuid,
    doi,
    name,
    retrieve: retrieve as 'original' | 'text',
    saveAt,
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const kb = Math.round(result.sizeBytes / 1024);
  process.stdout.write(`Retrieved ${retrieve} → ${result.savedTo} (${kb} KB)\n`);
}

function runMoveCommand({ args, asJson }: CommandContext) {
  const repoPath = resolvePaperStorageRepoDir(getFlag(args, '--path'));
  const uuid = String(getFlag(args, '--uuid') || '').trim() || undefined;
  const doi = String(getFlag(args, '--doi') || '').trim() || undefined;
  const name = String(getFlag(args, '--name') || '').trim() || undefined;
  const newName = String(getFlag(args, '--new-name') || '').trim() || undefined;
  const newDoi = String(getFlag(args, '--new-doi') || '').trim() || undefined;
  const newYearRaw = String(getFlag(args, '--new-year') || '').trim();
  const newTitle = String(getFlag(args, '--new-title') || '').trim() || undefined;
  const removeDoi = hasFlag(args, '--remove-doi');
  const newYear = newYearRaw ? parseInt(newYearRaw, 10) : undefined;

  if (!uuid && !doi && !name) throw new Error('Provide --uuid, --doi, or --name.');
  if (newYear !== undefined && !Number.isFinite(newYear)) throw new Error('--new-year must be a number');

  const result = movePaper({ path: repoPath, uuid, doi, name, newName, newDoi, newYear, newTitle, removeDoi });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const doiPart = result.newDoi
    ? ` doi=${result.newDoi}`
    : (result.previousDoi && !result.newDoi ? ' doi=removed' : '');
  process.stdout.write(`${result.uuid}\t${result.previousName} → ${result.newName}${doiPart}\n`);
}

function runListCommand({ args, asJson }: CommandContext) {
  const repoPath = resolvePaperStorageRepoDir(getFlag(args, '--path'));

  const entries = listPapers({ path: repoPath });

  if (asJson) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  writeListEntries(entries);
}

const COMMAND_HANDLERS: Record<PaperStorageCommand, (context: CommandContext) => void> = {
  setup: runSetupCommand,
  init: runInitCommand,
  store: runStoreCommand,
  retrieve: runRetrieveCommand,
  move: runMoveCommand,
  list: runListCommand,
};

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const asJson = hasFlag(args, '--json');

  if (!isPaperStorageCommand(command)) {
    process.stderr.write(`${getPaperStorageUsage()}\n`);
    if (command) process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }

  COMMAND_HANDLERS[command]({ args, asJson });
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
