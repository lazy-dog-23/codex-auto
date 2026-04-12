import { basename, dirname, join, resolve } from 'node:path';
import { runProcess, commandSucceeded } from './process.js';
import { listDirectoryEntries, pathExists } from './json.js';
import type {
  BackgroundWorktreePreparation,
  GitRepositoryInfo,
  WorktreeSummary,
} from './types.js';

export const DEFAULT_BACKGROUND_WORKTREE_BRANCH = 'codex/background';

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
