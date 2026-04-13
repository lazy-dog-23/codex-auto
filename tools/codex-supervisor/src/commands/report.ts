import { Command } from "commander";

import type { AutonomyResults, BlockerRecord, GoalRecord, TaskRecord } from "../domain/types.js";
import { countOpenBlockers } from "../domain/autonomy.js";
import { resolveSummarySnapshot, scopeResultsSummary } from "../domain/results.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import {
  loadBlockersDocument,
  loadGoalsDocument,
  loadResultsDocument,
  loadStateDocument,
  loadTasksDocument,
} from "./control-plane.js";
import { runStatusCommand } from "./status.js";

const REPORT_BLOCKING_WARNING_CODES = new Set([
  "not_a_git_repo",
  "dirty_repository",
  "missing_background_worktree",
  "unsafe_background_worktree_path",
  "dirty_background_worktree",
  "unexpected_background_repo",
  "unexpected_background_branch",
  "background_worktree_head_mismatch",
  "active_cycle_lock",
  "stale_cycle_lock",
  "missing_report_thread_id",
]);

interface ReportWarning {
  code: string;
  message: string;
}

export interface ReportResult {
  ok: boolean;
  message: string;
  current_goal: GoalRecord | null;
  previous_goal: GoalRecord | null;
  current_task: TaskRecord | null;
  paused: boolean;
  pause_reason: string | null;
  run_mode: string | null;
  report_thread_id: string | null;
  blockers_open: number;
  open_blockers: BlockerRecord[];
  latest_verify_summary: string | null;
  latest_review_summary: string | null;
  latest_commit_hash: string | null;
  latest_commit_message: string | null;
  goal_transition: string | null;
  last_thread_summary_sent_at: string | null;
  last_inbox_run_at: string | null;
  latest_summary_kind: string | null;
  latest_summary_reason: string | null;
  has_recorded_run: boolean;
  results_scope_note: string | null;
  next_automation_reason: string | null;
  runtime_reason: string | null;
  healthy_runtime: boolean;
  runtime_warnings: ReportWarning[];
  latest_results: AutonomyResults;
}

