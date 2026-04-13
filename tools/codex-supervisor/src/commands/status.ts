import { Command } from "commander";

import type {
  AutonomyResults,
  AutonomyState,
  BlockersDocument,
  GoalStatus,
  GoalsDocument,
  StatusSummary,
  SummaryKind,
  TaskStatus,
  TasksDocument,
} from "../contracts/autonomy.js";
import { GOAL_STATUSES, TASK_STATUSES } from "../contracts/autonomy.js";
import { countOpenBlockers } from "../domain/autonomy.js";
import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, detectGitRepository, getBackgroundWorktreePath, getWorktreeSummary } from "../infra/git.js";
import { inspectCycleLock } from "../infra/lock.js";
import { discoverPowerShellExecutable, detectCodexProcess } from "../infra/process.js";
import { resolveRepoPaths } from "../shared/paths.js";
import {
  loadBlockersDocument,
  loadGoalsDocument,
  loadResultsDocument,
  loadStateDocument,
  loadTasksDocument,
} from "./control-plane.js";

function createEmptyTaskCounts(): Record<TaskStatus, number> {
  return TASK_STATUSES.reduce((accumulator, status) => {
    accumulator[status] = 0;
    return accumulator;
  }, {} as Record<TaskStatus, number>);
}

function createEmptyGoalCounts(): Record<GoalStatus, number> {
  return GOAL_STATUSES.reduce((accumulator, status) => {
    accumulator[status] = 0;
    return accumulator;
  }, {} as Record<GoalStatus, number>);
}

