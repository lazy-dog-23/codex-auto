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
import { resolveSummarySnapshot, scopeResultsSummary } from "../domain/results.js";
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

function resolveCurrentGoalId(goals: GoalsDocument["goals"], state: AutonomyState): string | null {
  const activeGoals = goals.filter((goal) => goal.status === "active");
  if (activeGoals.length > 1) {
    return null;
  }

  if (state.current_goal_id) {
    const currentGoal = goals.find((goal) => goal.id === state.current_goal_id);
    if (currentGoal?.status === "active") {
      return currentGoal.id;
    }
  }

  return activeGoals[0]?.id ?? null;
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
    `recorded_run=${summary.has_recorded_run ? "yes" : "no"}`,
    `results_scope_note=${formatNullableText(summary.results_scope_note)}`,
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
  goalPointerMismatch: boolean;
  multipleActiveGoals: boolean;
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

  if (options.multipleActiveGoals) {
    return "goals.json contains multiple active goals; automation must stop until one active goal remains.";
  }

  if (options.goalPointerMismatch) {
    return "state.json current_goal_id does not resolve to the single active goal.";
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
  const activeGoalCount = goalsDoc.goals.filter((goal) => goal.status === "active").length;
  const resolvedCurrentGoalId = resolveCurrentGoalId(goalsDoc.goals, state);
  const goalPointerMismatch = Boolean(state.current_goal_id) && state.current_goal_id !== resolvedCurrentGoalId;
  const actionableTasks = hasActionableTasks(tasksDoc.tasks, resolvedCurrentGoalId);
  const pendingPlanningWork = hasPlanningWork(goalsDoc.goals);
  const hasReportThread = Boolean(state.report_thread_id?.trim());
  const readyForAutomation =
    activeGoalCount <= 1 &&
    goalPointerMismatch === false &&
    state.cycle_status === "idle" &&
    state.needs_human_review === false &&
    state.paused === false &&
    hasReportThread &&
    openBlockerCount === 0 &&
    (actionableTasks || pendingPlanningWork);
  const summarySnapshot = resolveSummarySnapshot(resultsDoc, state);
  const scopedResults = scopeResultsSummary(resultsDoc, resolvedCurrentGoalId);

  const warnings =
    [
      ...(state.open_blocker_count === openBlockerCount
        ? []
        : [
            {
              code: "open_blocker_count_mismatch",
              message: `State reported ${state.open_blocker_count} open blocker(s), but blockers.json contains ${openBlockerCount}.`,
            },
          ]),
      ...(!state.current_goal_id && resolvedCurrentGoalId
        ? [
            {
              code: "current_goal_recovered",
              message: `Recovered current goal ${resolvedCurrentGoalId} from goals.json because state.json did not record current_goal_id.`,
            },
          ]
        : []),
      ...(state.current_goal_id && !goalsDoc.goals.some((goal) => goal.id === state.current_goal_id)
        ? [
            {
              code: "stale_current_goal_id",
              message: `state.json points to missing current_goal_id ${state.current_goal_id}.`,
            },
          ]
        : []),
      ...(state.current_goal_id && goalsDoc.goals.some((goal) => goal.id === state.current_goal_id && goal.status !== "active")
        ? [
            {
              code: "inactive_current_goal_id",
              message: `state.json points to ${state.current_goal_id}, but that goal is not active in goals.json.`,
            },
          ]
        : []),
      ...(activeGoalCount > 1
        ? [
            {
              code: "multiple_active_goals",
              message: "goals.json contains multiple active goals; automation must stop until one active goal remains.",
            },
          ]
        : []),
    ];
  const nextAutomationReason = buildLocalAutomationReason({
    readyForAutomation,
    actionableTasks,
    pendingPlanningWork,
    hasReportThread,
    goalPointerMismatch,
    multipleActiveGoals: activeGoalCount > 1,
    paused: state.paused,
    pauseReason: state.pause_reason,
    cycleStatus: state.cycle_status,
    needsHumanReview: state.needs_human_review,
    openBlockerCount,
  });

  const summary: StatusSummary = {
    ok: true,
    message: "",
    warnings,
    total_tasks: tasksDoc.tasks.length,
    total_goals: goalsDoc.goals.length,
    tasks_by_status: tasksByStatus,
    goals_by_status: goalsByStatus,
    current_goal_id: resolvedCurrentGoalId,
    current_task_id: state.current_task_id,
    cycle_status: state.cycle_status,
    run_mode: state.run_mode,
    open_blocker_count: openBlockerCount,
    last_result: state.last_result,
    ready_for_automation: readyForAutomation,
    paused: state.paused,
    review_pending_reason: state.pause_reason,
    latest_commit_hash: scopedResults.commitHash,
    latest_commit_message: scopedResults.commitMessage,
    report_thread_id: state.report_thread_id,
    autonomy_branch: state.autonomy_branch,
    sprint_active: state.sprint_active,
    last_thread_summary_sent_at: summarySnapshot.lastThreadSummarySentAt,
    last_inbox_run_at: summarySnapshot.lastInboxRunAt,
    latest_summary_kind: summarySnapshot.latestSummaryKind,
    latest_summary_reason: summarySnapshot.latestSummaryReason,
    has_recorded_run: summarySnapshot.hasRecordedRun,
    results_scope_note: scopedResults.resultsScopeNote,
    next_automation_reason: nextAutomationReason,
    results_summary: {
      planner_summary: scopedResults.plannerSummary,
      worker_result: scopedResults.workerResult,
      review_result: scopedResults.reviewResult,
      commit_result: scopedResults.commitMessage,
      reporter_sent_at: resultsDoc.reporter.sent_at ?? resultsDoc.reporter.happened_at ?? null,
    },
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
  const hasEligibleWork = hasActionableTasks(tasksDoc.tasks, summary.current_goal_id) || hasPlanningWork(goalsDoc.goals);
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
