import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, detectGitRepository, ensureGitSafeDirectory, getBackgroundWorktreePath, getRepositoryHead, getWorktreeSummary, prepareBackgroundWorktree } from "../infra/git.js";
import { listDirectoryEntries, pathExists } from "../infra/json.js";
import { commandSucceeded, runProcess } from "../infra/process.js";
import { getManagedControlSurfaceRelativePaths, isManagedControlSurfaceRelativePath } from "../shared/paths.js";

export interface PrepareWorktreeOptions {
  workspaceRoot?: string;
}

export interface PrepareWorktreeResult {
  ok: boolean;
  workspaceRoot: string;
  repoRoot: string | null;
  backgroundPath: string | null;
  branch: string;
  action?: "created" | "aligned" | "validated";
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
      message: "Workspace is not a Git repository. Refusing to prepare the background worktree.",
    };
  }

  const repoStatus = await runGitStatus(repo.path);
  const dirtyPaths = extractDirtyPaths(repoStatus);
  const blockedDirtyPaths = dirtyPaths.filter((pathValue) => !isManagedControlSurfacePath(pathValue));
  const repoDirty = repoStatus.length > 0;

  if (blockedDirtyPaths.length > 0) {
    const backgroundPath = getBackgroundWorktreePath(repo.path);
    return {
      ok: false,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath,
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: true,
      message: `Repository is dirty outside the managed control surface: ${blockedDirtyPaths.join(", ")}. Refusing to prepare the background worktree.`,
    };
  }

  const repoHead = repo.head ?? await getRepositoryHead(repo.path);
  if (!repoHead) {
    return {
      ok: false,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath: getBackgroundWorktreePath(repo.path),
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: repoDirty,
      message: "Repository does not have a commit HEAD yet; cannot create a background worktree.",
    };
  }

  const backgroundPath = getBackgroundWorktreePath(repo.path);
  const managedDirtyPaths = repoDirty ? dirtyPaths.filter((pathValue) => isManagedControlSurfacePath(pathValue)) : [];
  const worktreeResult = repoDirty
    ? await createOrAlignBackgroundWorktree(
        repo.path,
        backgroundPath,
        DEFAULT_BACKGROUND_WORKTREE_BRANCH,
        repoHead,
        repo.commonGitDir,
      )
    : await prepareCleanBackgroundWorktree(repo.path, backgroundPath, DEFAULT_BACKGROUND_WORKTREE_BRANCH);

  if (!worktreeResult.ok) {
    return {
      ok: false,
      workspaceRoot,
      repoRoot: repo.path,
      backgroundPath,
      branch: DEFAULT_BACKGROUND_WORKTREE_BRANCH,
      dirtyRepository: repoDirty,
      message: worktreeResult.message,
    };
  }

  const syncedPaths = repoDirty
    ? await syncManagedControlSurfaceFiles(repo.path, backgroundPath, managedDirtyPaths)
    : [];
  ensureGitSafeDirectory(repo.path, repo.path);
  ensureGitSafeDirectory(backgroundPath, repo.path);

  return {
    ok: true,
    workspaceRoot,
    repoRoot: repo.path,
    backgroundPath,
    branch: worktreeResult.branch,
    action: worktreeResult.action,
    head: repoHead,
    dirtyRepository: repoDirty,
    message: repoDirty
      ? `Background worktree prepared and synchronized ${syncedPaths.length} managed control surface file(s) despite allowlisted repo changes.`
      : `Background worktree ${worktreeResult.action}: ${backgroundPath}`,
  };
}

