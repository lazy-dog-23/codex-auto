import { Command } from "commander";

import type {
  AutonomyResults,
  AutonomySettings,
  AutomationState,
  AutoContinueState,
  AutonomyState,
  BlockersDocument,
  GoalStatus,
  GoalsDocument,
  StatusSummary,
  TaskStatus,
  TasksDocument,
  VerificationDocument,
} from "../contracts/autonomy.js";
import { GOAL_STATUSES, TASK_STATUSES } from "../contracts/autonomy.js";
import { countOpenBlockers, countReadyTasksForGoal, findNextReadyTask } from "../domain/autonomy.js";
import { resolveSummarySnapshot, scopeResultsSummary } from "../domain/results.js";
import { isGoalCompletionBlockedByVerification, summarizeVerification } from "../domain/verification.js";
import { detectGlobalCliInstall } from "../infra/cli-install.js";
import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, detectGitRepository, getBackgroundWorktreePath, getWorktreeSummary } from "../infra/git.js";
import { inspectCycleLock } from "../infra/lock.js";
import { discoverPowerShellExecutable, detectCodexProcess, isChildProcessSpawnBlocked } from "../infra/process.js";
import { isAutonomyRuntimeAllowlistedPath, resolveRepoPaths } from "../shared/paths.js";
import { createDefaultAutonomySettings } from "../shared/policy.js";
import { inspectThreadBindingContext } from "../shared/thread-context.js";
import { inspectManagedUpgradeState } from "./upgrade-managed.js";
import {
  loadBlockersDocument,
  loadGoalsDocument,
  loadResultsDocument,
  loadSettingsDocument,
  loadStateDocument,
  loadTasksDocument,
  loadVerificationDocument,
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

function hasOnlyCompletedIdleWork(goalsByStatus: Record<GoalStatus, number>): boolean {
  return goalsByStatus.completed > 0
    && goalsByStatus.active === 0
    && goalsByStatus.awaiting_confirmation === 0
    && goalsByStatus.approved === 0
    && goalsByStatus.blocked === 0
    && goalsByStatus.draft === 0;
}

function buildNoWorkReason(options: {
  goalsByStatus: Record<GoalStatus, number>;
  completionBlockedByVerification: boolean;
  verificationPending: number;
}): string {
  if (options.completionBlockedByVerification) {
    return `Verification closeout is still pending for ${options.verificationPending} required axis/axes.`;
  }

  if (hasOnlyCompletedIdleWork(options.goalsByStatus)) {
    return "All approved goal work is complete. Automation is idle until a new goal or proposal is created.";
  }

  const totalGoals = GOAL_STATUSES.reduce((count, status) => count + options.goalsByStatus[status], 0);
  if (totalGoals === 0) {
    return "No goal has been created yet. Create or intake a goal before automation can run.";
  }

  return "No active goal work or proposal generation work is currently available.";
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
    `current_thread=${formatNullableText(summary.current_thread_id)}`,
    `thread_binding_state=${summary.thread_binding_state}`,
    `thread_binding_hint=${formatNullableText(summary.thread_binding_hint)}`,
    `autonomy_branch=${formatNullableText(summary.autonomy_branch)}`,
    `summary_kind=${formatNullableText(summary.latest_summary_kind)}`,
    `summary_reason=${formatNullableText(summary.latest_summary_reason)}`,
    `recorded_run=${summary.has_recorded_run ? "yes" : "no"}`,
    `results_scope_note=${formatNullableText(summary.results_scope_note)}`,
    `last_thread_summary_sent_at=${formatNullableText(summary.last_thread_summary_sent_at)}`,
    `last_inbox_run_at=${formatNullableText(summary.last_inbox_run_at)}`,
    `automation_state=${summary.automation_state}`,
    `auto_continue_state=${summary.auto_continue_state}`,
    `continuation_reason=${formatNullableText(summary.continuation_reason)}`,
    `closeout_policy=${formatNullableText(summary.closeout_policy)}`,
    `verification_required=${summary.verification_required}`,
    `verification_passed=${summary.verification_passed}`,
    `verification_pending=${summary.verification_pending}`,
    `completion_blocked_by_verification=${summary.completion_blocked_by_verification ? "yes" : "no"}`,
    `next_task=${summary.next_task_id ? `${summary.next_task_id}${summary.next_task_title ? `(${summary.next_task_title})` : ""}` : "none"}`,
    `remaining_ready=${summary.remaining_ready}`,
    `last_followup_summary=${formatNullableText(summary.last_followup_summary)}`,
    `upgrade_state=${formatNullableText(summary.upgrade_state)}`,
    `upgrade_blocking=${summary.upgrade_blocking ? "yes" : "no"}`,
    `upgrade_hint=${formatNullableText(summary.upgrade_hint)}`,
    `cli_install_state=${formatNullableText(summary.cli_install_state)}`,
    `next_automation_reason=${formatNullableText(summary.next_automation_reason)}`,
    `ready_for_automation=${summary.ready_for_automation ? "yes" : "no"}`,
  ].join(" ");
}

