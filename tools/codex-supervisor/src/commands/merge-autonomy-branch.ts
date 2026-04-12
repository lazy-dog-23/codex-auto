import { Command } from "commander";

import type { AutonomyResults, AutonomyState, BlockersDocument } from "../contracts/autonomy.js";
import type { CommandResult } from "../contracts/autonomy.js";
import { DEFAULT_AUTONOMY_BRANCH, detectGitRepository, getCurrentGitBranch } from "../infra/git.js";
import { runProcess, commandSucceeded } from "../infra/process.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";

export async function runMergeAutonomyBranch(repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  if (!gitRepo) {
    throw new CliError("Current workspace is not a Git repository.", CLI_EXIT_CODES.validation);
  }

  if (gitRepo.dirty) {
    throw new CliError("Current branch is dirty; merge-autonomy-branch requires a clean working tree.", CLI_EXIT_CODES.blocked);
  }

  const currentBranch = await getCurrentGitBranch(gitRepo.path);
  if (!currentBranch) {
    throw new CliError("Current branch is detached; refusing to merge autonomy branch.", CLI_EXIT_CODES.blocked);
  }

  if (currentBranch === DEFAULT_AUTONOMY_BRANCH) {
    throw new CliError("You are already on codex/autonomy; switch to the destination branch before merging.", CLI_EXIT_CODES.usage);
  }

  const [blockersDoc, state, results] = await Promise.all([
    loadBranchJson<BlockersDocument>(gitRepo.path, DEFAULT_AUTONOMY_BRANCH, "autonomy/blockers.json"),
    loadBranchJson<AutonomyState>(gitRepo.path, DEFAULT_AUTONOMY_BRANCH, "autonomy/state.json"),
    loadBranchJson<AutonomyResults>(gitRepo.path, DEFAULT_AUTONOMY_BRANCH, "autonomy/results.json"),
  ]);

  if (blockersDoc.blockers.some((blocker) => blocker.status === "open")) {
    throw new CliError("Open blockers remain; resolve them before merging codex/autonomy.", CLI_EXIT_CODES.blocked);
  }

  if (state.needs_human_review || state.cycle_status === "review_pending") {
    throw new CliError("State is review_pending; finish review before merging codex/autonomy.", CLI_EXIT_CODES.blocked);
  }

  if (results.review.status !== "passed") {
    throw new CliError("Latest review result is not passed; refusing to merge codex/autonomy.", CLI_EXIT_CODES.blocked);
  }

  const mergeResult = runProcess("git", ["merge", "--ff-only", DEFAULT_AUTONOMY_BRANCH], { cwd: gitRepo.path });
  if (!commandSucceeded(mergeResult)) {
    throw new CliError(
      `git merge --ff-only ${DEFAULT_AUTONOMY_BRANCH} failed: ${mergeResult.stderr || mergeResult.stdout || mergeResult.error || "unknown error"}`,
      CLI_EXIT_CODES.blocked,
    );
  }

  return {
    ok: true,
    message: `Merged ${DEFAULT_AUTONOMY_BRANCH} into ${currentBranch}.`,
  };
}

function loadBranchJson<T>(repoRoot: string, revision: string, relativePath: string): T {
  const gitPath = relativePath.replace(/\\/g, "/");
  const result = runProcess("git", ["show", `${revision}:${gitPath}`], { cwd: repoRoot });
  if (!commandSucceeded(result)) {
    throw new CliError(
      `Unable to read ${gitPath} from ${revision}: ${result.stderr || result.stdout || result.error || "unknown error"}`,
      CLI_EXIT_CODES.blocked,
    );
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Unable to parse ${gitPath} from ${revision}: ${message}`, CLI_EXIT_CODES.blocked);
  }
}

export function registerMergeAutonomyBranchCommand(program: Command): void {
  program
    .command("merge-autonomy-branch")
    .description("Fast-forward merge codex/autonomy into the current clean branch after review passes")
    .action(async () => {
      const result = await runMergeAutonomyBranch();
      console.log(JSON.stringify(result, null, 2));
    });
}
