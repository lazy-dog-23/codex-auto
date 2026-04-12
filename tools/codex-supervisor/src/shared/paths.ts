import path from "node:path";

import type { BackgroundWorktreeSettings, RepoPaths } from "../contracts/autonomy.js";
import { DEFAULT_BACKGROUND_BRANCH } from "../contracts/autonomy.js";

export function resolveRepoPaths(repoRoot = process.cwd()): RepoPaths {
  const autonomyDir = path.join(repoRoot, "autonomy");
  const codexDir = path.join(repoRoot, ".codex");
  const scriptsDir = path.join(repoRoot, "scripts");
  const cliDir = path.join(repoRoot, "tools", "codex-supervisor");

  return {
    repoRoot,
    autonomyDir,
    schemaDir: path.join(autonomyDir, "schema"),
    locksDir: path.join(autonomyDir, "locks"),
    tasksFile: path.join(autonomyDir, "tasks.json"),
    stateFile: path.join(autonomyDir, "state.json"),
    blockersFile: path.join(autonomyDir, "blockers.json"),
    journalFile: path.join(autonomyDir, "journal.md"),
    goalFile: path.join(autonomyDir, "goal.md"),
    cycleLockFile: path.join(autonomyDir, "locks", "cycle.lock"),
    agentsFile: path.join(repoRoot, "AGENTS.md"),
    codexDir,
    environmentFile: path.join(codexDir, "environments", "environment.toml"),
    configFile: path.join(codexDir, "config.toml"),
    scriptsDir,
    setupScript: path.join(scriptsDir, "setup.windows.ps1"),
    verifyScript: path.join(scriptsDir, "verify.ps1"),
    smokeScript: path.join(scriptsDir, "smoke.ps1"),
    cliDir,
    cliPackageFile: path.join(cliDir, "package.json")
  };
}

export function getBackgroundWorktreeSettings(repoRoot = process.cwd()): BackgroundWorktreeSettings {
  const parentDir = path.dirname(repoRoot);
  const repoName = path.basename(repoRoot);

  return {
    branch: DEFAULT_BACKGROUND_BRANCH,
    path: path.join(parentDir, `${repoName}.__codex_bg`)
  };
}
