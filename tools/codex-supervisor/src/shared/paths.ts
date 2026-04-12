import path from "node:path";

import type { BackgroundWorktreeSettings, RepoPaths } from "../contracts/autonomy.js";
import { DEFAULT_BACKGROUND_BRANCH } from "../contracts/autonomy.js";

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
