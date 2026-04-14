import { existsSync } from 'node:fs';
import { homedir, hostname as getHostname, userInfo } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CommandExecution } from './types.js';

export function buildCodexProcessDetectionScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$allowed = @("codex", "openai.codex", "openai-codex")',
    '$matches = Get-Process | Where-Object { $allowed -contains $_.ProcessName.ToLowerInvariant() } | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique',
    '$matches',
  ].join('; ');
}

export function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): CommandExecution {
  const cwd = options?.cwd ?? process.cwd();
  const spawnOptions = {
    cwd,
    env: options?.env,
    encoding: 'utf8' as const,
    windowsHide: true,
    shell: false,
  };
  let result = spawnSync(command, args, spawnOptions);

  if (process.platform === 'win32' && !hasExplicitPath(command) && shouldRetryWithResolvedExecutable(result.error)) {
    const resolvedCommand = resolveWindowsExecutable(command, options?.env);
    if (resolvedCommand && resolvedCommand.toLowerCase() !== command.toLowerCase()) {
      result = spawnSync(resolvedCommand, args, spawnOptions);
    }
  }

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

export function isChildProcessSpawnBlocked(error: string | undefined): boolean {
  return typeof error === 'string' && /\b(?:EPERM|EACCES)\b/i.test(error);
}

export function discoverPowerShellExecutable(): string | null {
  for (const executable of ['pwsh', 'powershell']) {
    const probe = runProcess(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    if (commandSucceeded(probe) && probe.stdout.trim()) {
      return executable;
    }
  }

  if (process.platform === 'win32') {
    for (const executable of ['pwsh', 'powershell']) {
      const resolvedExecutable = resolveWindowsExecutable(executable);
      if (resolvedExecutable) {
        return resolvedExecutable;
      }
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
    const blockedMessage = isChildProcessSpawnBlocked(result.error)
      ? `Child process execution is blocked in this environment, so Codex process detection was skipped. ${result.error ?? ''}`.trim()
      : undefined;
    return {
      running: false,
      matches: [],
      executable: shell,
      probeOk: false,
      error: blockedMessage ?? ((result.error ?? result.stderr.trim()) || `exit code ${result.exitCode ?? 'unknown'}`),
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

function shouldRetryWithResolvedExecutable(error: Error | undefined): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\bENOENT\b/i.test(error.message) || isChildProcessSpawnBlocked(error.message);
}

function hasExplicitPath(command: string): boolean {
  return command.includes('\\') || command.includes('/') || isAbsolute(command);
}

function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const commandName = command.toLowerCase();
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const pathValue = pathKey ? env[pathKey] : process.env.Path;
  const searchDirectories = (pathValue ?? '')
    .split(delimiter)
    .map((entry) => entry.replace(/^\\\\\?\\/, '').trim())
    .filter(Boolean);
  const candidateNames = createWindowsCommandCandidates(commandName);

  for (const directory of searchDirectories) {
    for (const candidateName of candidateNames) {
      const candidatePath = join(directory, candidateName);
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }
  }

  for (const candidatePath of getKnownExecutableCandidates(commandName)) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function createWindowsCommandCandidates(command: string): string[] {
  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  if (hasExtension) {
    return [command];
  }

  return [
    `${command}.exe`,
    `${command}.cmd`,
    `${command}.bat`,
    `${command}.com`,
  ];
}

function getKnownExecutableCandidates(command: string): string[] {
  switch (command) {
    case 'pwsh':
      return [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
      ];
    case 'powershell':
      return [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ];
    case 'git':
      return [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
      ];
    default:
      return [];
  }
}
