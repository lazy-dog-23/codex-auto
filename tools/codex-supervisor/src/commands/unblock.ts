import { Command } from "commander";

import type { AutonomyState, BlockersDocument, CommandResult, TasksDocument } from "../contracts/autonomy.js";
import { detectGitRepository } from "../infra/git.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { loadJsonFile, writeJsonAtomic } from "../infra/fs.js";
import { appendJournalEntry } from "../infra/journal.js";
import {
  areDependenciesSatisfied,
  buildTaskIndex,
  countOpenBlockersForTask,
  decideUnblockRestoration,
  resolveTaskAfterUnblock,
} from "../domain/autonomy.js";

export async function runUnblock(taskId: string, repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-supervisor unblock");

  try {
    const blockersDoc = await loadJsonFile<BlockersDocument>(paths.blockersFile);
    const tasksDoc = await loadJsonFile<TasksDocument>(paths.tasksFile);
    const state = await loadJsonFile<AutonomyState>(paths.stateFile);

    const targetTask = tasksDoc.tasks.find((task) => task.id === taskId);
    if (!targetTask) {
      throw new CliError(`Task not found: ${taskId}`, CLI_EXIT_CODES.usage);
    }

    let resolvedCount = 0;
    const updatedBlockers: BlockersDocument = {
      ...blockersDoc,
      blockers: blockersDoc.blockers.map((blocker) => {
        if (blocker.task_id !== taskId || blocker.status === "resolved") {
          return blocker;
        }

        resolvedCount += 1;
        return {
          ...blocker,
          status: "resolved",
          resolution: "Resolved via codex-supervisor unblock",
          resolved_at: new Date().toISOString()
        };
      })
    };

    const now = new Date().toISOString();
    const taskIndex = buildTaskIndex(tasksDoc.tasks);
    const dependenciesSatisfied = areDependenciesSatisfied(targetTask, taskIndex);
    const readyCount = tasksDoc.tasks.filter((task) => task.id !== taskId && task.status === "ready").length;
    const decision = decideUnblockRestoration({
      openBlockerCountForTask: countOpenBlockersForTask(updatedBlockers.blockers, taskId),
      dependenciesSatisfied,
      readyCount,
    });
    const recoveredTask = resolveTaskAfterUnblock(targetTask, decision, now).task;
    const taskChanged =
      recoveredTask.status !== targetTask.status ||
      recoveredTask.last_error !== targetTask.last_error;

    const updatedTasks: TasksDocument = {
      ...tasksDoc,
      tasks: tasksDoc.tasks.map((task) => (task.id === taskId ? recoveredTask : task)),
    };

    const openBlockerCount = updatedBlockers.blockers.filter((blocker) => blocker.status === "open").length;
    const updatedState = buildStateAfterUnblock({
      state,
      taskId,
      openBlockerCount,
      changed: taskChanged || resolvedCount > 0,
      now,
    });

    await writeJsonAtomic(paths.blockersFile, updatedBlockers);
    await writeJsonAtomic(paths.tasksFile, updatedTasks);
    await writeJsonAtomic(paths.stateFile, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId,
      result: updatedState.last_result,
      summary: buildUnblockSummary(taskId, resolvedCount, recoveredTask.status),
      verify: "not run (codex-supervisor unblock)",
      blocker: resolvedCount === 0 ? "none" : `${resolvedCount} resolved`,
    });

    return {
      ok: true,
      message:
        resolvedCount === 0
          ? `No open blockers found for ${taskId}. Task is now ${recoveredTask.status}.`
          : `Resolved ${resolvedCount} blocker(s) for ${taskId}. Task is now ${recoveredTask.status}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

function buildStateAfterUnblock(options: {
  state: AutonomyState;
  taskId: string;
  openBlockerCount: number;
  changed: boolean;
  now: string;
}): AutonomyState {
  const openBlockersRemain = options.openBlockerCount > 0;
  const shouldOwnCycleState =
    options.state.current_task_id === null || options.state.current_task_id === options.taskId;

  const baseState: AutonomyState = {
    ...options.state,
    open_blocker_count: options.openBlockerCount,
    needs_human_review: openBlockersRemain,
  };

  if (!shouldOwnCycleState) {
    return baseState;
  }

  return {
    ...baseState,
    current_task_id: null,
    cycle_status: openBlockersRemain ? "blocked" : "idle",
    last_result: openBlockersRemain ? "blocked" : (options.changed ? "planned" : "noop"),
  };
}

function buildUnblockSummary(taskId: string, resolvedCount: number, nextStatus: string): string {
  return resolvedCount === 0
    ? `No open blockers changed for ${taskId}; task remains ${nextStatus}.`
    : `Resolved ${resolvedCount} blocker(s) for ${taskId}; task moved to ${nextStatus}.`;
}

export function registerUnblockCommand(program: Command): void {
  program
    .command("unblock")
    .argument("<task-id>", "Task id to unblock")
    .description("Resolve blockers for a task and restore it to queued or ready when possible")
    .action(async (taskId: string) => {
      const result = await runUnblock(taskId);
      console.log(JSON.stringify(result, null, 2));
    });
}
