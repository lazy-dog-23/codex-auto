import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { runProcess, commandSucceeded } from './process.js';
import { assertDirectPathBoundary, listDirectoryEntries, pathExists } from './json.js';
import { extractGitStatusPaths, normalizeGitStatusPath, probeWorktreeState } from './worktree-state.js';
import { isAutonomyRuntimeAllowlistedPath } from '../shared/paths.js';
import type { CommandExecution } from './types.js';
import type {
  BackgroundWorktreePreparation,
  GitRepositoryInfo,
  WorktreeSummary,
} from './types.js';

export const DEFAULT_BACKGROUND_WORKTREE_BRANCH = 'codex/background';
export const DEFAULT_AUTONOMY_BRANCH = 'codex/autonomy';
export const AUTONOMY_COMMIT_ALLOWLIST = [
  'AGENTS.md',
  '.agents/skills/',
  '.codex/',
  'autonomy/',
  'scripts/',
] as const;

export const AUTONOMY_COMMIT_AMBIENT_ALLOWLIST = [
  'AGENTS.override.md',
  'TEAM_GUIDE.md',
] as const;

export interface GitCommitGate {
  ok: boolean;
  repoRoot: string;
  expectedBranch: string;
  currentBranch: string | null;
  head: string | null;
  dirty: boolean;
  hasDiff: boolean;
  commitReady: boolean;
  branchDrift: boolean;
  allowlist: string[];
  allowedPaths: string[];
  ignoredPaths: string[];
  blockedPaths: string[];
  allowedStatusLines: string[];
  ignoredStatusLines: string[];
  blockedStatusLines: string[];
  statusLines: string[];
  reason: 'not_a_git_repo' | 'dirty_worktree' | 'branch_drift' | 'no_diff' | 'ready';
}

export interface AutonomyCommitResult {
  ok: boolean;
  repoRoot: string;
  expectedBranch: string;
  currentBranch: string | null;
  headBefore: string | null;
  headAfter: string | null;
  commitHash: string | null;
  committed: boolean;
  skippedReason: 'no_diff' | null;
  stageResult: CommandExecution | null;
  commitResult: CommandExecution | null;
  message: string;
}

export function getBackgroundWorktreePath(repoRoot: string): string {
  const parentDir = dirname(resolve(repoRoot));
  const repoName = basename(resolve(repoRoot));
  return join(parentDir, `${repoName}.__codex_bg`);
}

export async function detectGitRepository(
  startPath: string,
  options?: {
    allowFilesystemFallback?: boolean;
  },
): Promise<GitRepositoryInfo | null> {
  const probe = await probeWorktreeState(startPath, {
    allowFilesystemFallback: options?.allowFilesystemFallback,
  });
  if (!probe) {
    return null;
  }

  return {
    path: probe.repoRoot,
    gitDir: probe.gitDir,
    commonGitDir: probe.commonGitDir,
    head: probe.head,
    dirty: probe.dirty,
    statusLines: probe.statusLines,
    probeMode: probe.probeMode,
    stable: probe.stable,
    transient: probe.transient,
    reason: probe.reason,
    attempts: probe.attempts,
    managedDirtyPaths: probe.managedDirtyPaths,
    unmanagedDirtyPaths: probe.unmanagedDirtyPaths,
    managedControlSurfaceOnly: probe.managedControlSurfaceOnly,
  };
}

export async function getRepositoryHead(repoRoot: string): Promise<string | null> {
  const result = runProcess('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    return null;
  }

  return result.stdout.trim() || null;
}

export async function getRepositoryStatus(repoRoot: string): Promise<string[]> {
  const probe = await probeWorktreeState(repoRoot);
  if (!probe) {
    return [];
  }

  return probe.statusLines;
}

export async function getCurrentGitBranch(repoRoot: string): Promise<string | null> {
  const probe = await probeWorktreeState(repoRoot);
  return probe?.branch ?? null;
}

export function stageAllRepositoryChanges(repoRoot: string): CommandExecution {
  return runProcess('git', ['add', '-A'], { cwd: repoRoot });
}