function countTaskStatuses(tasks: TasksDocument["tasks"]): Record<TaskStatus, number> {
  const counts = createEmptyTaskCounts();
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

function countGoalStatuses(goals: GoalsDocument["goals"]): Record<GoalStatus, number> {
  const counts = createEmptyGoalCounts();
  for (const goal of goals) {
    counts[goal.status] += 1;
  }
  return counts;
}

function hasActionableTasks(tasks: TasksDocument["tasks"], currentGoalId: string | null): boolean {
  if (!currentGoalId) {
    return false;
  }

  return tasks.some(
    (task) => task.goal_id === currentGoalId && (task.status === "ready" || task.status === "queued"),
  );
}

function hasPlanningWork(goals: GoalsDocument["goals"]): boolean {
  return goals.some((goal) => goal.status === "awaiting_confirmation" || goal.status === "approved");
}

function formatNullableText(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "none";
}

function buildMessage(summary: StatusSummary): string {
  return [
    `goals=${summary.total_goals}`,
    `tasks=${summary.total_tasks}`,
    `current_goal=${formatNullableText(summary.current_goal_id)}`,
    `current_task=${formatNullableText(summary.current_task_id)}`,
    `run_mode=${formatNullableText(summary.run_mode)}`,
    `paused=${summary.paused ? "yes" : "no"}`,
    `open_blockers=${summary.open_blocker_count}`,
    `last_result=${summary.last_result}`,
    `commit=${formatNullableText(summary.latest_commit_hash)}`,
    `report_thread=${formatNullableText(summary.report_thread_id)}`,
    `autonomy_branch=${formatNullableText(summary.autonomy_branch)}`,
    `summary_kind=${formatNullableText(summary.latest_summary_kind)}`,
    `summary_reason=${formatNullableText(summary.latest_summary_reason)}`,
    `last_thread_summary_sent_at=${formatNullableText(summary.last_thread_summary_sent_at)}`,
    `last_inbox_run_at=${formatNullableText(summary.last_inbox_run_at)}`,
    `next_automation_reason=${formatNullableText(summary.next_automation_reason)}`,
    `ready_for_automation=${summary.ready_for_automation ? "yes" : "no"}`,
  ].join(" ");
}

function buildLocalAutomationReason(options: {
  readyForAutomation: boolean;
  actionableTasks: boolean;
  pendingPlanningWork: boolean;
  hasReportThread: boolean;
  paused: boolean;
  pauseReason: string | null;
  cycleStatus: StatusSummary["cycle_status"];
  needsHumanReview: boolean;
  openBlockerCount: number;
}): string {
  if (options.readyForAutomation) {
    return "Ready for automation: active or planning work is available.";
  }

  if (!options.hasReportThread && (options.actionableTasks || options.pendingPlanningWork)) {
    return "Bind report_thread_id from the originating thread before automation can run.";
  }

  if (options.paused) {
    return options.pauseReason ?? "Current goal is paused.";
  }

  if (options.needsHumanReview) {
    return "State requires human review before the next automation run.";
  }

  if (options.cycleStatus !== "idle") {
    return `Current cycle status is ${options.cycleStatus}.`;
  }

  if (options.openBlockerCount > 0) {
    return `There ${options.openBlockerCount === 1 ? "is" : "are"} ${options.openBlockerCount} open blocker(s).`;
  }

  if (!options.actionableTasks && !options.pendingPlanningWork) {
    return "No active goal work or proposal generation work is currently available.";
  }

  return "Eligible work is available, but runtime checks need to pass before the next automation run.";
}

function buildRuntimeAutomationReason(warnings: readonly { message: string }[]): string {
  if (warnings.length === 0) {
    return "Ready for automation: runtime checks passed.";
  }

  return warnings.map((warning) => warning.message).join("; ");
}

function inferLatestSummaryKind(resultsDoc: AutonomyResults, _goalsDoc: GoalsDocument, state: AutonomyState): SummaryKind {
  if (resultsDoc.worker.status === "failed" || resultsDoc.review.status === "failed" || resultsDoc.commit.status === "failed") {
    return "immediate_exception";
  }

  if (resultsDoc.last_summary_kind) {
    return resultsDoc.last_summary_kind;
  }

  if (resultsDoc.reporter.sent_at || state.last_thread_summary_sent_at || resultsDoc.last_thread_summary_sent_at) {
    return "thread_summary";
  }

  return "normal_success";
}

function inferLatestSummaryReason(options: {
  kind: SummaryKind;
  resultsDoc: AutonomyResults;
  goalsDoc: GoalsDocument;
  state: AutonomyState;
}): string {
  const kind = options.kind;

  if (options.resultsDoc.last_summary_kind === kind && options.resultsDoc.last_summary_reason) {
    return options.resultsDoc.last_summary_reason;
  }

  if (kind === "goal_transition") {
    return "The previous goal completed and the next approved goal is active.";
  }

  if (kind === "thread_summary") {
    return "The latest successful run was summarized to the thread.";
  }

  if (kind === "immediate_exception") {
    return "A worker, review, or commit step failed and needs immediate attention.";
  }

  return "The latest run completed successfully and is waiting for summary handling.";
}

function summarizeResults(results: AutonomyResults): StatusSummary["results_summary"] {
  return {
    planner_summary: results.planner.summary,
    worker_result: results.worker.summary,
    review_result: results.review.summary,
    commit_result: results.commit.message ?? results.commit.summary,
    reporter_sent_at: results.reporter.sent_at ?? results.reporter.happened_at ?? null,
  };
}

export function buildStatusSummary(
  tasksDoc: TasksDocument,
  goalsDoc: GoalsDocument,
  state: AutonomyState,
  blockersDoc: BlockersDocument,
  resultsDoc: AutonomyResults,
): StatusSummary {
  const openBlockerCount = countOpenBlockers(blockersDoc.blockers);
  const tasksByStatus = countTaskStatuses(tasksDoc.tasks);
  const goalsByStatus = countGoalStatuses(goalsDoc.goals);
  const actionableTasks = hasActionableTasks(tasksDoc.tasks, state.current_goal_id);
  const pendingPlanningWork = hasPlanningWork(goalsDoc.goals);
  const hasReportThread = Boolean(state.report_thread_id?.trim());
  const readyForAutomation =
    state.cycle_status === "idle" &&
    state.needs_human_review === false &&
    state.paused === false &&
    hasReportThread &&
    openBlockerCount === 0 &&
    (actionableTasks || pendingPlanningWork);

  const warnings =
    state.open_blocker_count === openBlockerCount
      ? undefined
      : [
          {
            code: "open_blocker_count_mismatch",
            message: `State reported ${state.open_blocker_count} open blocker(s), but blockers.json contains ${openBlockerCount}.`,
          },
        ];
  const nextAutomationReason = buildLocalAutomationReason({
    readyForAutomation,
    actionableTasks,
    pendingPlanningWork,
    hasReportThread,
    paused: state.paused,
    pauseReason: state.pause_reason,
    cycleStatus: state.cycle_status,
    needsHumanReview: state.needs_human_review,
    openBlockerCount,
  });
  const latestSummaryKind = inferLatestSummaryKind(resultsDoc, goalsDoc, state);
  const latestSummaryReason = inferLatestSummaryReason({ kind: latestSummaryKind, resultsDoc, goalsDoc, state });

  const summary: StatusSummary = {
    ok: true,
    message: "",
    warnings,
    total_tasks: tasksDoc.tasks.length,
    total_goals: goalsDoc.goals.length,
    tasks_by_status: tasksByStatus,
    goals_by_status: goalsByStatus,
    current_goal_id: state.current_goal_id,
    current_task_id: state.current_task_id,
    cycle_status: state.cycle_status,
    run_mode: state.run_mode,
    open_blocker_count: openBlockerCount,
    last_result: state.last_result,
    ready_for_automation: readyForAutomation,
    paused: state.paused,
    review_pending_reason: state.pause_reason,
    latest_commit_hash: resultsDoc.commit.hash ?? null,
    latest_commit_message: resultsDoc.commit.message ?? resultsDoc.commit.summary ?? null,
    report_thread_id: state.report_thread_id,
    autonomy_branch: state.autonomy_branch,
    sprint_active: state.sprint_active,
    last_thread_summary_sent_at: state.last_thread_summary_sent_at ?? resultsDoc.last_thread_summary_sent_at ?? null,
    last_inbox_run_at: state.last_inbox_run_at ?? resultsDoc.last_inbox_run_at ?? null,
    latest_summary_kind: latestSummaryKind,
    latest_summary_reason: latestSummaryReason,
    next_automation_reason: nextAutomationReason,
    results_summary: summarizeResults(resultsDoc),
    next_automation_ready: readyForAutomation,
  };

  return {
    ...summary,
    message: buildMessage(summary),
  };
}

export async function runStatusCommand(repoRoot = process.cwd()): Promise<StatusSummary> {
  const gitRepo = await detectGitRepository(repoRoot);
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [tasksDoc, goalsDoc, state, blockersDoc, resultsDoc] = await Promise.all([
    loadTasksDocument(paths),
    loadGoalsDocument(paths),
    loadStateDocument(paths),
    loadBlockersDocument(paths),
    loadResultsDocument(paths),
  ]);
  const summary = buildStatusSummary(tasksDoc, goalsDoc, state, blockersDoc, resultsDoc);
  const warnings = [...(summary.warnings ?? [])];
  let readyForAutomation = summary.ready_for_automation;
  const hasEligibleWork = hasActionableTasks(tasksDoc.tasks, state.current_goal_id) || hasPlanningWork(goalsDoc.goals);
  const hasReportThread = Boolean(state.report_thread_id?.trim());

  if (!hasEligibleWork) {
    readyForAutomation = false;
    warnings.push({
      code: "no_actionable_work",
      message: "No active goal work or proposal generation work is currently available.",
    });
  }

  if (!hasReportThread && hasEligibleWork) {
    readyForAutomation = false;
    warnings.push({
      code: "missing_report_thread_id",
      message: "report_thread_id is not bound to the originating thread yet.",
    });
  }

  if (state.cycle_status !== "idle") {
    readyForAutomation = false;
    warnings.push({
      code: "cycle_not_idle",
      message: `Current cycle status is ${state.cycle_status}.`,
    });
  }

  if (state.needs_human_review) {
    readyForAutomation = false;
    warnings.push({
      code: "needs_human_review",
      message: "State requires human review before the next automation run.",
    });
  }

  if (state.paused) {
    readyForAutomation = false;
    warnings.push({
      code: "goal_paused",
      message: state.pause_reason ?? "Current goal is paused.",
    });
  }

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
    let backgroundWorktree = null;
    try {
      backgroundWorktree = await getWorktreeSummary(backgroundPath);
    } catch (error) {
      readyForAutomation = false;
      warnings.push({
        code: "unsafe_background_worktree_path",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!backgroundWorktree) {
      if (!warnings.some((warning) => warning.code === "unsafe_background_worktree_path")) {
        readyForAutomation = false;
        warnings.push({
          code: "missing_background_worktree",
          message: `Background worktree is missing at ${backgroundPath}.`,
        });
      }
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

  const nextAutomationReason = readyForAutomation
    ? "Ready for automation: runtime checks passed and eligible work exists."
    : buildRuntimeAutomationReason(warnings);

  const result: StatusSummary = {
    ...summary,
    ready_for_automation: readyForAutomation,
    next_automation_ready: readyForAutomation,
    next_automation_reason: nextAutomationReason,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return {
    ...result,
    message: buildMessage(result),
  };
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Summarize autonomy goals, tasks, results, and next-run readiness")
    .action(async () => {
      const result = await runStatusCommand();
      console.log(JSON.stringify(result, null, 2));
    });
}