export async function runReport(repoRoot = process.cwd()): Promise<ReportResult> {
  const status = await runStatusCommand(repoRoot);
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const [goalsDoc, tasksDoc, state, blockersDoc, resultsDoc] = await Promise.all([
    loadGoalsDocument(paths),
    loadTasksDocument(paths),
    loadStateDocument(paths),
    loadBlockersDocument(paths),
    loadResultsDocument(paths),
  ]);
  const currentGoal = goalsDoc.goals.find((goal) => goal.id === status.current_goal_id) ?? null;
  const summarySnapshot = resolveSummarySnapshot(resultsDoc, state);
  const previousGoal = resolvePreviousGoal(goalsDoc.goals, summarySnapshot.latestGoalTransition);
  const currentTask = state.current_task_id
    ? tasksDoc.tasks.find((task) => task.id === state.current_task_id) ?? null
    : tasksDoc.tasks.find((task) => task.goal_id === status.current_goal_id && task.status === "ready") ?? null;
  const openBlockers = blockersDoc.blockers.filter((blocker) => blocker.status === "open");
  const blockersOpen = countOpenBlockers(blockersDoc.blockers);
  const scopedResults = scopeResultsSummary(resultsDoc, status.current_goal_id);
  const latestVerifySummary = scopedResults.workerVerifySummary;
  const latestReviewSummary = scopedResults.reviewResult;
  const latestCommitHash = scopedResults.commitHash;
  const latestCommitMessage = scopedResults.commitMessage;
  const lastThreadSummarySentAt = status.last_thread_summary_sent_at ?? summarySnapshot.lastThreadSummarySentAt;
  const lastInboxRunAt = status.last_inbox_run_at ?? summarySnapshot.lastInboxRunAt;
  const latestSummaryKind = status.latest_summary_kind ?? summarySnapshot.latestSummaryKind;
  const latestSummaryReason = status.latest_summary_reason ?? summarySnapshot.latestSummaryReason;
  const goalTransition = latestSummaryKind === "goal_transition"
    ? buildGoalTransitionSummary(previousGoal, currentGoal, summarySnapshot.latestGoalTransition)
    : null;
  const nextAutomationReason = status.next_automation_reason ?? null;
  const runtimeWarnings = (status.warnings ?? []).filter((warning) => REPORT_BLOCKING_WARNING_CODES.has(warning.code));
  const healthyRuntime = runtimeWarnings.length === 0;
  const message = buildReportMessage({
    currentGoal,
    previousGoal,
    currentTask,
    paused: state.paused,
    pauseReason: state.pause_reason,
    blockers: openBlockers,
    verifySummary: latestVerifySummary,
    reviewSummary: latestReviewSummary,
    commitHash: latestCommitHash,
    commitMessage: latestCommitMessage,
    reportThreadId: state.report_thread_id,
    runMode: state.run_mode,
    goalTransition,
    lastThreadSummarySentAt,
    lastInboxRunAt,
    latestSummaryKind,
    latestSummaryReason,
    hasRecordedRun: summarySnapshot.hasRecordedRun,
    resultsScopeNote: scopedResults.resultsScopeNote,
    nextAutomationReason,
    runtimeWarnings,
  });

  return {
    ok: healthyRuntime,
    message,
    current_goal: currentGoal,
    previous_goal: previousGoal,
    current_task: currentTask,
    paused: state.paused,
    pause_reason: state.pause_reason,
    run_mode: state.run_mode,
    report_thread_id: state.report_thread_id,
    blockers_open: blockersOpen,
    open_blockers: openBlockers,
    latest_verify_summary: latestVerifySummary,
    latest_review_summary: latestReviewSummary,
    latest_commit_hash: latestCommitHash,
    latest_commit_message: latestCommitMessage,
    goal_transition: goalTransition,
    last_thread_summary_sent_at: lastThreadSummarySentAt,
    last_inbox_run_at: lastInboxRunAt,
    latest_summary_kind: latestSummaryKind,
    latest_summary_reason: latestSummaryReason,
    has_recorded_run: summarySnapshot.hasRecordedRun,
    results_scope_note: scopedResults.resultsScopeNote,
    next_automation_reason: nextAutomationReason,
    runtime_reason: nextAutomationReason,
    healthy_runtime: healthyRuntime,
    runtime_warnings: runtimeWarnings,
    latest_results: resultsDoc,
  };
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Summarize the current goal, task, results, and blocker state")
    .action(async () => {
      const result = await runReport();
      console.log(JSON.stringify(result, null, 2));
    });
}

function buildReportMessage(
  options: {
    currentGoal: GoalRecord | null;
    previousGoal: GoalRecord | null;
    currentTask: TaskRecord | null;
    paused: boolean;
    pauseReason: string | null;
    blockers: readonly BlockerRecord[];
    verifySummary: string | null;
    reviewSummary: string | null;
    commitHash: string | null;
    commitMessage: string | null;
    reportThreadId: string | null;
    runMode: string | null;
    goalTransition: string | null;
    lastThreadSummarySentAt: string | null;
    lastInboxRunAt: string | null;
    latestSummaryKind: string | null;
    latestSummaryReason: string | null;
    hasRecordedRun: boolean;
    resultsScopeNote: string | null;
    nextAutomationReason: string | null;
    runtimeWarnings: readonly ReportWarning[];
  },
): string {
  const goalPart = formatGoalPart(options.currentGoal);
  const previousGoalPart = options.previousGoal ? `previous_goal=${formatGoalLabel(options.previousGoal)}` : "previous_goal=none";
  const taskPart = formatTaskPart(options.currentTask);
  const verifyPart = `verify=${formatNullableValue(options.verifySummary)}`;
  const reviewPart = `review=${formatNullableValue(options.reviewSummary)}`;
  const commitPart = `commit=${formatCommitValue(options.commitHash, options.commitMessage)}`;
  const blockersPart = `open_blockers=${options.blockers.length}${formatBlockerList(options.blockers)}`;
  const pausePart = options.paused
    ? `paused=yes${options.pauseReason ? `(${options.pauseReason})` : ""}`
    : "paused=no";
  const reportThreadPart = `report_thread=${formatNullableValue(options.reportThreadId)}`;
  const runModePart = `run_mode=${formatNullableValue(options.runMode)}`;
  const transitionPart = options.goalTransition ? `goal_transition=${options.goalTransition}` : "goal_transition=none";
  const summaryKindPart = `summary_kind=${formatNullableValue(options.latestSummaryKind)}`;
  const summaryReasonPart = `summary_reason=${formatNullableValue(options.latestSummaryReason)}`;
  const recordedRunPart = `recorded_run=${options.hasRecordedRun ? "yes" : "no"}`;
  const resultsScopePart = `results_scope_note=${formatNullableValue(options.resultsScopeNote)}`;
  const threadSummaryAtPart = `last_thread_summary_sent_at=${formatNullableValue(options.lastThreadSummarySentAt)}`;
  const inboxRunAtPart = `last_inbox_run_at=${formatNullableValue(options.lastInboxRunAt)}`;
  const nextAutomationReasonPart = `next_automation_reason=${formatNullableValue(options.nextAutomationReason)}`;
  const runtimePart = formatRuntimeWarnings(options.runtimeWarnings);
  return [
    goalPart,
    previousGoalPart,
    taskPart,
    verifyPart,
    reviewPart,
    commitPart,
    blockersPart,
    pausePart,
    reportThreadPart,
    runModePart,
    transitionPart,
    summaryKindPart,
    summaryReasonPart,
    recordedRunPart,
    resultsScopePart,
    threadSummaryAtPart,
    inboxRunAtPart,
    nextAutomationReasonPart,
    runtimePart,
  ].join(" ");
}