function normalizeAllowlistPath(pathValue: string): string {
  return normalizeGitStatusPath(pathValue).toLowerCase();
}

export function isAllowlistedAutonomyCommitPath(pathValue: string): boolean {
  const normalizedPath = normalizeAllowlistPath(pathValue);
  return AUTONOMY_COMMIT_ALLOWLIST.some((entry) => (
    entry.endsWith('/')
      ? normalizedPath.startsWith(normalizeAllowlistPath(entry))
      : normalizedPath === normalizeAllowlistPath(entry)
  ));
}

export function isAmbientAutonomyCommitPath(pathValue: string): boolean {
  const normalizedPath = normalizeAllowlistPath(pathValue);
  return AUTONOMY_COMMIT_AMBIENT_ALLOWLIST.some((entry) => (
    entry.endsWith('/')
      ? normalizedPath.startsWith(normalizeAllowlistPath(entry))
      : normalizedPath === normalizeAllowlistPath(entry)
  ));
}

function isCommitEligibleAutonomyPath(pathValue: string): boolean {
  return isAllowlistedAutonomyCommitPath(pathValue) || !isAutonomyRuntimeAllowlistedPath(pathValue);
}

function isIgnoredAutonomyCommitPath(pathValue: string): boolean {
  return !isCommitEligibleAutonomyPath(pathValue) && (isAmbientAutonomyCommitPath(pathValue) || isAutonomyRuntimeAllowlistedPath(pathValue));
}

function analyzeAutonomyCommitScope(statusLines: string[]): {
  allowedPaths: string[];
  ignoredPaths: string[];
  blockedPaths: string[];
  allowedStatusLines: string[];
  ignoredStatusLines: string[];
  blockedStatusLines: string[];
} {
  const allowedPaths = new Set<string>();
  const ignoredPaths = new Set<string>();
  const blockedPaths = new Set<string>();
  const allowedStatusLines: string[] = [];
  const ignoredStatusLines: string[] = [];
  const blockedStatusLines: string[] = [];

  for (const statusLine of statusLines) {
    const paths = extractGitStatusPaths(statusLine);
    if (paths.length === 0) {
      blockedStatusLines.push(statusLine);
      continue;
    }

    const hasBlockedPath = paths.some((pathValue) => !isCommitEligibleAutonomyPath(pathValue) && !isIgnoredAutonomyCommitPath(pathValue));
    const hasAllowedPath = paths.some((pathValue) => isCommitEligibleAutonomyPath(pathValue));
    const hasIgnoredPath = paths.some((pathValue) => isIgnoredAutonomyCommitPath(pathValue));

    if (!hasBlockedPath && hasAllowedPath) {
      allowedStatusLines.push(statusLine);
      for (const pathValue of paths) {
        if (isCommitEligibleAutonomyPath(pathValue)) {
          allowedPaths.add(normalizeGitStatusPath(pathValue));
        } else if (isIgnoredAutonomyCommitPath(pathValue)) {
          ignoredPaths.add(normalizeGitStatusPath(pathValue));
        }
      }
      continue;
    }

    if (!hasBlockedPath && hasIgnoredPath) {
      ignoredStatusLines.push(statusLine);
      for (const pathValue of paths) {
        if (isIgnoredAutonomyCommitPath(pathValue)) {
          ignoredPaths.add(normalizeGitStatusPath(pathValue));
        }
      }
      continue;
    }

    blockedStatusLines.push(statusLine);
    for (const pathValue of paths) {
      if (!isCommitEligibleAutonomyPath(pathValue) && !isIgnoredAutonomyCommitPath(pathValue)) {
        blockedPaths.add(normalizeGitStatusPath(pathValue));
      }
    }
  }

  return {
    allowedPaths: [...allowedPaths],
    ignoredPaths: [...ignoredPaths],
    blockedPaths: [...blockedPaths],
    allowedStatusLines,
    ignoredStatusLines,
    blockedStatusLines,
  };
}

