import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function buildCommandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    EDITOR: 'true',
    VISUAL: 'true',
    ...extra,
  };
}

export function spawnCommandSync(
  cmd: string,
  args: string[],
  options: SpawnSyncOptions = {},
): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    ...options,
    env: buildCommandEnv(options.env),
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    ...(result.error ? { error: result.error } : {}),
  };
}
