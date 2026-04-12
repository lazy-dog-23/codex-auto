import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { loadStateDocument, writeStateDocument } from "./control-plane.js";

export async function runResume(repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy resume");

  try {
    const state = await loadStateDocument(paths);
    if (!state.current_goal_id) {
      throw new CliError("No active goal is currently running.", CLI_EXIT_CODES.usage);
    }

    const now = new Date().toISOString();
    const updatedState = {
      ...state,
      paused: false,
      pause_reason: null,
      sprint_active: state.run_mode === "sprint",
    };

    await writeStateDocument(paths, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: state.current_goal_id,
      result: "planned",
      summary: `Resumed goal ${state.current_goal_id}.`,
      verify: "not run (codex-autonomy resume)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Resumed goal ${state.current_goal_id}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume the current paused goal")
    .action(async () => {
      const result = await runResume();
      console.log(JSON.stringify(result, null, 2));
    });
}
