import { Command } from "commander";

import type { BlockersDocument, StatusSummary, TasksDocument, AutonomyState, TaskStatus } from "../contracts/autonomy.js";
import { countOpenBlockers } from "../domain/autonomy.js";
import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, detectGitRepository, getBackgroundWorktreePath, getWorktreeSummary } from "../infra/git.js";
import { readJsonFile } from "../infra/json.js";
import { inspectCycleLock } from "../infra/lock.js";
import { discoverPowerShellExecutable, detectCodexProcess } from "../infra/process.js";
import { resolveRepoPaths } from "../shared/paths.js";

function createEmptyTaskCounts(): Record<TaskStatus, number> {
  return {
    queued: 0,
    ready: 0,
    in_progress: 0,
    verify_failed: 0,
    blocked: 0,
    done: 0,
  };
}

function countTaskStatuses(tasks: TasksDocument["tasks"]): Record<TaskStatus, number> {
  const counts = createEmptyTaskCounts();

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  return counts;
}

function buildMessage(summary: StatusSummary): string {
  const nextAutomation = summary.ready_for_automation ? "yes" : "no";
  return [
    `Tasks=${summary.total_tasks}`,
    `ready=${summary.tasks_by_status.ready}`,
    `open_blockers=${summary.open_blocker_count}`,
    `last_result=${summary.last_result}`,
    `ready_for_automation=${nextAutomation}`,
  ].join(" ");
}

export function buildStatusSummary(
  tasksDoc: TasksDocument,
  state: AutonomyState,
  blockersDoc: BlockersDocument,
): StatusSummary {
  const openBlockerCount = countOpenBlockers(blockersDoc.blockers);
  const tasksByStatus = countTaskStatuses(tasksDoc.tasks);
  const actionableTasks = tasksDoc.tasks.some((task) =>
    task.status === "ready" || task.status === "queued" || task.status === "verify_failed",
  );
  const readyForAutomation =
    state.cycle_status === "idle" &&
    state.needs_human_review === false &&
    openBlockerCount === 0 &&
    actionableTasks;
  const warnings =
    state.open_blocker_count === openBlockerCount
      ? undefined
      : [
          {
            code: "open_blocker_count_mismatch",
            message: `State reported ${state.open_blocker_count} open blocker(s), but blockers.json contains ${openBlockerCount}.`,
          },
        ];

  return {
    ok: true,
    message: buildMessage({
      ok: true,
      message: "",
      total_tasks: tasksDoc.tasks.length,
      tasks_by_status: tasksByStatus,
      current_task_id: state.current_task_id,
      cycle_status: state.cycle_status,
      open_blocker_count: openBlockerCount,
      last_result: state.last_result,
      ready_for_automation: readyForAutomation,
    }),
    warnings,
    total_tasks: tasksDoc.tasks.length,
    tasks_by_status: tasksByStatus,
    current_task_id: state.current_task_id,
    cycle_status: state.cycle_status,
    open_blocker_count: openBlockerCount,
    last_result: state.last_result,
    ready_for_automation: readyForAutomation,
  };
}

export async function runStatusCommand(repoRoot = process.cwd()): Promise<StatusSummary> {
  const gitRepo = await detectGitRepository(repoRoot);
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const tasksDoc = await readJsonFile<TasksDocument>(paths.tasksFile);
  const state = await readJsonFile<AutonomyState>(paths.stateFile);
  const blockersDoc = await readJsonFile<BlockersDocument>(paths.blockersFile);
  const summary = buildStatusSummary(tasksDoc, state, blockersDoc);
  const warnings = [...(summary.warnings ?? [])];
  let readyForAutomation = summary.ready_for_automation;

  if (!gitRepo) {
    readyForAutomation = false;
    warnings.push({
      code: "not_a_git_repo",
      message: "Current workspace is not a Git repository, so automation cannot run yet.",
    });
  } else {
    if (gitRepo.dirty) {
      readyForAutomation = false;
      warnings.push({
        code: "dirty_repository",
        message: "Current repository is dirty.",
      });
    }

    const backgroundPath = getBackgroundWorktreePath(gitRepo.path);
    const backgroundWorktree = await getWorktreeSummary(backgroundPath);
    if (!backgroundWorktree) {
      readyForAutomation = false;
      warnings.push({
        code: "missing_background_worktree",
        message: `Background worktree is missing at ${backgroundPath}.`,
      });
    } else {
      if (backgroundWorktree.dirty) {
        readyForAutomation = false;
        warnings.push({
          code: "dirty_background_worktree",
          message: `Background worktree is dirty at ${backgroundPath}.`,
        });
      }

      if (backgroundWorktree.commonGitDir !== gitRepo.commonGitDir) {
        readyForAutomation = false;
        warnings.push({
          code: "unexpected_background_repo",
          message: `Background worktree belongs to ${backgroundWorktree.commonGitDir}, expected ${gitRepo.commonGitDir}.`,
        });
      }

      if (backgroundWorktree.branch !== DEFAULT_BACKGROUND_WORKTREE_BRANCH) {
        readyForAutomation = false;
        warnings.push({
          code: "unexpected_background_branch",
          message: `Background worktree is on ${backgroundWorktree.branch ?? "detached HEAD"}, expected ${DEFAULT_BACKGROUND_WORKTREE_BRANCH}.`,
        });
      }

      if (gitRepo.head && backgroundWorktree.head && backgroundWorktree.head !== gitRepo.head) {
        readyForAutomation = false;
        warnings.push({
          code: "background_worktree_head_mismatch",
          message: `Background worktree is at ${backgroundWorktree.head}, expected ${gitRepo.head}.`,
        });
      }
    }
  }

  const lock = await inspectCycleLock(paths.cycleLockFile);
  if (lock.exists) {
    readyForAutomation = false;
    warnings.push({
      code: lock.stale ? "stale_cycle_lock" : "active_cycle_lock",
      message: lock.stale ? lock.reason ?? "Cycle lock is stale." : "Cycle lock is active.",
    });
  }

  const powershell = discoverPowerShellExecutable();
  const codexProcess = detectCodexProcess(powershell ?? undefined);
  if (!codexProcess.probeOk) {
    readyForAutomation = false;
    warnings.push({
      code: "codex_process_probe_failed",
      message: codexProcess.error ?? "Codex process probe failed.",
    });
  } else if (!codexProcess.running) {
    readyForAutomation = false;
    warnings.push({
      code: "codex_not_running",
      message: "Codex process was not detected.",
    });
  }

  return {
    ...summary,
    message: buildMessage({ ...summary, ready_for_automation: readyForAutomation }),
    ready_for_automation: readyForAutomation,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Summarize autonomy task, blocker, and state progress")
    .action(async () => {
      const result = await runStatusCommand();
      console.log(JSON.stringify(result, null, 2));
    });
}