function buildLocalAutomationReason(options: {
  readyForAutomation: boolean;
  actionableTasks: boolean;
  pendingPlanningWork: boolean;
  goalsByStatus: Record<GoalStatus, number>;
  verificationPending: number;
  completionBlockedByVerification: boolean;
  hasReportThread: boolean;
  currentThreadId: string | null;
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
    if (options.currentThreadId) {
      return `Current thread identity is available as ${options.currentThreadId}, but report_thread_id is not bound yet. Run codex-autonomy bind-thread from this operator thread before automation can run.`;
    }

    return "Current thread identity is unavailable in this environment. Run codex-autonomy bind-thread --report-thread-id <id> before automation can run.";
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
    return buildNoWorkReason({
      goalsByStatus: options.goalsByStatus,
      completionBlockedByVerification: options.completionBlockedByVerification,
      verificationPending: options.verificationPending,
    });
  }

  return "Eligible work is available, but runtime checks need to pass before the next automation run.";
}

function resolveLocalAutomationState(options: {
  readyForAutomation: boolean;
  continuationDecision: "auto_continued" | "none" | "needs_confirmation" | null;
  paused: boolean;
  needsHumanReview: boolean;
  cycleStatus: StatusSummary["cycle_status"];
  completionBlockedByVerification: boolean;
  openBlockerCount: number;
  multipleActiveGoals: boolean;
  goalPointerMismatch: boolean;
  actionableTasks: boolean;
  pendingPlanningWork: boolean;
  goalsByStatus: Record<GoalStatus, number>;
}): AutomationState {
  if (options.continuationDecision === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.paused) {
    return "paused";
  }

  if (options.needsHumanReview || options.cycleStatus === "review_pending") {
    return "review_pending";
  }

  if (options.cycleStatus === "planning" || options.cycleStatus === "working") {
    return "in_progress";
  }

  if (options.readyForAutomation) {
    return "ready";
  }

  if (options.completionBlockedByVerification) {
    return "blocked";
  }

  if (!options.actionableTasks && !options.pendingPlanningWork) {
    return hasOnlyCompletedIdleWork(options.goalsByStatus) ? "idle_completed" : "idle_no_work";
  }

  if (options.openBlockerCount > 0 || options.multipleActiveGoals || options.goalPointerMismatch || options.cycleStatus === "blocked") {
    return "blocked";
  }

  return "blocked";
}

function buildRuntimeAutomationReason(warnings: readonly { code: string; message: string }[]): string {
  const blockingWarnings = warnings.filter((warning) => !NON_BLOCKING_RUNTIME_WARNING_CODES.has(warning.code));
  if (blockingWarnings.length === 0) {
    return "Ready for automation: runtime checks passed.";
  }

  return blockingWarnings.map((warning) => warning.message).join("; ");
}

