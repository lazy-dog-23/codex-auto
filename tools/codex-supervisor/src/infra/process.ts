import { spawnSync } from 'node:child_process';
import { homedir, hostname as getHostname, userInfo } from 'node:os';
import type { CommandExecution } from './types.js';

export function buildCodexProcessDetectionScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$matches = Get-Process | Select-Object -ExpandProperty ProcessName | Where-Object { $_ -match "Codex|OpenAI" } | Sort-Object -Unique',
    '$matches',
  ].join('; ');
}

export function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): CommandExecution {
  const cwd = options?.cwd ?? process.cwd();
  const result = spawnSync(command, args, {
    cwd,
    env: options?.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  return {
    command,
    args,
    cwd,
    exitCode: result.status,
    stdout: result.stdout?.toString?.() ?? '',
    stderr: result.stderr?.toString?.() ?? '',
    error: result.error instanceof Error ? result.error.message : undefined,
  };
}

export function commandSucceeded(result: CommandExecution): boolean {
  return result.exitCode === 0 && !result.error;
}

export function discoverPowerShellExecutable(): string | null {
  for (const executable of ['pwsh', 'powershell']) {
    const probe = runProcess(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    if (commandSucceeded(probe) && probe.stdout.trim()) {
      return executable;
    }
  }

  return null;
}

export function getPowerShellVersion(executable: string): string | null {
  const probe = runProcess(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (!commandSucceeded(probe)) {
    return null;
  }

  const version = probe.stdout.trim();
  return version.length > 0 ? version : null;
}

export function detectCodexProcess(executable?: string): {
  running: boolean;
  matches: string[];
  executable: string | null;
  probeOk: boolean;
  error?: string;
} {
  const shell = executable ?? discoverPowerShellExecutable();
  if (!shell) {
    return { running: false, matches: [], executable: null, probeOk: false, error: 'PowerShell executable was not found.' };
  }

  const result = runProcess(shell, ['-NoProfile', '-Command', buildCodexProcessDetectionScript()]);
  if (!commandSucceeded(result)) {
    return {
      running: false,
      matches: [],
      executable: shell,
      probeOk: false,
      error: (result.error ?? result.stderr.trim()) || `exit code ${result.exitCode ?? 'unknown'}`,
    };
  }

  const matches = Array.from(new Set(result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)));

  return { running: matches.length > 0, matches, executable: shell, probeOk: true };
}

export function currentUserName(): string {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function currentHostname(): string {
  try {
    return getHostname();
  } catch {
    return 'unknown';
  }
}

export function currentHomeDir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}