export function formatPrepareWorktreeResult(result: PrepareWorktreeResult): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${result.workspaceRoot}`);
  lines.push(`Repo: ${result.repoRoot ?? "not a git repository"}`);
  lines.push(`Background worktree: ${result.backgroundPath ?? "n/a"}`);
  lines.push(`Branch: ${result.branch}`);
  lines.push(`Dirty repo: ${result.dirtyRepository ? "yes" : "no"}`);
  lines.push(`Status: ${result.ok ? "ok" : "blocked"}`);
  lines.push(`Message: ${result.message}`);
  return `${lines.join("\n")}\n`;
}

export function registerPrepareWorktreeCommand(program: Command): void {
  program
    .command("prepare-worktree")
    .option("--workspace-root <path>", "Workspace root to inspect")
    .description("Create or validate the dedicated background worktree for automation")
    .action(async (options: { workspaceRoot?: string }) => {
      const result = await runPrepareWorktree({
        workspaceRoot: options.workspaceRoot,
      });
      console.log(formatPrepareWorktreeResult(result));
    });
}

async function prepareCleanBackgroundWorktree(
  repoRoot: string,
  backgroundPath: string,
  branch: string,
): Promise<{
  ok: boolean;
  action?: "created" | "aligned" | "validated";
  branch: string;
  message: string;
}> {
  try {
    const preparation = await prepareBackgroundWorktree(repoRoot, {
      backgroundPath,
      branch,
    });
    return {
      ok: true,
      action: preparation.action,
      branch: preparation.branch,
      message: `Background worktree ${preparation.action}: ${preparation.backgroundPath}`,
    };
  } catch (error) {
    return {
      ok: false,
      branch,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createOrAlignBackgroundWorktree(
  repoRoot: string,
  backgroundPath: string,
  branch: string,
  repoHead: string,
  repoCommonGitDir: string,
): Promise<{
  ok: boolean;
  action?: "created" | "aligned" | "validated";
  branch: string;
  message: string;
}> {
  const backgroundExists = await pathExists(backgroundPath);
  const backgroundSummary = backgroundExists ? await getWorktreeSummary(backgroundPath) : null;

  if (!backgroundExists) {
    await createBackgroundWorktree(repoRoot, backgroundPath, branch, repoHead);
    return {
      ok: true,
      action: "created",
      branch,
      message: `Background worktree created at ${backgroundPath}.`,
    };
  }

  if (!backgroundSummary) {
    if (!(await isEmptyDirectory(backgroundPath))) {
      return {
        ok: false,
        branch,
        message: `Background worktree path ${backgroundPath} exists but is not a Git worktree and is not empty. Refusing to overwrite it.`,
      };
    }

    await createBackgroundWorktree(repoRoot, backgroundPath, branch, repoHead);
    return {
      ok: true,
      action: "created",
      branch,
      message: `Background worktree created at ${backgroundPath}.`,
    };
  }

  if (backgroundSummary.commonGitDir !== repoCommonGitDir) {
    return {
      ok: false,
      branch,
      message: `Background worktree at ${backgroundPath} belongs to ${backgroundSummary.commonGitDir}, not the current repository. Refusing to reuse it.`,
    };
  }

  if (backgroundSummary.dirty) {
    const dirtyPaths = extractDirtyPaths(backgroundSummary.statusLines);
    const blockedDirtyPaths = dirtyPaths.filter((pathValue) => !isManagedControlSurfacePath(pathValue));
    if (blockedDirtyPaths.length > 0) {
      return {
        ok: false,
        branch,
        message: `Background worktree at ${backgroundPath} is dirty outside the managed control surface: ${blockedDirtyPaths.join(", ")}.`,
      };
    }

    if (backgroundSummary.branch !== branch || backgroundSummary.head !== repoHead) {
      return {
        ok: false,
        branch,
        message: `Background worktree at ${backgroundPath} has allowlisted changes but is not aligned to ${branch}@${repoHead}. Refusing to realign a dirty worktree.`,
      };
    }

    return {
      ok: true,
      action: "validated",
      branch: backgroundSummary.branch ?? branch,
      message: `Background worktree at ${backgroundPath} already contains allowlisted managed changes.`,
    };
  }

  if (backgroundSummary.branch !== branch || backgroundSummary.head !== repoHead) {
    const switchResult = runProcess("git", ["switch", "-C", branch, repoHead], { cwd: backgroundPath });
    if (!commandSucceeded(switchResult)) {
      return {
        ok: false,
        branch,
        message: `Failed to align background worktree at ${backgroundPath} to ${branch}@${repoHead}: ${switchResult.stderr || switchResult.stdout || switchResult.error || "unknown error"}`,
      };
    }

    return {
      ok: true,
      action: "aligned",
      branch,
      message: `Background worktree aligned to ${branch}@${repoHead}.`,
    };
  }

  return {
    ok: true,
    action: "validated",
    branch,
    message: `Background worktree at ${backgroundPath} is already aligned.`,
  };
}

async function createBackgroundWorktree(
  repoRoot: string,
  backgroundPath: string,
  branch: string,
  repoHead: string,
): Promise<void> {
  const addResult = runProcess("git", ["worktree", "add", "-B", branch, backgroundPath, repoHead], { cwd: repoRoot });
  if (commandSucceeded(addResult)) {
    return;
  }

  const forceResult = runProcess("git", ["worktree", "add", "--force", "-B", branch, backgroundPath, repoHead], {
    cwd: repoRoot,
  });
  if (!commandSucceeded(forceResult)) {
    throw new Error(
      `Failed to create background worktree at ${backgroundPath}: ${forceResult.stderr || forceResult.stdout || forceResult.error || "unknown error"}`,
    );
  }
}

async function syncManagedControlSurfaceFiles(
  sourceRoot: string,
  targetRoot: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  const synced: string[] = [];
  for (const relativePath of relativePaths) {
    const sourcePath = resolve(sourceRoot, relativePath);
    const targetPath = resolve(targetRoot, relativePath);

    if (!(await pathExists(sourcePath))) {
      if (await pathExists(targetPath)) {
        await rm(targetPath, { recursive: true, force: true });
        synced.push(relativePath.replace(/\\/g, "/"));
      }
      continue;
    }

    await mkdir(resolve(targetPath, ".."), { recursive: true });
    await copyFile(sourcePath, targetPath);
    synced.push(relativePath.replace(/\\/g, "/"));
  }

  return synced;
}

async function runGitStatus(repoRoot: string): Promise<string[]> {
  const result = runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function extractDirtyPaths(statusLines: readonly string[]): string[] {
  const paths = new Set<string>();

  for (const statusLine of statusLines) {
    if (statusLine.length < 4) {
      continue;
    }

    const rawContent = statusLine.slice(3).trim();
    if (!rawContent) {
      continue;
    }

    const statusPaths = rawContent.includes(" -> ")
      ? rawContent.split(" -> ")
      : [rawContent];

    for (const statusPath of statusPaths) {
      const normalized = statusPath.replace(/^"+|"+$/g, "").replace(/\\/g, "/").trim();
      if (normalized) {
        paths.add(normalized);
      }
    }
  }

  return [...paths];
}

function isManagedControlSurfacePath(pathValue: string): boolean {
  return isManagedControlSurfaceRelativePath(pathValue);
}

async function isEmptyDirectory(targetPath: string): Promise<boolean> {
  try {
    const entries = await listDirectoryEntries(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}
