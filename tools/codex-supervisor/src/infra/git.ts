import { basename, dirname, join, resolve } from 'node:path';
import { runProcess, commandSucceeded } from './process.js';
import { assertDirectPathBoundary, listDirectoryEntries, pathExists } from './json.js';
import type { CommandExecution } from './types.js';
import type {
  BackgroundWorktreePreparation,
  GitRepositoryInfo,
  WorktreeSummary,
} from './types.js';

export const DEFAULT_BACKGROUND_WORKTREE_BRANCH = 'codex/background';
export const DEFAULT_AUTONOMY_BRANCH = 'codex/autonomy';

export interface GitCommitGate {
  ok: boolean;
  repoRoot: string;
  expectedBranch: string;
  currentBranch: string | null;
  head: string | null;
  dirty: boolean;
  hasDiff: boolean;
  branchDrift: boolean;
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

export async function detectGitRepository(startPath: string): Promise<GitRepositoryInfo | null> {
  const probe = runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: startPath });
  if (!commandSucceeded(probe)) {
    return null;
  }

  const repoRoot = probe.stdout.trim();
  if (!repoRoot) {
    return null;
  }

  const gitDirProbe = runProcess('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
  const commonGitDirProbe = runProcess('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot });
  const headProbe = runProcess('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const statusProbe = runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot });

  return {
    path: repoRoot,
    gitDir: gitDirProbe.stdout.trim() || '',
    commonGitDir: commandSucceeded(commonGitDirProbe)
      ? resolve(repoRoot, commonGitDirProbe.stdout.trim() || '.git')
      : resolve(repoRoot, '.git'),
    head: commandSucceeded(headProbe) ? headProbe.stdout.trim() || null : null,
    dirty: Boolean(statusProbe.stdout.trim()),
    statusLines: statusProbe.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean),
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
  const result = runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export async function getCurrentGitBranch(repoRoot: string): Promise<string | null> {
  const result = runProcess('git', ['branch', '--show-current'], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    return null;
  }

  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

export function stageAllRepositoryChanges(repoRoot: string): CommandExecution {
  return runProcess('git', ['add', '-A'], { cwd: repoRoot });
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
      branchDrift: true,
      statusLines: [],
      reason: 'not_a_git_repo',
    };
  }

  const currentBranch = await getCurrentGitBranch(repoInfo.path);
  const statusLines = repoInfo.statusLines;
  const dirty = statusLines.length > 0;
  const branchDrift = currentBranch !== expectedBranch;

  let reason: GitCommitGate['reason'] = 'ready';
  if (branchDrift) {
    reason = 'branch_drift';
  } else if (dirty) {
    reason = 'dirty_worktree';
  } else {
    reason = 'no_diff';
  }

  return {
    ok: reason === 'dirty_worktree',
    repoRoot: repoInfo.path,
    expectedBranch,
    currentBranch,
    head: repoInfo.head,
    dirty,
    hasDiff: dirty,
    branchDrift,
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

  const stageResult = stageAllRepositoryChanges(gate.repoRoot);
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

export async function getWorktreeSummary(worktreePath: string): Promise<WorktreeSummary | null> {
  await assertDirectPathBoundary(worktreePath);
  const repoInfo = await detectGitRepository(worktreePath);
  if (!repoInfo) {
    return null;
  }

  const branchProbe = runProcess('git', ['branch', '--show-current'], { cwd: worktreePath });
  const headProbe = runProcess('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  const statusProbe = runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktreePath });

  return {
    path: worktreePath,
    repoRoot: repoInfo.path,
    commonGitDir: repoInfo.commonGitDir,
    branch: commandSucceeded(branchProbe) ? branchProbe.stdout.trim() || null : null,
    head: commandSucceeded(headProbe) ? headProbe.stdout.trim() || null : null,
    dirty: Boolean(statusProbe.stdout.trim()),
    statusLines: statusProbe.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean),
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

  if (backgroundSummary.dirty) {
    throw new Error(`Background worktree at ${backgroundPath} is dirty; refusing to align it.`);
  }

  if (backgroundSummary.commonGitDir !== repoCommonGitDir) {
    throw new Error(
      `Background worktree at ${backgroundPath} belongs to ${backgroundSummary.commonGitDir}, not ${repoCommonGitDir}. Refusing to reuse it.`,
    );
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