function formatGoalPart(goal: GoalRecord | null): string {
  return goal ? `goal=${formatGoalLabel(goal)}` : "goal=none";
}

function formatGoalLabel(goal: GoalRecord): string {
  return `${goal.id}${goal.title ? `(${goal.title})` : ""}`;
}

function formatTaskPart(task: TaskRecord | null): string {
  if (!task) {
    return "task=none";
  }

  const details = [task.status, `priority=${task.priority}`];
  if (task.review_status) {
    details.push(`review=${task.review_status}`);
  }
  if (task.commit_hash) {
    details.push(`commit=${task.commit_hash}`);
  }
  return `task=${formatTaskLabel(task)}[${details.join(",")}]`;
}

function formatTaskLabel(task: TaskRecord): string {
  return `${task.id}${task.title ? `(${task.title})` : ""}`;
}

function formatNullableValue(value: string | null): string {
  return value && value.length > 0 ? value : "none";
}

function formatCommitValue(hash: string | null, message: string | null): string {
  if (!hash && !message) {
    return "none";
  }

  if (!hash) {
    return message ?? "none";
  }

  if (!message) {
    return hash;
  }

  return `${hash}:${message}`;
}

function formatBlockerList(blockers: readonly BlockerRecord[]): string {
  if (blockers.length === 0) {
    return "";
  }

  const entries = blockers.slice(0, 3).map((blocker) => `${blocker.id}/${blocker.task_id}:${blocker.severity}`);
  const remaining = blockers.length - entries.length;
  return `[${entries.join(",")}${remaining > 0 ? `,+${remaining}` : ""}]`;
}

function formatRuntimeWarnings(warnings: readonly ReportWarning[]): string {
  if (warnings.length === 0) {
    return "runtime=healthy";
  }

  const codes = warnings.map((warning) => warning.code);
  return `runtime=warning[${codes.join(",")}]`;
}

function resolvePreviousGoal(
  goals: readonly GoalRecord[],
  transition: { from_goal_id: string; to_goal_id: string; happened_at: string | null } | null,
): GoalRecord | null {
  if (!transition) {
    return null;
  }

  return goals.find((goal) => goal.id === transition.from_goal_id) ?? null;
}

function buildGoalTransitionSummary(
  previousGoal: GoalRecord | null,
  currentGoal: GoalRecord | null,
  transition: { from_goal_id: string; to_goal_id: string; happened_at: string | null } | null,
): string | null {
  if (!previousGoal || !currentGoal || !transition) {
    return null;
  }

  if (previousGoal.id !== transition.from_goal_id || currentGoal.id !== transition.to_goal_id) {
    return null;
  }

  if (previousGoal.status !== "completed" || currentGoal.status !== "active") {
    return null;
  }

  return `completed ${formatGoalLabel(previousGoal)} -> active ${formatGoalLabel(currentGoal)}`;
}
