import { describe, expect, it } from 'vitest';

import { getFlag, getPaperStorageUsage, hasFlag, isPaperStorageCommand, PAPER_STORAGE_COMMANDS } from '../../src/lib/paperStorageCli';

describe('paperStorageCli helpers', () => {
  it('recognizes valid commands', () => {
    expect(PAPER_STORAGE_COMMANDS).toEqual(['setup', 'init', 'store', 'retrieve', 'move', 'list']);
    expect(isPaperStorageCommand('store')).toBe(true);
    expect(isPaperStorageCommand('bogus')).toBe(false);
    expect(isPaperStorageCommand(undefined)).toBe(false);
  });

  it('reads flags in inline and paired forms', () => {
    const args = ['--path', '/repo', '--name=paper-name', '--json'];
    expect(getFlag(args, '--path')).toBe('/repo');
    expect(getFlag(args, '--name')).toBe('paper-name');
    expect(getFlag(args, '--missing')).toBeUndefined();
    expect(hasFlag(args, '--json')).toBe(true);
    expect(hasFlag(args, '--force')).toBe(false);
  });

  it('formats the CLI usage line', () => {
    expect(getPaperStorageUsage()).toBe('Usage: paper-storage <setup|init|store|retrieve|move|list> [flags]');
  });
});
