import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { Command } from 'commander';
import {
  DEFAULT_BACKGROUND_WORKTREE_BRANCH,
  detectGitRepository,
  getBackgroundWorktreePath,
  getWorktreeSummary,
} from '../infra/git.js';
import { inspectCycleLock } from '../infra/lock.js';
import { readJsonFile } from '../infra/json.js';
import { discoverPowerShellExecutable, detectCodexProcess, getPowerShellVersion } from '../infra/process.js';
import { readTomlFile } from '../infra/toml.js';
import type { DiagnosticIssue, FileSnapshot, WorktreeSummary } from '../infra/types.js';
import {
  blockersSchema,
  goalsSchema,
  proposalsSchema,
  resultsSchema,
  settingsSchema,
  stateSchema,
  tasksSchema,
} from '../schemas/index.js';
import { resolveRepoPaths } from '../shared/paths.js';
import type {
  AutonomyResults,
  AutonomySettings,
  AutonomyState,
  BlockersDocument,
  GoalsDocument,
  ProposalsDocument,
  TasksDocument,
} from '../contracts/autonomy.js';

export interface DoctorOptions {
  workspaceRoot?: string;
  staleLockAfterMs?: number;
}

export interface DoctorReport {
  ok: boolean;
  workspaceRoot: string;
  git: {
    repository: boolean;
    root: string | null;
    head: string | null;
    dirty: boolean;
    backgroundBranch: string;
    backgroundPath: string | null;
    backgroundWorktree: WorktreeSummary | null;
  };
  node: {
    version: string;
  };
  powershell: {
    executable: string | null;
    version: string | null;
  };
  codexProcess: {
    running: boolean;
    matches: string[];
    probeOk: boolean;
    error?: string;
  };
  lock: {
    path: string;
    exists: boolean;
    stale: boolean;
    reason?: string;
  };
  files: FileSnapshot[];
  issues: DiagnosticIssue[];
}