const NON_BLOCKING_RUNTIME_WARNING_CODES = new Set([
  "control_surface_dirty_only",
  "background_dirty_allowlisted",
  "managed_advisory_drift",
  "ready_for_followup_autocontinue",
  "git_runtime_probe_deferred",
  "background_runtime_probe_deferred",
  "codex_process_probe_deferred",
  "operator_thread_mismatch",
]);

function pushUniqueWarning(
  warnings: Array<{ code: string; message: string }>,
  code: string,
  message: string,
): void {
  if (!warnings.some((warning) => warning.code === code && warning.message === message)) {
    warnings.push({ code, message });
  }
}

function extractDirtyPaths(statusLines: readonly string[]): string[] {
  const paths = new Set<string>();

  for (const statusLine of statusLines) {
    if (statusLine.length < 4) {
      continue;
    }

    const rawContent = statusLine.slice(3).trim();
    if (!rawContent) {
      continue;
    }

    const statusPaths = rawContent.includes(" -> ")
      ? rawContent.split(" -> ")
      : [rawContent];

    for (const statusPath of statusPaths) {
      const normalized = statusPath.replace(/^"+|"+$/g, "").replace(/\\/g, "/").trim();
      if (normalized) {
        paths.add(normalized);
      }
    }
  }

  return [...paths];
}

function classifyDirtyPaths(statusLines: readonly string[]): {
  dirtyPaths: string[];
  unmanagedDirtyPaths: string[];
  managedOnly: boolean;
} {
  const dirtyPaths = extractDirtyPaths(statusLines);
  const unmanagedDirtyPaths = dirtyPaths.filter((pathValue) => !isAutonomyRuntimeAllowlistedPath(pathValue));

  return {
    dirtyPaths,
    unmanagedDirtyPaths,
    managedOnly: dirtyPaths.length > 0 && unmanagedDirtyPaths.length === 0,
  };
}

function buildControlSurfaceDirtyOnlyMessage(scopes: readonly string[]): string {
  const normalizedScopes = [...new Set(scopes)];
  if (normalizedScopes.length === 0) {
    return "Allowlisted autonomy runtime file changes are present.";
  }

  if (normalizedScopes.length === 1) {
    return `Allowlisted autonomy runtime files are pending only in the ${normalizedScopes[0]}.`;
  }

  return `Allowlisted autonomy runtime files are pending only in the ${normalizedScopes.join(" and ")}.`;
}

function resolveRuntimeAutoContinueState(options: {
  summaryAutoContinueState: AutoContinueState;
  readyForAutomation: boolean;
  autoContinueWithinGoal: boolean;
}): AutoContinueState {
  if (options.summaryAutoContinueState === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.readyForAutomation && options.autoContinueWithinGoal) {
    return "running";
  }

  return "stopped";
}

function resolveRuntimeAutomationState(options: {
  summaryAutomationState: AutomationState;
  summaryAutoContinueState: AutoContinueState;
  readyForAutomation: boolean;
  state: AutonomyState;
}): AutomationState {
  if (options.summaryAutoContinueState === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.state.paused) {
    return "paused";
  }

  if (options.state.needs_human_review || options.state.cycle_status === "review_pending") {
    return "review_pending";
  }

  if (options.state.cycle_status === "planning" || options.state.cycle_status === "working") {
    return "in_progress";
  }

  if (options.readyForAutomation) {
    return "ready";
  }

  if (options.summaryAutomationState === "idle_completed" || options.summaryAutomationState === "idle_no_work") {
    return options.summaryAutomationState;
  }

  return "blocked";
}

function resolveRuntimeContinuationReason(options: {
  summaryAutoContinueState: AutoContinueState;
  summaryContinuationReason: string | null;
  autoContinueState: AutoContinueState;
  autoContinueWithinGoal: boolean;
  nextAutomationReason: string | null;
}): string | null {
  if (options.autoContinueState === "needs_confirmation") {
    return options.summaryContinuationReason ?? "Latest follow-up crosses a decision boundary and needs explicit confirmation.";
  }

  if (!options.autoContinueWithinGoal) {
    return "auto_continue_within_goal is disabled in settings.json.";
  }

  if (options.autoContinueState === "running" && options.summaryAutoContinueState === "running") {
    return options.summaryContinuationReason ?? options.nextAutomationReason;
  }

  return options.nextAutomationReason;
}

