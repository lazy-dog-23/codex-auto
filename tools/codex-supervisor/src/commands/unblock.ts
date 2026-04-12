import { Command } from "commander";

import type { BlockersDocument, CommandResult, TasksDocument } from "../contracts/autonomy.js";
import { detectGitRepository } from "../infra/git.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { loadJsonFile, writeJsonAtomic } from "../infra/fs.js";
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

    const updatedTasks: TasksDocument = {
      ...tasksDoc,
      tasks: tasksDoc.tasks.map((task) => (task.id === taskId ? recoveredTask : task)),
    };

    await writeJsonAtomic(paths.blockersFile, updatedBlockers);
    await writeJsonAtomic(paths.tasksFile, updatedTasks);

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
