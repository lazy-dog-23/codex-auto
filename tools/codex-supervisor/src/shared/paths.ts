import path from "node:path";

import type { BackgroundWorktreeSettings, RepoPaths } from "../contracts/autonomy.js";
import { DEFAULT_BACKGROUND_BRANCH } from "../contracts/autonomy.js";

const MANAGED_CONTROL_SURFACE_RELATIVE_PATHS = [
  "AGENTS.md",
  ".agents/skills/$autonomy-plan/SKILL.md",
  ".agents/skills/$autonomy-work/SKILL.md",
  ".agents/skills/$autonomy-intake/SKILL.md",
  ".agents/skills/$autonomy-review/SKILL.md",
  ".agents/skills/$autonomy-report/SKILL.md",
  ".agents/skills/$autonomy-sprint/SKILL.md",
  ".codex/config.toml",
  ".codex/environments/environment.toml",
  "scripts/setup.windows.ps1",
  "scripts/verify.ps1",
  "scripts/smoke.ps1",
  "scripts/review.ps1",
  "autonomy/goal.md",
  "autonomy/journal.md",
  "autonomy/install.json",
  "autonomy/verification.json",
  "autonomy/goals.json",
  "autonomy/proposals.json",
  "autonomy/tasks.json",
  "autonomy/state.json",
  "autonomy/settings.json",
  "autonomy/results.json",
  "autonomy/blockers.json",
  "autonomy/schema/goals.schema.json",
  "autonomy/schema/proposals.schema.json",
  "autonomy/schema/tasks.schema.json",
  "autonomy/schema/state.schema.json",
  "autonomy/schema/settings.schema.json",
  "autonomy/schema/results.schema.json",
  "autonomy/schema/blockers.schema.json",
  "autonomy/schema/verification.schema.json",
] as const;

const NORMALIZED_MANAGED_CONTROL_SURFACE_RELATIVE_PATHS = MANAGED_CONTROL_SURFACE_RELATIVE_PATHS.map((relativePath) =>
  normalizeManagedControlSurfacePath(relativePath),
);

export function resolveRepoPaths(repoRoot = process.cwd()): RepoPaths {
  const resolvedRoot = path.resolve(repoRoot);
  const autonomyDir = path.join(resolvedRoot, "autonomy");
  const codexDir = path.join(resolvedRoot, ".codex");
  const scriptsDir = path.join(resolvedRoot, "scripts");
  const cliDir = path.join(resolvedRoot, "tools", "codex-supervisor");

  return {
    repoRoot: resolvedRoot,
    autonomyDir,
    schemaDir: path.join(autonomyDir, "schema"),
    locksDir: path.join(autonomyDir, "locks"),
    tasksFile: path.join(autonomyDir, "tasks.json"),
    goalsFile: path.join(autonomyDir, "goals.json"),
    proposalsFile: path.join(autonomyDir, "proposals.json"),
    stateFile: path.join(autonomyDir, "state.json"),
    settingsFile: path.join(autonomyDir, "settings.json"),
    resultsFile: path.join(autonomyDir, "results.json"),
    installFile: path.join(autonomyDir, "install.json"),
    verificationFile: path.join(autonomyDir, "verification.json"),
    blockersFile: path.join(autonomyDir, "blockers.json"),
    journalFile: path.join(autonomyDir, "journal.md"),
    goalFile: path.join(autonomyDir, "goal.md"),
    cycleLockFile: path.join(autonomyDir, "locks", "cycle.lock"),
    agentsFile: path.join(resolvedRoot, "AGENTS.md"),
    codexDir,
    environmentFile: path.join(codexDir, "environments", "environment.toml"),
    configFile: path.join(codexDir, "config.toml"),
    scriptsDir,
    setupScript: path.join(scriptsDir, "setup.windows.ps1"),
    verifyScript: path.join(scriptsDir, "verify.ps1"),
    smokeScript: path.join(scriptsDir, "smoke.ps1"),
    reviewScript: path.join(scriptsDir, "review.ps1"),
    cliDir,
    cliPackageFile: path.join(cliDir, "package.json")
  };
}

export function getInstallMetadataPath(repoRoot = process.cwd()): string {
  return path.join(path.resolve(repoRoot), "autonomy", "install.json");
}

export function getManagedControlSurfaceRelativePaths(): string[] {
  return [...MANAGED_CONTROL_SURFACE_RELATIVE_PATHS];
}

export function isManagedControlSurfaceRelativePath(pathValue: string): boolean {
  const normalized = normalizeManagedControlSurfacePath(pathValue);
  return NORMALIZED_MANAGED_CONTROL_SURFACE_RELATIVE_PATHS.some((managedPath) =>
    normalized === managedPath || normalized.startsWith(`${managedPath}/`),
  );
}

export function getManagedControlSurfacePaths(repoRoot = process.cwd()): string[] {
  const resolvedRoot = path.resolve(repoRoot);
  return MANAGED_CONTROL_SURFACE_RELATIVE_PATHS.map((relativePath) => path.join(resolvedRoot, relativePath));
}

export function getBackgroundWorktreeSettings(repoRoot = process.cwd()): BackgroundWorktreeSettings {
  const resolvedRoot = path.resolve(repoRoot);
  const parentDir = path.dirname(resolvedRoot);
  const repoName = path.basename(resolvedRoot);

  return {
    branch: DEFAULT_BACKGROUND_BRANCH,
    path: path.join(parentDir, `${repoName}.__codex_bg`)
  };
}

export function resolveRepoRoot(repoRoot = process.cwd()): string {
  return path.resolve(repoRoot);
}

function normalizeManagedControlSurfacePath(pathValue: string): string {
  return pathValue
    .replace(/^"+|"+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}