function resolveAutoContinueState(options: {
  readyForAutomation: boolean;
  autoContinueWithinGoal: boolean;
  continuationDecision: "auto_continued" | "none" | "needs_confirmation" | null;
}): AutoContinueState {
  if (options.continuationDecision === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.readyForAutomation && options.autoContinueWithinGoal) {
    return "running";
  }

  return "stopped";
}

function resolveContinuationReason(options: {
  autoContinueState: AutoContinueState;
  autoContinueWithinGoal: boolean;
  continuationDecision: "auto_continued" | "none" | "needs_confirmation" | null;
  nextAutomationReason: string | null;
}): string | null {
  if (options.autoContinueState === "needs_confirmation") {
    return "Latest follow-up crosses a decision boundary and needs explicit confirmation.";
  }

  if (!options.autoContinueWithinGoal) {
    return "auto_continue_within_goal is disabled in settings.json.";
  }

  if (options.continuationDecision === "auto_continued") {
    return "Latest follow-up stayed within the approved goal boundary and was auto-continued.";
  }

  return options.nextAutomationReason;
}

function buildUpgradeHint(upgradeState: string | null): string | null {
  switch (upgradeState) {
    case "managed_diverged":
      return "Run codex-autonomy upgrade-managed --target <repo> to inspect or apply a guided control-surface upgrade.";
    case "managed_advisory_drift":
      return "Optional: run codex-autonomy rebaseline-managed --target <repo> to accept repo-specific managed files as the new baseline.";
    case "metadata_incomplete":
      return "Repair autonomy/install.json before running managed upgrade or rebaseline commands.";
    case "upgrade_probe_failed":
      return "Managed upgrade state could not be read from autonomy/install.json.";
    default:
      return null;
  }
}

function isUpgradeBlocking(upgradeState: string | null): boolean {
  return upgradeState === "managed_diverged" || upgradeState === "metadata_incomplete" || upgradeState === "upgrade_probe_failed";
}

