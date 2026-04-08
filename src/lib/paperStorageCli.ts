export const PAPER_STORAGE_COMMANDS = ['setup', 'init', 'store', 'retrieve', 'move', 'list'] as const;

export type PaperStorageCommand = typeof PAPER_STORAGE_COMMANDS[number];

export function getFlag(args: string[], name: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const flagIndex = args.indexOf(name);
  if (flagIndex === -1) return undefined;
  const value = args[flagIndex + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function isPaperStorageCommand(command: string | undefined): command is PaperStorageCommand {
  return !!command && PAPER_STORAGE_COMMANDS.includes(command as PaperStorageCommand);
}

export function getPaperStorageUsage(): string {
  return `Usage: paper-storage <${PAPER_STORAGE_COMMANDS.join('|')}> [flags]`;
}