const REQUIRED_PATHS: Array<{ path: string; kind: 'file' | 'directory'; required: boolean }> = [
  { path: 'AGENTS.md', kind: 'file', required: true },
  { path: '.codex', kind: 'directory', required: true },
  { path: '.codex/environments/environment.toml', kind: 'file', required: true },
  { path: '.codex/config.toml', kind: 'file', required: true },
  { path: 'scripts/setup.windows.ps1', kind: 'file', required: true },
  { path: 'scripts/verify.ps1', kind: 'file', required: true },
  { path: 'scripts/smoke.ps1', kind: 'file', required: true },
  { path: 'scripts/review.ps1', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-plan/SKILL.md', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-work/SKILL.md', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-intake/SKILL.md', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-review/SKILL.md', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-report/SKILL.md', kind: 'file', required: true },
  { path: '.agents/skills/$autonomy-sprint/SKILL.md', kind: 'file', required: true },
  { path: 'autonomy/goal.md', kind: 'file', required: true },
  { path: 'autonomy/journal.md', kind: 'file', required: true },
  { path: 'autonomy/goals.json', kind: 'file', required: true },
  { path: 'autonomy/proposals.json', kind: 'file', required: true },
  { path: 'autonomy/tasks.json', kind: 'file', required: true },
  { path: 'autonomy/state.json', kind: 'file', required: true },
  { path: 'autonomy/settings.json', kind: 'file', required: true },
  { path: 'autonomy/results.json', kind: 'file', required: true },
  { path: 'autonomy/blockers.json', kind: 'file', required: true },
  { path: 'autonomy/schema', kind: 'directory', required: true },
  { path: 'autonomy/schema/goals.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/proposals.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/tasks.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/state.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/settings.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/results.schema.json', kind: 'file', required: true },
  { path: 'autonomy/schema/blockers.schema.json', kind: 'file', required: true },
];

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const issues: DiagnosticIssue[] = [];
  const files: FileSnapshot[] = [];
  const gitRepo = await detectGitRepository(workspaceRoot);
  const controlRoot = gitRepo?.path ?? workspaceRoot;
  const repoPaths = resolveRepoPaths(controlRoot);
  const backgroundPath = gitRepo ? getBackgroundWorktreePath(gitRepo.path) : null;

  const nodeVersion = process.version;
  const powershellExecutable = discoverPowerShellExecutable();
  const powershellVersion = powershellExecutable ? getPowerShellVersion(powershellExecutable) : null;
  const codexProcess = detectCodexProcess(powershellExecutable ?? undefined);
  const lockPath = join(controlRoot, 'autonomy', 'locks', 'cycle.lock');
  const lockInspection = await inspectCycleLock(lockPath, options.staleLockAfterMs);

  for (const entry of REQUIRED_PATHS) {
    const absolute = join(controlRoot, entry.path);
    const exists = await existsPath(absolute);
    files.push({
      path: absolute,
      exists,
      kind: exists ? entry.kind : undefined,
    });

    if (!exists && entry.required) {
      issues.push({
        severity: 'error',
        code: 'missing_required_path',
        message: `Missing required ${entry.kind}: ${entry.path}`,
        path: absolute,
      });
    }
  }

  if (!gitRepo) {
    issues.push({
      severity: 'warn',
      code: 'not_a_git_repo',
      message: 'Workspace is not a Git repository.',
      path: workspaceRoot,
    });
  } else if (gitRepo.dirty) {
    issues.push({
      severity: 'error',
      code: 'dirty_repository',
      message: 'Repository working tree is dirty.',
      path: gitRepo.path,
    });
  }

  let backgroundWorktree: WorktreeSummary | null = null;
  if (gitRepo && backgroundPath) {
    try {
      backgroundWorktree = await getWorktreeSummary(backgroundPath);
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'unsafe_background_worktree_path',
        message: error instanceof Error ? error.message : String(error),
        path: backgroundPath,
      });
    }

    if (!backgroundWorktree) {
      if (!issues.some((issue) => issue.code === 'unsafe_background_worktree_path')) {
        issues.push({
          severity: 'warn',
          code: 'missing_background_worktree',
          message: `Background worktree does not exist at ${backgroundPath}.`,
          path: backgroundPath,
        });
      }
    } else if (backgroundWorktree.dirty) {
      issues.push({
        severity: 'error',
        code: 'dirty_background_worktree',
        message: `Background worktree at ${backgroundPath} is dirty.`,
        path: backgroundPath,
      });
    } else if (backgroundWorktree.commonGitDir !== gitRepo.commonGitDir) {
      issues.push({
        severity: 'warn',
        code: 'unexpected_background_repo',
        message: `Background worktree belongs to ${backgroundWorktree.commonGitDir}, expected ${gitRepo.commonGitDir}.`,
        path: backgroundPath,
      });
    } else if (backgroundWorktree.branch !== DEFAULT_BACKGROUND_WORKTREE_BRANCH) {
      issues.push({
        severity: 'warn',
        code: 'unexpected_background_branch',
        message: `Background worktree is on ${backgroundWorktree.branch ?? 'detached HEAD'}, expected ${DEFAULT_BACKGROUND_WORKTREE_BRANCH}.`,
        path: backgroundPath,
      });
    }
  }

  if (!powershellExecutable) {
    issues.push({
      severity: 'error',
      code: 'powershell_not_found',
      message: 'PowerShell executable was not found. Expected pwsh or powershell.',
    });
  }

  if (!codexProcess.probeOk) {
    issues.push({
      severity: 'warn',
      code: 'codex_process_probe_failed',
      message: codexProcess.error ?? 'Codex process probe failed.',
    });
  } else if (!codexProcess.running) {
    issues.push({
      severity: 'warn',
      code: 'codex_not_running',
      message: 'No Codex-related process was detected.',
    });
  }

  if (lockInspection.exists && lockInspection.stale) {
    issues.push({
      severity: 'warn',
      code: 'stale_cycle_lock',
      message: lockInspection.reason ?? 'Cycle lock appears stale.',
      path: lockPath,
    });
  }

  if (lockInspection.exists && !lockInspection.stale) {
    issues.push({
      severity: 'info',
      code: 'active_cycle_lock',
      message: 'Cycle lock is active.',
      path: lockPath,
    });
  } else if (!lockInspection.exists) {
    issues.push({
      severity: 'info',
      code: 'cycle_lock_absent',
      message: 'Cycle lock is not present.',
      path: lockPath,
    });
  }

  await validateAutonomyDocuments(repoPaths, issues);
  await validateCodexConfig(repoPaths.configFile, issues);

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    workspaceRoot,
    git: {
      repository: Boolean(gitRepo),
      root: gitRepo?.path ?? null,
      head: gitRepo?.head ?? null,
      dirty: gitRepo?.dirty ?? false,
      backgroundBranch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      backgroundPath,
      backgroundWorktree,
    },
    node: {
      version: nodeVersion,
    },
    powershell: {
      executable: powershellExecutable,
      version: powershellVersion,
    },
    codexProcess: {
      running: codexProcess.running,
      matches: codexProcess.matches,
      probeOk: codexProcess.probeOk,
      error: codexProcess.error,
    },
    lock: {
      path: lockPath,
      exists: lockInspection.exists,
      stale: lockInspection.stale,
      reason: lockInspection.reason,
    },
    files,
    issues,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${report.workspaceRoot}`);
  lines.push(`Node: ${report.node.version}`);
  lines.push(`Git repo: ${report.git.repository ? report.git.root ?? '(unknown root)' : 'no'}`);
  lines.push(`PowerShell: ${report.powershell.executable ?? 'missing'}${report.powershell.version ? ` ${report.powershell.version}` : ''}`);
  lines.push(
    `Codex process: ${
      report.codexProcess.probeOk
        ? (report.codexProcess.running ? report.codexProcess.matches.join(', ') : 'not detected')
        : `probe failed${report.codexProcess.error ? ` (${report.codexProcess.error})` : ''}`
    }`,
  );
  lines.push(`Cycle lock: ${report.lock.exists ? (report.lock.stale ? `stale (${report.lock.reason ?? 'unknown reason'})` : 'present') : 'absent'}`);
  lines.push(`Background worktree: ${report.git.backgroundPath ?? 'n/a'}`);
  lines.push(`Status: ${report.ok ? 'ok' : 'attention needed'}`);

  for (const issue of report.issues) {
    lines.push(`[${issue.severity}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`);
  }

  return `${lines.join('\n')}\n`;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .option('--workspace-root <path>', 'Workspace root to inspect')
    .option('--stale-lock-after-ms <ms>', 'Lock age threshold before it is considered stale', (value) => Number(value))
    .description('Inspect the Codex autonomy workspace, repo state, and worktree health')
    .action(async (options: { workspaceRoot?: string; staleLockAfterMs?: number }) => {
      const result = await runDoctor({
        workspaceRoot: options.workspaceRoot,
        staleLockAfterMs: options.staleLockAfterMs,
      });
      console.log(formatDoctorReport(result));
    });
}

async function validateCodexConfig(configPath: string, issues: DiagnosticIssue[]): Promise<void> {
  if (!(await existsPath(configPath))) {
    return;
  }

  let config: Awaited<ReturnType<typeof readTomlFile>>;
  try {
    config = await readTomlFile(configPath);
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'config_toml_invalid',
      message: error instanceof Error ? error.message : String(error),
      path: configPath,
    });
    return;
  }

  const approvalPolicy = readTomlString(config, ['approval_policy']);
  const sandboxMode = readTomlString(config, ['sandbox_mode']);
  const workspaceNetworkAccess = readTomlValue(config, ['sandbox_workspace_write', 'network_access']);
  const windowsSandbox = readTomlString(config, ['windows', 'sandbox']);

  if (!['untrusted', 'on-request', 'never'].includes(approvalPolicy ?? '')) {
    issues.push({
      severity: 'error',
      code: 'config_toml_invalid',
      message: 'config.toml must define a valid top-level approval_policy.',
      path: configPath,
    });
  }

  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandboxMode ?? '')) {
    issues.push({
      severity: 'error',
      code: 'config_toml_invalid',
      message: 'config.toml must define a valid top-level sandbox_mode.',
      path: configPath,
    });
  }

  if (typeof workspaceNetworkAccess !== 'boolean') {
    issues.push({
      severity: 'error',
      code: 'config_toml_invalid',
      message: 'config.toml must define sandbox_workspace_write.network_access as a boolean.',
      path: configPath,
    });
  }

  if (!['unelevated', 'elevated'].includes(windowsSandbox ?? '')) {
    issues.push({
      severity: 'error',
      code: 'config_toml_invalid',
      message: 'config.toml must define windows.sandbox as elevated or unelevated.',
      path: configPath,
    });
  }

  if (approvalPolicy === 'never') {
    issues.push({
      severity: 'warn',
      code: 'config_toml_high_risk_approval_policy',
      message: 'config.toml uses approval_policy=never. This enables unattended execution without approval prompts.',
      path: configPath,
    });
  }

  if (sandboxMode === 'danger-full-access') {
    issues.push({
      severity: 'warn',
      code: 'config_toml_high_risk_sandbox_mode',
      message: 'config.toml uses sandbox_mode=danger-full-access. This allows unrestricted filesystem access.',
      path: configPath,
    });
  }
}

function readTomlValue(document: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = document;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
    if (current === undefined) {
      return undefined;
    }
  }

  return current;
}

function readTomlString(document: Record<string, unknown>, path: string[]): string | null {
  const value = readTomlValue(document, path);
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function existsPath(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateAutonomyDocuments(
  repoPaths: ReturnType<typeof resolveRepoPaths>,
  issues: DiagnosticIssue[],
): Promise<void> {
  const Ajv2020 = (Ajv2020Module as unknown as { default?: new (options: Record<string, unknown>) => any }).default
    ?? (Ajv2020Module as unknown as new (options: Record<string, unknown>) => any);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });

  const documentSpecs: Array<{
    path: string;
    code: string;
    schema: object;
    load: () => Promise<unknown>;
  }> = [
    {
      path: repoPaths.goalsFile,
      code: 'goals_schema_invalid',
      schema: goalsSchema,
      load: () => readJsonFile<GoalsDocument>(repoPaths.goalsFile),
    },
    {
      path: repoPaths.proposalsFile,
      code: 'proposals_schema_invalid',
      schema: proposalsSchema,
      load: () => readJsonFile<ProposalsDocument>(repoPaths.proposalsFile),
    },
    {
      path: repoPaths.tasksFile,
      code: 'tasks_schema_invalid',
      schema: tasksSchema,
      load: () => readJsonFile<TasksDocument>(repoPaths.tasksFile),
    },
    {
      path: repoPaths.stateFile,
      code: 'state_schema_invalid',
      schema: stateSchema,
      load: () => readJsonFile<AutonomyState>(repoPaths.stateFile),
    },
    {
      path: repoPaths.settingsFile,
      code: 'settings_schema_invalid',
      schema: settingsSchema,
      load: () => readJsonFile<AutonomySettings>(repoPaths.settingsFile),
    },
    {
      path: repoPaths.resultsFile,
      code: 'results_schema_invalid',
      schema: resultsSchema,
      load: () => readJsonFile<AutonomyResults>(repoPaths.resultsFile),
    },
    {
      path: repoPaths.blockersFile,
      code: 'blockers_schema_invalid',
      schema: blockersSchema,
      load: () => readJsonFile<BlockersDocument>(repoPaths.blockersFile),
    },
  ];

  for (const spec of documentSpecs) {
    if (!(await existsPath(spec.path))) {
      continue;
    }

    let data: unknown;
    try {
      data = await spec.load();
    } catch (error) {
      issues.push({
        severity: 'error',
        code: spec.code,
        message: error instanceof Error ? error.message : String(error),
        path: spec.path,
      });
      continue;
    }

    const validate = ajv.compile(spec.schema);
    if (!validate(data)) {
      issues.push({
        severity: 'error',
        code: spec.code,
        message: ajv.errorsText(validate.errors, { separator: '; ' }),
        path: spec.path,
      });
    }
  }
}
