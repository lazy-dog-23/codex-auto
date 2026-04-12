import { Command } from "commander";

import type { CommandResult, GoalsDocument, RunMode } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { loadGoalsDocument, loadStateDocument, writeGoalsDocument, writeStateDocument } from "./control-plane.js";

export async function runSetRunMode(goalId: string, runMode: RunMode, repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy set-run-mode");

  try {
    const now = new Date().toISOString();
    const goalsDoc = await loadGoalsDocument(paths);
    const state = await loadStateDocument(paths);
    const goal = goalsDoc.goals.find((entry) => entry.id === goalId);
    if (!goal) {
      throw new CliError(`Goal not found: ${goalId}`, CLI_EXIT_CODES.usage);
    }

    const updatedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: goalsDoc.goals.map((entry) =>
        entry.id === goalId
          ? {
              ...entry,
              run_mode: runMode,
            }
          : entry,
      ),
    };
    const updatedState = goalId === state.current_goal_id
      ? {
          ...state,
          run_mode: runMode,
          sprint_active: runMode === "sprint" && !state.paused,
        }
      : state;

    await writeGoalsDocument(paths, updatedGoals);
    await writeStateDocument(paths, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: goalId,
      result: "planned",
      summary: `Set run mode for ${goalId} to ${runMode}.`,
      verify: "not run (codex-autonomy set-run-mode)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Run mode for ${goalId} is now ${runMode}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerSetRunModeCommand(program: Command): void {
  program
    .command("set-run-mode")
    .argument("<goal-id>", "Goal id to update")
    .argument("<run-mode>", "sprint or cruise")
    .description("Update the run mode for a goal")
    .action(async (goalId: string, runMode: string) => {
      if (runMode !== "sprint" && runMode !== "cruise") {
        throw new CliError("run-mode must be sprint or cruise.", CLI_EXIT_CODES.usage);
      }

      const result = await runSetRunMode(goalId, runMode);
      console.log(JSON.stringify(result, null, 2));
    });
}