export function buildStatusSummary(
  tasksDoc: TasksDocument,
  goalsDoc: GoalsDocument,
  state: AutonomyState,
  blockersDoc: BlockersDocument,
  resultsDoc: AutonomyResults,
  settingsDoc: AutonomySettings = createDefaultAutonomySettings(),
  verificationDoc: VerificationDocument | null = null,
  options: {
    upgradeState?: string | null;
    cliInstallState?: string | null;
    threadBindingContext?: ReturnType<typeof inspectThreadBindingContext>;
  } = {},
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
  const threadBindingContext = options.threadBindingContext ?? inspectThreadBindingContext(state.report_thread_id, {});
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
  const nextTask = findNextReadyTask(tasksDoc.tasks, resolvedCurrentGoalId);
  const remainingReady = countReadyTasksForGoal(tasksDoc.tasks, resolvedCurrentGoalId);
  const verificationSummary = summarizeVerification(verificationDoc, resolvedCurrentGoalId);
  const completionBlockedByVerification = isGoalCompletionBlockedByVerification(verificationDoc, resolvedCurrentGoalId);
  const closeoutPolicy = resolvedCurrentGoalId && verificationDoc?.goal_id === resolvedCurrentGoalId
    ? verificationDoc.policy
    : null;

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
    goalsByStatus,
    verificationPending: verificationSummary.pending,
    completionBlockedByVerification,
    hasReportThread,
    currentThreadId: threadBindingContext.currentThreadId,
    goalPointerMismatch,
    multipleActiveGoals: activeGoalCount > 1,
    paused: state.paused,
    pauseReason: state.pause_reason,
    cycleStatus: state.cycle_status,
    needsHumanReview: state.needs_human_review,
    openBlockerCount,
  });
  const autoContinueState = resolveAutoContinueState({
    readyForAutomation,
    autoContinueWithinGoal: settingsDoc.auto_continue_within_goal,
    continuationDecision: scopedResults.continuationDecision,
  });
  const automationState = resolveLocalAutomationState({
    readyForAutomation,
    continuationDecision: scopedResults.continuationDecision,
    paused: state.paused,
    needsHumanReview: state.needs_human_review,
    cycleStatus: state.cycle_status,
    completionBlockedByVerification,
    openBlockerCount,
    multipleActiveGoals: activeGoalCount > 1,
    goalPointerMismatch,
    actionableTasks,
    pendingPlanningWork,
    goalsByStatus,
  });
  const continuationReason = resolveContinuationReason({
    autoContinueState,
    autoContinueWithinGoal: settingsDoc.auto_continue_within_goal,
    continuationDecision: scopedResults.continuationDecision,
    nextAutomationReason,
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
    current_thread_id: threadBindingContext.currentThreadId,
    current_thread_source: threadBindingContext.currentThreadSource,
    thread_binding_state: threadBindingContext.bindingState,
    thread_binding_hint: threadBindingContext.bindingHint,
    autonomy_branch: state.autonomy_branch,
    sprint_active: state.sprint_active,
    last_thread_summary_sent_at: summarySnapshot.lastThreadSummarySentAt,
    last_inbox_run_at: summarySnapshot.lastInboxRunAt,
    latest_summary_kind: summarySnapshot.latestSummaryKind,
    latest_summary_reason: summarySnapshot.latestSummaryReason,
    has_recorded_run: summarySnapshot.hasRecordedRun,
    results_scope_note: scopedResults.resultsScopeNote,
    next_automation_reason: nextAutomationReason,
    automation_state: automationState,
    auto_continue_state: autoContinueState,
    continuation_reason: continuationReason,
    closeout_policy: closeoutPolicy,
    verification_required: verificationSummary.required,
    verification_passed: verificationSummary.passed,
    verification_pending: verificationSummary.pending,
    completion_blocked_by_verification: completionBlockedByVerification,
    next_task_id: nextTask?.id ?? null,
    next_task_title: nextTask?.title ?? null,
    remaining_ready: remainingReady,
    last_followup_summary: scopedResults.nextStepSummary,
    upgrade_state: options.upgradeState ?? null,
    upgrade_blocking: isUpgradeBlocking(options.upgradeState ?? null),
    upgrade_hint: buildUpgradeHint(options.upgradeState ?? null),
    cli_install_state: options.cliInstallState ?? null,
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
  const gitRepo = await detectGitRepository(repoRoot, { allowFilesystemFallback: true });
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [tasksDoc, goalsDoc, state, blockersDoc, resultsDoc, settingsDoc, verificationDoc] = await Promise.all([
    loadTasksDocument(paths),
    loadGoalsDocument(paths),
    loadStateDocument(paths),
    loadBlockersDocument(paths),
    loadResultsDocument(paths),
    loadSettingsDocument(paths),
    loadVerificationDocument(paths),
  ]);
  const cliInstallState = await detectGlobalCliInstall();
  let upgradeState: string | null = null;
  try {
    const managedUpgradeState = await inspectManagedUpgradeState(controlRoot);
    upgradeState = managedUpgradeState.state;
  } catch {
    upgradeState = "upgrade_probe_failed";
  }
  const summary = buildStatusSummary(tasksDoc, goalsDoc, state, blockersDoc, resultsDoc, settingsDoc, verificationDoc, {
    upgradeState,
    cliInstallState,
    threadBindingContext: inspectThreadBindingContext(state.report_thread_id),
  });
  const warnings = [...(summary.warnings ?? [])];
  let readyForAutomation = summary.ready_for_automation;
  const hasEligibleWork = hasActionableTasks(tasksDoc.tasks, summary.current_goal_id) || hasPlanningWork(goalsDoc.goals);
  const hasReportThread = Boolean(state.report_thread_id?.trim());
  const controlSurfaceDirtyScopes: string[] = [];

  if (!hasEligibleWork) {
    readyForAutomation = false;
    warnings.push({
      code: "no_actionable_work",
      message: buildNoWorkReason({
        goalsByStatus: summary.goals_by_status,
        completionBlockedByVerification: summary.completion_blocked_by_verification,
        verificationPending: summary.verification_pending,
      }),
    });
  }

  if (!hasReportThread && hasEligibleWork) {
    readyForAutomation = false;
    warnings.push({
      code: "missing_report_thread_id",
      message: summary.thread_binding_hint
        ?? "Current thread identity is unavailable in this environment. Run codex-autonomy bind-thread --report-thread-id <id> before automation can run.",
    });
  }

  if (summary.thread_binding_state === "bound_to_other" && summary.thread_binding_hint) {
    pushUniqueWarning(warnings, "operator_thread_mismatch", summary.thread_binding_hint);
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

  if (upgradeState === "managed_diverged") {
    readyForAutomation = false;
    pushUniqueWarning(
      warnings,
      "managed_diverged",
      "Managed control-surface files diverged from the current product templates. Run codex-autonomy upgrade-managed --target <repo> to inspect the guided upgrade plan.",
    );
  } else if (upgradeState === "managed_advisory_drift") {
    pushUniqueWarning(
      warnings,
      "managed_advisory_drift",
      "Managed repo-customized or runtime-state files differ from the latest product templates, but the drift is advisory only. Rebaseline with codex-autonomy rebaseline-managed --target <repo> when you want to accept the current repo-specific variant as the new baseline.",
    );
  } else if (upgradeState === "metadata_incomplete") {
    pushUniqueWarning(
      warnings,
      "managed_metadata_incomplete",
      "Managed install metadata is incomplete. Re-run install in detect mode or repair autonomy/install.json before upgrading managed files.",
    );
  } else if (upgradeState === "upgrade_probe_failed") {
    pushUniqueWarning(
      warnings,
      "upgrade_probe_failed",
      "Managed upgrade state could not be determined from autonomy/install.json.",
    );
  }

  if (!gitRepo) {
    readyForAutomation = false;
    pushUniqueWarning(warnings, "not_a_git_repo", "Current workspace is not a Git repository, so automation cannot run yet.");
  } else {
    if (gitRepo.probeMode === "filesystem") {
      pushUniqueWarning(
        warnings,
        "git_runtime_probe_deferred",
        "Git runtime probes were deferred because child process execution is blocked in this environment.",
      );
    }

    const repositoryDirty = {
      dirtyPaths: gitRepo.managedDirtyPaths || gitRepo.unmanagedDirtyPaths
        ? [...(gitRepo.managedDirtyPaths ?? []), ...(gitRepo.unmanagedDirtyPaths ?? [])]
        : classifyDirtyPaths(gitRepo.statusLines ?? []).dirtyPaths,
      unmanagedDirtyPaths: gitRepo.unmanagedDirtyPaths ?? classifyDirtyPaths(gitRepo.statusLines ?? []).unmanagedDirtyPaths,
      managedOnly: gitRepo.managedControlSurfaceOnly ?? classifyDirtyPaths(gitRepo.statusLines ?? []).managedOnly,
    };
    if (gitRepo.probeMode !== "filesystem" && gitRepo.transient) {
      readyForAutomation = false;
      pushUniqueWarning(
        warnings,
        "transient_git_state",
        "Repository Git state is still changing between probes; retry once the worktree stabilizes.",
      );
    }
    if (gitRepo.probeMode !== "filesystem" && gitRepo.dirty) {
      if (repositoryDirty.managedOnly) {
        controlSurfaceDirtyScopes.push("repository");
        pushUniqueWarning(
          warnings,
          "control_surface_dirty_only",
          buildControlSurfaceDirtyOnlyMessage(["repository"]),
        );
      } else {
        readyForAutomation = false;
        pushUniqueWarning(
          warnings,
          "repo_dirty_unmanaged",
          repositoryDirty.unmanagedDirtyPaths.length > 0
            ? `Current repository is dirty outside the managed control surface: ${repositoryDirty.unmanagedDirtyPaths.join(", ")}.`
            : "Current repository is dirty, and Git did not report which unmanaged paths changed.",
        );
      }
    }

    const backgroundPath = getBackgroundWorktreePath(gitRepo.path);
    let backgroundWorktree = null;
    try {
      backgroundWorktree = await getWorktreeSummary(backgroundPath, { allowFilesystemFallback: true });
    } catch (error) {
      readyForAutomation = false;
      pushUniqueWarning(warnings, "unsafe_background_worktree_path", error instanceof Error ? error.message : String(error));
    }

    if (!backgroundWorktree) {
      if (!warnings.some((warning) => warning.code === "unsafe_background_worktree_path")) {
        readyForAutomation = false;
        pushUniqueWarning(warnings, "missing_background_worktree", `Background worktree is missing at ${backgroundPath}.`);
      }
    } else {
      if (backgroundWorktree.probeMode === "filesystem") {
        pushUniqueWarning(
          warnings,
          "background_runtime_probe_deferred",
          `Background worktree runtime probes were deferred at ${backgroundPath} because child process execution is blocked in this environment.`,
        );
      }

      const backgroundDirty = {
        dirtyPaths: backgroundWorktree.managedDirtyPaths || backgroundWorktree.unmanagedDirtyPaths
          ? [...(backgroundWorktree.managedDirtyPaths ?? []), ...(backgroundWorktree.unmanagedDirtyPaths ?? [])]
          : classifyDirtyPaths(backgroundWorktree.statusLines ?? []).dirtyPaths,
        unmanagedDirtyPaths: backgroundWorktree.unmanagedDirtyPaths ?? classifyDirtyPaths(backgroundWorktree.statusLines ?? []).unmanagedDirtyPaths,
        managedOnly: backgroundWorktree.managedControlSurfaceOnly ?? classifyDirtyPaths(backgroundWorktree.statusLines ?? []).managedOnly,
      };
      if (backgroundWorktree.probeMode !== "filesystem" && backgroundWorktree.transient) {
        readyForAutomation = false;
        pushUniqueWarning(
          warnings,
          "transient_git_state",
          `Background worktree at ${backgroundPath} is still changing between probes; retry once it stabilizes.`,
        );
      }
      if (backgroundWorktree.probeMode !== "filesystem" && backgroundWorktree.dirty) {
        if (backgroundDirty.managedOnly) {
          controlSurfaceDirtyScopes.push("background worktree");
          pushUniqueWarning(
            warnings,
            "background_dirty_allowlisted",
            `Background worktree only contains allowlisted managed control-surface changes at ${backgroundPath}.`,
          );
        } else {
          readyForAutomation = false;
          pushUniqueWarning(
            warnings,
            "background_dirty_unmanaged",
            backgroundDirty.unmanagedDirtyPaths.length > 0
              ? `Background worktree is dirty outside the managed control surface at ${backgroundPath}: ${backgroundDirty.unmanagedDirtyPaths.join(", ")}.`
              : `Background worktree is dirty at ${backgroundPath}, and Git did not report which unmanaged paths changed.`,
          );
        }
      }

      if (backgroundWorktree.commonGitDir !== gitRepo.commonGitDir) {
        readyForAutomation = false;
        pushUniqueWarning(
          warnings,
          "unexpected_background_repo",
          `Background worktree belongs to ${backgroundWorktree.commonGitDir}, expected ${gitRepo.commonGitDir}.`,
        );
      }

      if (backgroundWorktree.branch !== DEFAULT_BACKGROUND_WORKTREE_BRANCH) {
        readyForAutomation = false;
        pushUniqueWarning(
          warnings,
          "unexpected_background_branch",
          `Background worktree is on ${backgroundWorktree.branch ?? "detached HEAD"}, expected ${DEFAULT_BACKGROUND_WORKTREE_BRANCH}.`,
        );
      }

      if (gitRepo.head && backgroundWorktree.head && backgroundWorktree.head !== gitRepo.head) {
        readyForAutomation = false;
        pushUniqueWarning(
          warnings,
          "background_worktree_head_mismatch",
          `Background worktree is at ${backgroundWorktree.head}, expected ${gitRepo.head}.`,
        );
      }
    }
  }

  if (controlSurfaceDirtyScopes.length > 0) {
    pushUniqueWarning(
      warnings,
      "control_surface_dirty_only",
      buildControlSurfaceDirtyOnlyMessage(controlSurfaceDirtyScopes),
    );
  }

  const lock = await inspectCycleLock(paths.cycleLockFile);
  if (lock.exists) {
    readyForAutomation = false;
    pushUniqueWarning(
      warnings,
      lock.stale ? "stale_cycle_lock" : "active_cycle_lock",
      lock.stale ? lock.reason ?? "Cycle lock is stale." : "Cycle lock is active.",
    );
  }

  const powershell = discoverPowerShellExecutable();
  const codexProcess = detectCodexProcess(powershell ?? undefined);
  if (!codexProcess.probeOk) {
    if (isChildProcessSpawnBlocked(codexProcess.error)) {
      pushUniqueWarning(
        warnings,
        "codex_process_probe_deferred",
        codexProcess.error ?? "Codex process detection was deferred because child process execution is blocked in this environment.",
      );
    } else {
      readyForAutomation = false;
      pushUniqueWarning(warnings, "codex_process_probe_failed", codexProcess.error ?? "Codex process probe failed.");
    }
  } else if (!codexProcess.running) {
    readyForAutomation = false;
    pushUniqueWarning(warnings, "codex_not_running", "Codex process was not detected.");
  }

  if (cliInstallState === "global_missing") {
    pushUniqueWarning(
      warnings,
      "cli_missing",
      "Global codex-autonomy CLI is not installed. Run pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1 from the product source repo.",
    );
  }

  const nextAutomationReason = readyForAutomation
    ? settingsDoc.auto_continue_within_goal
      ? "Ready for follow-up autocontinue: runtime checks passed and eligible work exists."
      : "Ready for automation: runtime checks passed and eligible work exists."
    : buildRuntimeAutomationReason(warnings);

  if (readyForAutomation && settingsDoc.auto_continue_within_goal && hasEligibleWork) {
    pushUniqueWarning(
      warnings,
      "ready_for_followup_autocontinue",
      "Ready for follow-up autocontinue: runtime checks passed and eligible work exists.",
    );
  }

  const autoContinueState = resolveRuntimeAutoContinueState({
    summaryAutoContinueState: summary.auto_continue_state,
    readyForAutomation,
    autoContinueWithinGoal: settingsDoc.auto_continue_within_goal,
  });
  const automationState = resolveRuntimeAutomationState({
    summaryAutomationState: summary.automation_state,
    summaryAutoContinueState: summary.auto_continue_state,
    readyForAutomation,
    state,
  });
  const continuationReason = resolveRuntimeContinuationReason({
    summaryAutoContinueState: summary.auto_continue_state,
    summaryContinuationReason: summary.continuation_reason,
    autoContinueState,
    autoContinueWithinGoal: settingsDoc.auto_continue_within_goal,
    nextAutomationReason,
  });

  const result: StatusSummary = {
    ...summary,
    ready_for_automation: readyForAutomation,
    next_automation_ready: readyForAutomation,
    next_automation_reason: nextAutomationReason,
    automation_state: automationState,
    auto_continue_state: autoContinueState,
    continuation_reason: continuationReason,
    upgrade_blocking: isUpgradeBlocking(summary.upgrade_state),
    upgrade_hint: buildUpgradeHint(summary.upgrade_state),
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
