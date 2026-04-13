import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { commandSucceeded, runProcess } from "./process.js";
import { isManagedControlSurfaceRelativePath } from "../shared/paths.js";

export interface WorktreeStatusSnapshot {
  dirty: boolean;
  statusLines: string[];
  normalizedStatusLines: string[];
  managedDirtyPaths: string[];
  unmanagedDirtyPaths: string[];
  managedControlSurfaceOnly: boolean;
}

export interface WorktreeStateProbe extends WorktreeStatusSnapshot {
  path: string;
  repoRoot: string;
  gitDir: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null;
  stable: boolean;
  transient: boolean;
  reason?: "transient_git_state";
  attempts: number;
}

export interface WorktreeStateProbeOptions {
  maxAttempts?: number;
  debounceMs?: number;
}

export function normalizeGitStatusPath(pathValue: string): string {
  return pathValue.replace(/^"+|"+$/g, "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function extractGitStatusPaths(statusLine: string): string[] {
  if (statusLine.length < 4) {
    return [];
  }

  const content = statusLine.slice(3).trim();
  if (!content) {
    return [];
  }

  const paths = content.includes(" -> ")
    ? content.split(" -> ").map((part) => normalizeGitStatusPath(part))
    : [normalizeGitStatusPath(content)];

  return paths.filter(Boolean);
}

export function normalizeGitStatusLine(statusLine: string): string {
  if (statusLine.length < 3) {
    return normalizeGitStatusPath(statusLine);
  }

  const prefix = statusLine.slice(0, 3);
  const paths = extractGitStatusPaths(statusLine);
  if (paths.length === 0) {
    return prefix.trimEnd();
  }

  return `${prefix}${paths.join(" -> ")}`.trimEnd();
}

export function classifyManagedControlSurfacePaths(statusLines: readonly string[]): WorktreeStatusSnapshot {
  const statusLinesCopy = [...statusLines];
  const normalizedStatusLines = [...new Set(statusLinesCopy.map((line) => normalizeGitStatusLine(line)))].sort();
  const managedDirtyPaths = new Set<string>();
  const unmanagedDirtyPaths = new Set<string>();

  for (const statusLine of statusLinesCopy) {
    for (const pathValue of extractGitStatusPaths(statusLine)) {
      if (isManagedControlSurfaceRelativePath(pathValue)) {
        managedDirtyPaths.add(normalizeGitStatusPath(pathValue));
      } else {
        unmanagedDirtyPaths.add(normalizeGitStatusPath(pathValue));
      }
    }
  }

  return {
    dirty: statusLinesCopy.length > 0,
    statusLines: statusLinesCopy.map((line) => line.trimEnd()),
    normalizedStatusLines,
    managedDirtyPaths: [...managedDirtyPaths],
    unmanagedDirtyPaths: [...unmanagedDirtyPaths],
    managedControlSurfaceOnly: statusLinesCopy.length > 0 && unmanagedDirtyPaths.size === 0,
  };
}

export async function probeWorktreeState(
  worktreePath: string,
  options: WorktreeStateProbeOptions = {},
): Promise<WorktreeStateProbe | null> {
  const repoRoot = await readRepositoryRoot(worktreePath);
  if (!repoRoot) {
    return null;
  }

  const metadata = await readRepositoryMetadata(repoRoot);
  const status = await readStableStatusSnapshot(repoRoot, options);

  return {
    path: resolve(worktreePath),
    repoRoot,
    gitDir: metadata.gitDir,
    commonGitDir: metadata.commonGitDir,
    branch: metadata.branch,
    head: metadata.head,
    ...status.snapshot,
    stable: status.stable,
    transient: status.transient,
    reason: status.reason,
    attempts: status.attempts,
  };
}

async function readRepositoryRoot(worktreePath: string): Promise<string | null> {
  const result = runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: worktreePath });
  if (!commandSucceeded(result)) {
    return null;
  }

  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

async function readRepositoryMetadata(repoRoot: string): Promise<{
  gitDir: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null;
}> {
  const gitDirResult = runProcess("git", ["rev-parse", "--git-dir"], { cwd: repoRoot });
  const commonGitDirResult = runProcess("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot });
  const branchResult = runProcess("git", ["branch", "--show-current"], { cwd: repoRoot });
  const headResult = runProcess("git", ["rev-parse", "HEAD"], { cwd: repoRoot });

  return {
    gitDir: commandSucceeded(gitDirResult) && gitDirResult.stdout.trim().length > 0
      ? resolve(repoRoot, gitDirResult.stdout.trim())
      : resolve(repoRoot, ".git"),
    commonGitDir: commandSucceeded(commonGitDirResult) && commonGitDirResult.stdout.trim().length > 0
      ? resolve(repoRoot, commonGitDirResult.stdout.trim())
      : resolve(repoRoot, ".git"),
    branch: commandSucceeded(branchResult) ? branchResult.stdout.trim() || null : null,
    head: commandSucceeded(headResult) ? headResult.stdout.trim() || null : null,
  };
}

async function readStableStatusSnapshot(
  repoRoot: string,
  options: WorktreeStateProbeOptions,
): Promise<{
  snapshot: WorktreeStatusSnapshot;
  stable: boolean;
  transient: boolean;
  reason?: "transient_git_state";
  attempts: number;
}> {
  const maxAttempts = Math.max(2, options.maxAttempts ?? 4);
  const debounceMs = Math.max(0, options.debounceMs ?? 25);

  let previous: WorktreeStatusSnapshot | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    const current = readStatusSnapshot(repoRoot);
    if (previous && snapshotsMatch(previous, current)) {
      return {
        snapshot: current,
        stable: true,
        transient: false,
        attempts,
      };
    }

    previous = current;
    if (attempts < maxAttempts && debounceMs > 0) {
      await delay(debounceMs);
    }
  }

  return {
    snapshot: previous ?? readStatusSnapshot(repoRoot),
    stable: false,
    transient: true,
    reason: "transient_git_state",
    attempts,
  };
}

function readStatusSnapshot(repoRoot: string): WorktreeStatusSnapshot {
  const result = runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot });
  const statusLines = commandSucceeded(result)
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
    : [];

  return classifyManagedControlSurfacePaths(statusLines);
}

function snapshotsMatch(left: WorktreeStatusSnapshot, right: WorktreeStatusSnapshot): boolean {
  return (
    left.dirty === right.dirty &&
    left.managedControlSurfaceOnly === right.managedControlSurfaceOnly &&
    arrayEquals(left.normalizedStatusLines, right.normalizedStatusLines)
  );
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
