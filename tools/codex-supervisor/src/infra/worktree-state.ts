import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { commandSucceeded, runProcess } from "./process.js";
import { isAutonomyRuntimeAllowlistedPath } from "../shared/paths.js";

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
  probeMode: "git" | "filesystem";
  stable: boolean;
  transient: boolean;
  reason?: "transient_git_state";
  attempts: number;
}

export interface WorktreeStateProbeOptions {
  maxAttempts?: number;
  debounceMs?: number;
  allowFilesystemFallback?: boolean;
}

interface WorktreeProbeSnapshot extends WorktreeStatusSnapshot {
  gitDir: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null;
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
      if (isAutonomyRuntimeAllowlistedPath(pathValue)) {
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
  if (repoRoot) {
    const snapshot = await readStableWorktreeSnapshot(repoRoot, options);

    return {
      path: resolve(worktreePath),
      repoRoot,
      gitDir: snapshot.snapshot.gitDir,
      commonGitDir: snapshot.snapshot.commonGitDir,
      branch: snapshot.snapshot.branch,
      head: snapshot.snapshot.head,
      probeMode: "git",
      dirty: snapshot.snapshot.dirty,
      statusLines: snapshot.snapshot.statusLines,
      normalizedStatusLines: snapshot.snapshot.normalizedStatusLines,
      managedDirtyPaths: snapshot.snapshot.managedDirtyPaths,
      unmanagedDirtyPaths: snapshot.snapshot.unmanagedDirtyPaths,
      managedControlSurfaceOnly: snapshot.snapshot.managedControlSurfaceOnly,
      stable: snapshot.stable,
      transient: snapshot.transient,
      reason: snapshot.reason,
      attempts: snapshot.attempts,
    };
  }

  if (!options.allowFilesystemFallback) {
    return null;
  }

  return readFilesystemWorktreeState(worktreePath);
}

async function readRepositoryRoot(worktreePath: string): Promise<string | null> {
  const result = runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: worktreePath });
  if (!commandSucceeded(result)) {
    return null;
  }

  const root = result.stdout.trim();
  return root.length > 0 ? root : null;
}

async function readFilesystemWorktreeState(worktreePath: string): Promise<WorktreeStateProbe | null> {
  const gitMarkers = await findGitMarkers(worktreePath);
  if (!gitMarkers) {
    return null;
  }

  const headState = await readHeadState(gitMarkers.gitDir, gitMarkers.commonGitDir);

  return {
    path: resolve(worktreePath),
    repoRoot: gitMarkers.repoRoot,
    gitDir: gitMarkers.gitDir,
    commonGitDir: gitMarkers.commonGitDir,
    branch: headState.branch,
    head: headState.head,
    probeMode: "filesystem",
    dirty: false,
    statusLines: [],
    normalizedStatusLines: [],
    managedDirtyPaths: [],
    unmanagedDirtyPaths: [],
    managedControlSurfaceOnly: false,
    stable: false,
    transient: false,
    attempts: 0,
  };
}

function readRepositoryMetadata(repoRoot: string): {
  gitDir: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null;
} {
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

async function readStableWorktreeSnapshot(
  repoRoot: string,
  options: WorktreeStateProbeOptions,
): Promise<{
  snapshot: WorktreeProbeSnapshot;
  stable: boolean;
  transient: boolean;
  reason?: "transient_git_state";
  attempts: number;
}> {
  const maxAttempts = Math.max(2, options.maxAttempts ?? 4);
  const debounceMs = Math.max(0, options.debounceMs ?? 25);

  let previous: WorktreeProbeSnapshot | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    const current = readWorktreeSnapshot(repoRoot);
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
    snapshot: previous ?? readWorktreeSnapshot(repoRoot),
    stable: false,
    transient: true,
    reason: "transient_git_state",
    attempts,
  };
}

function readWorktreeSnapshot(repoRoot: string): WorktreeProbeSnapshot {
  const metadata = readRepositoryMetadata(repoRoot);
  const result = runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot });
  const statusLines = commandSucceeded(result)
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
    : [];

  return {
    ...metadata,
    ...classifyManagedControlSurfacePaths(statusLines),
  };
}

function snapshotsMatch(left: WorktreeProbeSnapshot, right: WorktreeProbeSnapshot): boolean {
  return (
    left.gitDir === right.gitDir &&
    left.commonGitDir === right.commonGitDir &&
    left.branch === right.branch &&
    left.head === right.head &&
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

async function findGitMarkers(startPath: string): Promise<{
  repoRoot: string;
  gitDir: string;
  commonGitDir: string;
} | null> {
  let currentPath = resolve(startPath);
  const currentStat = await tryStat(currentPath);
  if (currentStat?.isFile()) {
    currentPath = dirname(currentPath);
  }

  while (true) {
    const gitMarkerPath = join(currentPath, ".git");
    const gitMarkerStat = await tryStat(gitMarkerPath);

    if (gitMarkerStat?.isDirectory()) {
      const gitDir = gitMarkerPath;
      return {
        repoRoot: currentPath,
        gitDir,
        commonGitDir: await resolveCommonGitDir(gitDir),
      };
    }

    if (gitMarkerStat?.isFile()) {
      const gitDir = await resolveGitDirFromFile(gitMarkerPath, currentPath);
      if (gitDir) {
        return {
          repoRoot: currentPath,
          gitDir,
          commonGitDir: await resolveCommonGitDir(gitDir),
        };
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

async function resolveGitDirFromFile(gitFilePath: string, repoRoot: string): Promise<string | null> {
  try {
    const contents = (await readFile(gitFilePath, "utf8")).trim();
    const prefix = "gitdir:";
    if (!contents.toLowerCase().startsWith(prefix)) {
      return null;
    }

    const gitDir = contents.slice(prefix.length).trim();
    if (!gitDir) {
      return null;
    }

    return resolve(repoRoot, gitDir);
  } catch {
    return null;
  }
}

async function resolveCommonGitDir(gitDir: string): Promise<string> {
  const commondirPath = join(gitDir, "commondir");
  try {
    const commondir = (await readFile(commondirPath, "utf8")).trim();
    if (!commondir) {
      return gitDir;
    }

    return resolve(gitDir, commondir);
  } catch {
    return gitDir;
  }
}

async function readHeadState(gitDir: string, commonGitDir: string): Promise<{
  branch: string | null;
  head: string | null;
}> {
  const headFilePath = join(gitDir, "HEAD");
  try {
    const headContents = (await readFile(headFilePath, "utf8")).trim();
    if (!headContents) {
      return { branch: null, head: null };
    }

    if (headContents.startsWith("ref:")) {
      const ref = headContents.slice("ref:".length).trim();
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
      try {
        const refContents = (await readFile(join(commonGitDir, ...ref.split("/")), "utf8")).trim();
        return {
          branch,
          head: refContents.length > 0 ? refContents : null,
        };
      } catch {
        return { branch, head: null };
      }
    }

    return {
      branch: null,
      head: headContents,
    };
  } catch {
    return {
      branch: null,
      head: null,
    };
  }
}

async function tryStat(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}
