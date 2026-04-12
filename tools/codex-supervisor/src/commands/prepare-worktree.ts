import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_BACKGROUND_WORKTREE_BRANCH,
  detectGitRepository,
  ensureGitSafeDirectory,
  getBackgroundWorktreePath,
  getRepositoryStatus,
  prepareBackgroundWorktree,
} from '../infra/git.js';
import type { BackgroundWorktreePreparation } from '../infra/types.js';

export interface PrepareWorktreeOptions {
  workspaceRoot?: string;
}

export interface PrepareWorktreeResult {
  ok: boolean;
  workspaceRoot: string;
  repoRoot: string | null;
  backgroundPath: string | null;
  branch: string;
  action?: BackgroundWorktreePreparation['action'];
  head?: string;
  dirtyRepository: boolean;
  message: string;
}

export async function runPrepareWorktree(options: PrepareWorktreeOptions = {}): Promise<PrepareWorktreeResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const repo = await detectGitRepository(workspaceRoot);
  if (!repo) {
    return {
      ok: false,
      workspaceRoot,
      repoRoot: null,
      backgroundPath: null,
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: false,
      message: 'Workspace is not a Git repository. Refusing to prepare the background worktree.',
    };
  }

  const repoStatus = await getRepositoryStatus(repo.path);
  if (repoStatus.length > 0) {
    const backgroundPath = getBackgroundWorktreePath(repo.path);
    return {
      ok: false,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath,
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: true,
      message: 'Repository is dirty. Refusing to prepare the background worktree.',
    };
  }

  try {
    const preparation = await prepareBackgroundWorktree(repo.path, {
      backgroundPath: getBackgroundWorktreePath(repo.path),
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
    });
    ensureGitSafeDirectory(repo.path, repo.path);
    ensureGitSafeDirectory(preparation.backgroundPath, repo.path);

    return {
      ok: true,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath: preparation.backgroundPath,
      branch: preparation.branch,
      action: preparation.action,
      head: preparation.head,
      dirtyRepository: false,
      message: `Background worktree ${preparation.action}: ${preparation.backgroundPath}`,
    };
  } catch (error) {
    return {
      ok: false,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath: getBackgroundWorktreePath(repo.path),
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatPrepareWorktreeResult(result: PrepareWorktreeResult): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${result.workspaceRoot}`);
  lines.push(`Repo: ${result.repoRoot ?? 'not a git repository'}`);
  lines.push(`Background worktree: ${result.backgroundPath ?? 'n/a'}`);
  lines.push(`Branch: ${result.branch}`);
  lines.push(`Dirty repo: ${result.dirtyRepository ? 'yes' : 'no'}`);
  lines.push(`Status: ${result.ok ? 'ok' : 'blocked'}`);
  lines.push(`Message: ${result.message}`);
  return `${lines.join('\n')}\n`;
}

export function registerPrepareWorktreeCommand(program: Command): void {
  program
    .command('prepare-worktree')
    .option('--workspace-root <path>', 'Workspace root to inspect')
    .description('Create or validate the dedicated background worktree for automation')
    .action(async (options: { workspaceRoot?: string }) => {
      const result = await runPrepareWorktree({
        workspaceRoot: options.workspaceRoot,
      });
      console.log(formatPrepareWorktreeResult(result));
    });
}
