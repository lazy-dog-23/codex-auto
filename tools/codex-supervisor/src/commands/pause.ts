import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { loadStateDocument, writeStateDocument } from "./control-plane.js";

export async function runPause(reason: string | undefined, repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy pause");

  try {
    const state = await loadStateDocument(paths);
    if (!state.current_goal_id) {
      throw new CliError("No active goal is currently running.", CLI_EXIT_CODES.usage);
    }

    const now = new Date().toISOString();
    const pauseReason = reason?.trim() || "Paused by operator.";
    const updatedState = {
      ...state,
      paused: true,
      pause_reason: pauseReason,
      sprint_active: false,
    };

    await writeStateDocument(paths, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: state.current_goal_id,
      result: "blocked",
      summary: `Paused goal ${state.current_goal_id}.`,
      verify: "not run (codex-autonomy pause)",
      blocker: pauseReason,
    });

    return {
      ok: true,
      message: `Paused goal ${state.current_goal_id}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerPauseCommand(program: Command): void {
  program
    .command("pause")
    .option("--reason <reason>", "Why the current goal is being paused")
    .description("Pause the current goal without cancelling it")
    .action(async (options: { reason?: string }) => {
      const result = await runPause(options.reason);
      console.log(JSON.stringify(result, null, 2));
    });
}