export function stageAllowlistedRepositoryChanges(repoRoot: string, allowedPaths: string[]): CommandExecution {
  if (allowedPaths.length === 0) {
    return {
      command: 'git',
      args: ['add', '-A'],
      cwd: repoRoot,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }

  return runProcess('git', ['add', '-A', '--', ...allowedPaths], { cwd: repoRoot });
}

export function commitStagedRepositoryChanges(repoRoot: string, commitMessage: string): CommandExecution {
  return runProcess('git', ['commit', '-m', commitMessage], { cwd: repoRoot });
}

export async function inspectAutonomyCommitGate(
  repoRoot: string,
  expectedBranch = DEFAULT_AUTONOMY_BRANCH,
): Promise<GitCommitGate> {
  const repoInfo = await detectGitRepository(repoRoot);
  if (!repoInfo) {
    return {
      ok: false,
      repoRoot: resolve(repoRoot),
      expectedBranch,
      currentBranch: null,
      head: null,
      dirty: false,
      hasDiff: false,
        commitReady: false,
        branchDrift: true,
        allowlist: [...AUTONOMY_COMMIT_ALLOWLIST],
        allowedPaths: [],
        ignoredPaths: [],
        blockedPaths: [],
        allowedStatusLines: [],
        ignoredStatusLines: [],
        blockedStatusLines: [],
        statusLines: [],
        reason: 'not_a_git_repo',
    };
  }

  const currentBranch = await getCurrentGitBranch(repoInfo.path);
  const statusLines = repoInfo.statusLines;
  const dirty = statusLines.length > 0;
  const branchDrift = currentBranch !== expectedBranch;
  const { allowedPaths, ignoredPaths, blockedPaths, allowedStatusLines, ignoredStatusLines, blockedStatusLines } = analyzeAutonomyCommitScope(statusLines);
  const commitReady = !branchDrift && allowedPaths.length > 0 && blockedPaths.length === 0;
  const hasCommitDiff = allowedPaths.length > 0;

  let reason: GitCommitGate['reason'] = 'ready';
  if (branchDrift) {
    reason = 'branch_drift';
  } else if (hasCommitDiff || blockedPaths.length > 0) {
    reason = 'dirty_worktree';
  } else {
    reason = 'no_diff';
  }

  return {
    ok: commitReady,
    repoRoot: repoInfo.path,
    expectedBranch,
      currentBranch,
      head: repoInfo.head,
      dirty,
      hasDiff: hasCommitDiff,
      commitReady,
      branchDrift,
      allowlist: [...AUTONOMY_COMMIT_ALLOWLIST],
      allowedPaths,
      ignoredPaths,
      blockedPaths,
      allowedStatusLines,
      ignoredStatusLines,
      blockedStatusLines,
      statusLines,
      reason,
  };
}

export async function createAutonomyCommit(
  repoRoot: string,
  commitMessage: string,
  expectedBranch = DEFAULT_AUTONOMY_BRANCH,
): Promise<AutonomyCommitResult> {
  const gate = await inspectAutonomyCommitGate(repoRoot, expectedBranch);
  if (gate.reason === 'not_a_git_repo') {
    return {
      ok: false,
      repoRoot: gate.repoRoot,
      expectedBranch,
      currentBranch: gate.currentBranch,
      headBefore: gate.head,
      headAfter: gate.head,
      commitHash: null,
      committed: false,
      skippedReason: null,
      stageResult: null,
      commitResult: null,
      message: `Repository at ${gate.repoRoot} is not a Git repository.`,
    };
  }

  if (gate.reason === 'branch_drift') {
    return {
      ok: false,
      repoRoot: gate.repoRoot,
      expectedBranch,
      currentBranch: gate.currentBranch,
      headBefore: gate.head,
      headAfter: gate.head,
      commitHash: null,
      committed: false,
      skippedReason: null,
      stageResult: null,
      commitResult: null,
      message: `Repository is on ${gate.currentBranch ?? 'detached HEAD'}, expected ${expectedBranch}.`,
    };
  }

  if (gate.reason === 'no_diff') {
    return {
      ok: true,
      repoRoot: gate.repoRoot,
      expectedBranch,
      currentBranch: gate.currentBranch,
      headBefore: gate.head,
      headAfter: gate.head,
      commitHash: gate.head,
      committed: false,
      skippedReason: 'no_diff',
      stageResult: null,
      commitResult: null,
      message: 'No repository diff was found; commit skipped.',
    };
  }

  if (gate.blockedPaths.length > 0) {
    return {
      ok: false,
      repoRoot: gate.repoRoot,
      expectedBranch,
      currentBranch: gate.currentBranch,
      headBefore: gate.head,
      headAfter: gate.head,
      commitHash: null,
      committed: false,
      skippedReason: null,
      stageResult: null,
      commitResult: null,
      message: `Refusing to create an autonomy commit because the workspace contains paths that are not eligible for an autonomy closeout commit: ${gate.blockedPaths.join(', ')}.`,
    };
  }

  const stageResult = stageAllowlistedRepositoryChanges(gate.repoRoot, gate.allowedPaths);
  if (!commandSucceeded(stageResult)) {
    return {
      ok: false,
      repoRoot: gate.repoRoot,
      expectedBranch,
      currentBranch: gate.currentBranch,
      headBefore: gate.head,
      headAfter: gate.head,
      commitHash: null,
      committed: false,
      skippedReason: null,
      stageResult,
      commitResult: null,
      message: `Failed to stage changes: ${stageResult.stderr || stageResult.stdout || stageResult.error || 'unknown error'}`,
    };
  }

  const commitResult = commitStagedRepositoryChanges(gate.repoRoot, commitMessage);
  const headAfter = await getRepositoryHead(gate.repoRoot);
  return {
    ok: commandSucceeded(commitResult),
    repoRoot: gate.repoRoot,
    expectedBranch,
    currentBranch: gate.currentBranch,
    headBefore: gate.head,
    headAfter,
    commitHash: headAfter,
    committed: commandSucceeded(commitResult),
    skippedReason: null,
    stageResult,
    commitResult,
    message: commandSucceeded(commitResult)
      ? `Committed ${headAfter ?? 'unknown'} on ${gate.currentBranch ?? expectedBranch}.`
      : `Failed to commit changes: ${commitResult.stderr || commitResult.stdout || commitResult.error || 'unknown error'}`,
  };
}

export function normalizeGitSafeDirectoryPath(targetPath: string): string {
  return resolve(targetPath).replace(/\\/g, '/');
}

export function getConfiguredSafeDirectories(cwd = process.cwd()): string[] {
  const result = runProcess('git', ['config', '--global', '--get-all', 'safe.directory'], { cwd });
  if (!commandSucceeded(result)) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function ensureGitSafeDirectory(targetPath: string, cwd = process.cwd()): void {
  const normalizedPath = normalizeGitSafeDirectoryPath(targetPath);
  const existing = getConfiguredSafeDirectories(cwd);
  if (existing.includes(normalizedPath)) {
    return;
  }

  const addResult = runProcess('git', ['config', '--global', '--add', 'safe.directory', normalizedPath], { cwd });
  if (!commandSucceeded(addResult)) {
    throw new Error(
      `Failed to add ${normalizedPath} to git safe.directory: ${addResult.stderr || addResult.stdout || addResult.error || 'unknown error'}`,
    );
  }
}

export async function getWorktreeSummary(
  worktreePath: string,
  options?: {
    allowFilesystemFallback?: boolean;
  },
): Promise<WorktreeSummary | null> {
  await assertDirectPathBoundary(worktreePath);
  const probe = await probeWorktreeState(worktreePath, {
    allowFilesystemFallback: options?.allowFilesystemFallback,
  });
  if (!probe) {
    return null;
  }

  return {
    path: worktreePath,
    repoRoot: probe.repoRoot,
    commonGitDir: probe.commonGitDir,
    branch: probe.branch,
    head: probe.head,
    dirty: probe.dirty,
    statusLines: probe.statusLines,
    probeMode: probe.probeMode,
    stable: probe.stable,
    transient: probe.transient,
    reason: probe.reason,
    attempts: probe.attempts,
    managedDirtyPaths: probe.managedDirtyPaths,
    unmanagedDirtyPaths: probe.unmanagedDirtyPaths,
    managedControlSurfaceOnly: probe.managedControlSurfaceOnly,
  };
}

export async function getWorkingTreeStatus(worktreePath: string): Promise<{
  exists: boolean;
  isGit: boolean;
  isEmptyDirectory: boolean;
  summary: WorktreeSummary | null;
}> {
  const exists = await pathExists(worktreePath);
  if (!exists) {
    return {
      exists: false,
      isGit: false,
      isEmptyDirectory: false,
      summary: null,
    };
  }

  const summary = await getWorktreeSummary(worktreePath);
  const isEmptyDirectory = !summary && (await isEmptyPath(worktreePath));

  return {
    exists: true,
    isGit: Boolean(summary),
    isEmptyDirectory,
    summary,
  };
}

export async function prepareBackgroundWorktree(
  repoRoot: string,
  options?: {
    backgroundPath?: string;
    branch?: string;
  },
): Promise<BackgroundWorktreePreparation> {
  const branch = options?.branch ?? DEFAULT_BACKGROUND_WORKTREE_BRANCH;
  const backgroundPath = options?.backgroundPath ?? getBackgroundWorktreePath(repoRoot);
  const repoInfo = await detectGitRepository(repoRoot);
  const repoHead = repoInfo?.head ?? await getRepositoryHead(repoRoot);
  if (!repoHead) {
    throw new Error(`Repository at ${repoRoot} does not have a commit HEAD yet; cannot create a background worktree.`);
  }

  const repoStatus = repoInfo?.statusLines ?? await getRepositoryStatus(repoRoot);
  if (repoStatus.length > 0) {
    throw new Error(`Repository at ${repoRoot} is dirty; refusing to prepare the background worktree.`);
  }
  const repoCommonGitDir = repoInfo?.commonGitDir ?? resolve(repoRoot, '.git');

  await assertDirectPathBoundary(backgroundPath);
  const backgroundExists = await pathExists(backgroundPath);
  const backgroundSummary = backgroundExists ? await getWorktreeSummary(backgroundPath) : null;

  if (!backgroundExists) {
    await createBackgroundWorktree(repoRoot, backgroundPath, branch, repoHead);
    const worktree = await requireWorktreeSummary(backgroundPath);
    return {
      action: 'created',
      repoRoot,
      backgroundPath,
      branch,
      head: repoHead,
      worktree,
    };
  }

  if (!backgroundSummary) {
    if (!(await isEmptyPath(backgroundPath))) {
      throw new Error(
        `Background worktree path ${backgroundPath} exists but is not a Git worktree and is not empty. Refusing to overwrite it.`,
      );
    }

    await createBackgroundWorktree(repoRoot, backgroundPath, branch, repoHead);
    const worktree = await requireWorktreeSummary(backgroundPath);
    return {
      action: 'created',
      repoRoot,
      backgroundPath,
      branch,
      head: repoHead,
      worktree,
    };
  }

  if (backgroundSummary.commonGitDir !== repoCommonGitDir) {
    throw new Error(
      `Background worktree at ${backgroundPath} belongs to ${backgroundSummary.commonGitDir}, not ${repoCommonGitDir}. Refusing to reuse it.`,
    );
  }

  if (backgroundSummary.dirty) {
    const backgroundState = await probeWorktreeState(backgroundPath);
    if (backgroundState?.transient) {
      throw new Error('transient_git_state: background worktree status was unstable across consecutive snapshots.');
    }

    const blockedDirtyPaths = backgroundState?.unmanagedDirtyPaths ?? [];
    if (blockedDirtyPaths.length > 0) {
      throw new Error(
        `Background worktree at ${backgroundPath} is dirty outside the allowlisted autonomy runtime files: ${blockedDirtyPaths.join(', ')}.`,
      );
    }

    if (backgroundSummary.branch !== branch || backgroundSummary.head !== repoHead) {
      await discardManagedRuntimeChanges(backgroundPath, backgroundState?.managedDirtyPaths ?? backgroundSummary.managedDirtyPaths ?? []);
    } else {
      return {
        action: 'validated',
        repoRoot,
        backgroundPath,
        branch,
        head: repoHead,
        worktree: backgroundState ?? backgroundSummary,
      };
    }
  }

  const currentBranch = backgroundSummary.branch;
  if (currentBranch !== branch || backgroundSummary.head !== repoHead) {
    const switchResult = runProcess('git', ['switch', '-C', branch, repoHead], { cwd: backgroundPath });
    if (!commandSucceeded(switchResult)) {
      throw new Error(
        `Failed to align background worktree at ${backgroundPath} to ${branch}@${repoHead}: ${switchResult.stderr || switchResult.stdout || switchResult.error || 'unknown error'}`,
      );
    }
    const worktree = await requireWorktreeSummary(backgroundPath);
    return {
      action: 'aligned',
      repoRoot,
      backgroundPath,
      branch,
      head: repoHead,
      worktree,
    };
  }

  return {
    action: 'validated',
    repoRoot,
    backgroundPath,
    branch,
    head: repoHead,
    worktree: backgroundSummary,
  };
}

async function createBackgroundWorktree(
  repoRoot: string,
  backgroundPath: string,
  branch: string,
  repoHead: string,
): Promise<void> {
  const addResult = runProcess('git', ['worktree', 'add', '-B', branch, backgroundPath, repoHead], { cwd: repoRoot });
  if (commandSucceeded(addResult)) {
    return;
  }

  const maybeEmptyDir = await isEmptyPath(backgroundPath);
  if (!maybeEmptyDir) {
    throw new Error(
      `Failed to create background worktree at ${backgroundPath}: ${addResult.stderr || addResult.stdout || addResult.error || 'unknown error'}`,
    );
  }

  const forceResult = runProcess('git', ['worktree', 'add', '--force', '-B', branch, backgroundPath, repoHead], {
    cwd: repoRoot,
  });
  if (!commandSucceeded(forceResult)) {
    throw new Error(
      `Failed to create background worktree at ${backgroundPath}: ${forceResult.stderr || forceResult.stdout || forceResult.error || 'unknown error'}`,
    );
  }
}

function normalizeManagedRuntimePaths(relativePaths: readonly string[]): string[] {
  return [...new Set(
    relativePaths
      .map((pathValue) => normalizeGitStatusPath(pathValue))
      .filter((pathValue) => pathValue.length > 0 && isAutonomyRuntimeAllowlistedPath(pathValue)),
  )].sort();
}

async function listTrackedPaths(repoRoot: string, relativePaths: readonly string[]): Promise<string[]> {
  if (relativePaths.length === 0) {
    return [];
  }

  const result = runProcess('git', ['ls-files', '-z', '--', ...relativePaths], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    throw new Error(
      `Failed to list tracked managed paths in ${repoRoot}: ${result.stderr || result.stdout || result.error || 'unknown error'}`,
    );
  }

  return result.stdout
    .split('\0')
    .map((pathValue) => normalizeGitStatusPath(pathValue))
    .filter(Boolean);
}

export async function discardManagedRuntimeChanges(worktreePath: string, relativePaths: readonly string[]): Promise<void> {
  const managedPaths = normalizeManagedRuntimePaths(relativePaths);
  if (managedPaths.length === 0) {
    return;
  }

  const trackedPaths = await listTrackedPaths(worktreePath, managedPaths);

  for (const relativePath of managedPaths) {
    await rm(resolve(worktreePath, relativePath), { recursive: true, force: true });
  }

  if (trackedPaths.length === 0) {
    return;
  }

  const restoreResult = runProcess('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...trackedPaths], {
    cwd: worktreePath,
  });
  if (!commandSucceeded(restoreResult)) {
    throw new Error(
      `Failed to restore managed runtime files in ${worktreePath}: ${restoreResult.stderr || restoreResult.stdout || restoreResult.error || 'unknown error'}`,
    );
  }
}

async function requireWorktreeSummary(worktreePath: string): Promise<WorktreeSummary> {
  const summary = await getWorktreeSummary(worktreePath);
  if (!summary) {
    throw new Error(`Expected ${worktreePath} to be a Git worktree, but it is not.`);
  }

  return summary;
}

async function isEmptyPath(targetPath: string): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return true;
  }

  try {
    const entries = await listDirectoryEntries(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}
