import { Command } from "commander";

import type {
  AutonomyResults,
  AutonomySettings,
  AutomationNextStep,
  AutomationState,
  AutoContinueState,
  AutonomyState,
  BlockersDocument,
  DecisionPolicyDocument,
  GoalSupplyState,
  GoalStatus,
  GoalsDocument,
  StatusSummary,
  TaskStatus,
  TasksDocument,
  VerificationDocument,
} from "../contracts/autonomy.js";
import { GOAL_STATUSES, TASK_STATUSES } from "../contracts/autonomy.js";
import { countOpenBlockers, countReadyTasksForGoal, findNextReadyTask } from "../domain/autonomy.js";
import { buildDecisionAdvice } from "../domain/decision.js";
import { resolveSummarySnapshot, scopeResultsSummary } from "../domain/results.js";
import { isGoalCompletionBlockedByVerification, summarizeVerification } from "../domain/verification.js";
import { detectGlobalCliInstall } from "../infra/cli-install.js";
import {
  DEFAULT_BACKGROUND_WORKTREE_BRANCH,
  detectGitRepository,
  getBackgroundWorktreePath,
  getWorktreeSummary,
  inspectAutonomyCommitGate,
} from "../infra/git.js";
import { inspectCycleLock } from "../infra/lock.js";
import { discoverPowerShellExecutable, detectCodexProcess, isChildProcessSpawnBlocked } from "../infra/process.js";
import { isAutonomyRuntimeAllowlistedPath, resolveRepoPaths } from "../shared/paths.js";
import { createDefaultAutonomySettings, createDefaultDecisionPolicyDocument } from "../shared/policy.js";
import { inspectThreadBindingContext } from "../shared/thread-context.js";
import { inspectManagedUpgradeState } from "./upgrade-managed.js";
import {
  loadBlockersDocument,
  loadGoalsDocument,
  loadPendingOperation,
  loadResultsDocument,
  loadSettingsDocument,
  loadStateDocument,
  loadTasksDocument,
  loadVerificationDocument,
  loadDecisionPolicyDocument,
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

function countUnfinishedTasks(tasks: TasksDocument["tasks"]): number {
  return tasks.filter((task) => task.status !== "done").length;
}

function buildNoWorkReason(options: {
  goalsByStatus: Record<GoalStatus, number>;
  unfinishedTaskCount?: number;
  completionBlockedByVerification: boolean;
  verificationPending: number;
}): string {
  if (options.completionBlockedByVerification) {
    return `Verification closeout is still pending for ${options.verificationPending} required axis/axes.`;
  }

  if (hasOnlyCompletedIdleWork(options.goalsByStatus)) {
    if ((options.unfinishedTaskCount ?? 0) > 0) {
      return `All goals are completed, but tasks.json still contains ${options.unfinishedTaskCount} unfinished task(s); resolve the stale task backlog before creating a successor goal.`;
    }
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

function hasApprovedGoalAvailable(goals: GoalsDocument["goals"]): boolean {
  return goals.some((goal) => goal.status === "approved");
}

function sortCompletedGoalsNewestFirst(goals: GoalsDocument["goals"]): GoalsDocument["goals"] {
  return [...goals]
    .filter((goal) => goal.status === "completed")
    .sort((left, right) => {
      const leftKey = left.completed_at ?? left.created_at;
      const rightKey = right.completed_at ?? right.created_at;
      const timeDiff = rightKey.localeCompare(leftKey);
      if (timeDiff !== 0) {
        return timeDiff;
      }

      return right.id.localeCompare(left.id);
    });
}

function countConsecutiveAutoSuccessorGoals(goals: GoalsDocument["goals"]): number {
  let count = 0;
  for (const goal of sortCompletedGoalsNewestFirst(goals)) {
    if (goal.source !== "auto_successor") {
      break;
    }
    count += 1;
  }
  return count;
}

function countAutoSuccessorGoalsCreatedSince(goals: GoalsDocument["goals"], sinceMs: number): number {
  return goals.filter((goal) => {
    if (goal.source !== "auto_successor") {
      return false;
    }
    const createdAt = Date.parse(goal.created_at);
    return Number.isFinite(createdAt) && createdAt >= sinceMs;
  }).length;
}

function resolveSuccessorGoalAvailability(options: {
  goals: GoalsDocument["goals"];
  goalsByStatus: Record<GoalStatus, number>;
  unfinishedTaskCount: number;
  decisionPolicy: DecisionPolicyDocument;
  nowMs?: number;
}): { available: boolean; autoApprove: boolean; reason: string } {
  const policy = options.decisionPolicy.auto_continue.auto_successor_goal;
  if (!hasOnlyCompletedIdleWork(options.goalsByStatus)) {
    return {
      available: false,
      autoApprove: false,
      reason: "Successor goal generation only applies after all existing approved work is completed.",
    };
  }

  if (options.unfinishedTaskCount > 0) {
    return {
      available: false,
      autoApprove: false,
      reason: `Successor goal generation is blocked while ${options.unfinishedTaskCount} unfinished task(s) remain in tasks.json.`,
    };
  }

  if (!policy.enabled) {
    return {
      available: false,
      autoApprove: false,
      reason: "Auto successor goal generation is disabled in autonomy/decision-policy.json.",
    };
  }

  if (!policy.objective?.trim()) {
    return {
      available: false,
      autoApprove: false,
      reason: "Auto successor goal generation requires a non-empty charter objective in autonomy/decision-policy.json.",
    };
  }

  if (policy.max_consecutive_auto_successors <= 0) {
    return {
      available: false,
      autoApprove: false,
      reason: "Auto successor goal generation is disabled because max_consecutive_auto_successors is 0.",
    };
  }

  const consecutiveAutoSuccessors = countConsecutiveAutoSuccessorGoals(options.goals);
  if (consecutiveAutoSuccessors >= policy.max_consecutive_auto_successors) {
    return {
      available: false,
      autoApprove: false,
      reason: `Auto successor goal generation reached max_consecutive_auto_successors=${policy.max_consecutive_auto_successors}.`,
    };
  }

  if (policy.max_successor_goals_per_day <= 0) {
    return {
      available: false,
      autoApprove: false,
      reason: "Auto successor goal generation is disabled because max_successor_goals_per_day is 0.",
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const createdLastDay = countAutoSuccessorGoalsCreatedSince(options.goals, nowMs - 24 * 60 * 60 * 1000);
  if (createdLastDay >= policy.max_successor_goals_per_day) {
    return {
      available: false,
      autoApprove: false,
      reason: `Auto successor goal generation reached max_successor_goals_per_day=${policy.max_successor_goals_per_day}.`,
    };
  }

  return {
    available: true,
    autoApprove: policy.auto_approve_minimal_successor,
    reason: policy.auto_approve_minimal_successor
      ? "Program charter allows creating and approving one minimal successor goal for this completed boundary."
      : "Program charter allows drafting one minimal successor goal for this completed boundary, but auto approval is disabled.",
  };
}

function hasPlanningOnlyWorkForCurrentGoal(options: {
  tasks: TasksDocument["tasks"];
  currentGoalId: string | null;
  verificationPending: number;
  followupSummary: string | null;
}): boolean {
  if (!options.currentGoalId) {
    return false;
  }

  if (options.verificationPending > 0) {
    return true;
  }

  if (options.followupSummary && options.followupSummary.trim().length > 0) {
    return true;
  }

  return options.tasks.some(
    (task) => task.goal_id === options.currentGoalId && task.status === "verify_failed",
  );
}

function resolveGoalSupplyState(options: {
  currentGoalId: string | null;
  approvedGoalAvailable: boolean;
  successorGoalAvailable: boolean;
  goalsByStatus: Record<GoalStatus, number>;
}): GoalSupplyState {
  if (options.currentGoalId) {
    return "active_goal";
  }

  if (options.approvedGoalAvailable) {
    return "approved_goal_available";
  }

  if (options.goalsByStatus.awaiting_confirmation > 0) {
    return "awaiting_confirmation";
  }

  if (options.successorGoalAvailable) {
    return "successor_goal_available";
  }

  if (hasOnlyCompletedIdleWork(options.goalsByStatus)) {
    return "completed_only";
  }

  const totalGoals = GOAL_STATUSES.reduce((count, status) => count + options.goalsByStatus[status], 0);
  if (totalGoals === 0) {
    return "empty";
  }

  return "manual_triage";
}

function resolveNextAutomationStep(options: {
  goalSupplyState: GoalSupplyState;
  readyForAutomation: boolean;
  readyForExecution: boolean;
  planningOnlyWork: boolean;
}): AutomationNextStep {
  if (!options.readyForAutomation) {
    return options.goalSupplyState === "completed_only" || options.goalSupplyState === "empty" || options.goalSupplyState === "successor_goal_available"
      ? "idle"
      : "manual_triage";
  }

  if (options.readyForExecution) {
    return "execute_bounded_loop";
  }

  if (options.planningOnlyWork) {
    return "plan_or_rebalance";
  }

  switch (options.goalSupplyState) {
    case "successor_goal_available":
      return "create_successor_goal";
    case "awaiting_confirmation":
      return "await_confirmation";
    case "completed_only":
    case "empty":
      return "idle";
    default:
      return "manual_triage";
  }
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
    `goal_supply_state=${summary.goal_supply_state}`,
    `next_automation_step=${summary.next_automation_step}`,
    `ready_for_execution=${summary.ready_for_execution ? "yes" : "no"}`,
    `closeout_policy=${formatNullableText(summary.closeout_policy)}`,
    `verification_required=${summary.verification_required}`,
    `verification_passed=${summary.verification_passed}`,
    `verification_pending=${summary.verification_pending}`,
    `completion_blocked_by_verification=${summary.completion_blocked_by_verification ? "yes" : "no"}`,
    `successor_goal_available=${summary.successor_goal_available ? "yes" : "no"}`,
    `successor_goal_auto_approve=${summary.successor_goal_auto_approve ? "yes" : "no"}`,
    `successor_goal_reason=${formatNullableText(summary.successor_goal_reason)}`,
    `next_task=${summary.next_task_id ? `${summary.next_task_id}${summary.next_task_title ? `(${summary.next_task_title})` : ""}` : "none"}`,
    `remaining_ready=${summary.remaining_ready}`,
    `last_followup_summary=${formatNullableText(summary.last_followup_summary)}`,
    `upgrade_state=${formatNullableText(summary.upgrade_state)}`,
    `upgrade_blocking=${summary.upgrade_blocking ? "yes" : "no"}`,
    `upgrade_hint=${formatNullableText(summary.upgrade_hint)}`,
    `cli_install_state=${formatNullableText(summary.cli_install_state)}`,
    `next_automation_reason=${formatNullableText(summary.next_automation_reason)}`,
    `recommended_automation_surface=${summary.recommended_automation_surface}`,
    `recommended_automation_prompt=${formatNullableText(summary.recommended_automation_prompt)}`,
    `recommended_automation_reason=${formatNullableText(summary.recommended_automation_reason)}`,
    `decision_event=${summary.decision_event}`,
    `decision_outcome=${summary.decision_outcome}`,
    `decision_next_action=${summary.decision_next_action}`,
    `decision_heartbeat=${summary.decision_heartbeat}`,
    `decision_reason=${formatNullableText(summary.decision_reason)}`,
    `ready_for_automation=${summary.ready_for_automation ? "yes" : "no"}`,
  ].join(" ");
}

function buildLocalAutomationReason(options: {
  readyForAutomation: boolean;
  readyForExecution: boolean;
  actionableTasks: boolean;
  pendingPlanningWork: boolean;
  planningOnlyWork: boolean;
  successorGoalAvailable: boolean;
  unfinishedTaskCount: number;
  goalsByStatus: Record<GoalStatus, number>;
  nextAutomationStep: AutomationNextStep;
  verificationPending: number;
  completionBlockedByVerification: boolean;
  hasReportThread: boolean;
  currentThreadId: string | null;
  threadBindingState: StatusSummary["thread_binding_state"];
  threadBindingHint: string | null;
  goalPointerMismatch: boolean;
  multipleActiveGoals: boolean;
  paused: boolean;
  pauseReason: string | null;
  sprintActive: boolean;
  cycleStatus: StatusSummary["cycle_status"];
  needsHumanReview: boolean;
  openBlockerCount: number;
}): string {
  if (options.readyForAutomation) {
    switch (options.nextAutomationStep) {
      case "execute_bounded_loop":
        return options.actionableTasks
          ? "Ready for execution: active task work is available."
          : "Ready for execution: an approved goal is available for bounded continuation.";
      case "plan_or_rebalance":
        return "Ready for planning only: the active goal needs bounded replanning or verification closeout before the next execution loop.";
      case "create_successor_goal":
        return "Ready for program continuation: all approved work is complete and policy allows one minimal successor goal for this completed boundary.";
      case "await_confirmation":
        return "Waiting at the goal boundary: the next goal is still awaiting confirmation, so automation must not execute implementation.";
      case "idle":
        return buildNoWorkReason({
          goalsByStatus: options.goalsByStatus,
          unfinishedTaskCount: options.unfinishedTaskCount,
          completionBlockedByVerification: options.completionBlockedByVerification,
          verificationPending: options.verificationPending,
        });
      case "manual_triage":
      default:
        return "Automation needs manual goal triage before the next run.";
    }
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

  if (options.openBlockerCount > 0) {
    return `There ${options.openBlockerCount === 1 ? "is" : "are"} ${options.openBlockerCount} open blocker(s).`;
  }

  if (!options.actionableTasks && !options.pendingPlanningWork && !options.successorGoalAvailable) {
    return buildNoWorkReason({
      goalsByStatus: options.goalsByStatus,
      unfinishedTaskCount: options.unfinishedTaskCount,
      completionBlockedByVerification: options.completionBlockedByVerification,
      verificationPending: options.verificationPending,
    });
  }

  if (!options.sprintActive) {
    return "Sprint runner is inactive; automation may only report status until the bound thread explicitly resumes the long-running program.";
  }

  if (options.threadBindingState !== "bound_to_current") {
    return options.threadBindingHint
      ?? "The current thread is not the bound operator thread; local automation must not continue from this thread.";
  }

  if (options.needsHumanReview) {
    return "State requires human review before the next automation run.";
  }

  if (options.cycleStatus !== "idle") {
    return `Current cycle status is ${options.cycleStatus}.`;
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

function resolveRecommendedAutomation(options: {
  readyForAutomation: boolean;
  nextAutomationReason: string | null;
  hasReportThread: boolean;
  currentThreadId: string | null;
  threadBindingState: StatusSummary["thread_binding_state"];
  threadBindingHint: string | null;
}): Pick<
  StatusSummary,
  "recommended_automation_surface" | "recommended_automation_reason" | "recommended_automation_prompt"
> {
  if (options.threadBindingState === "bound_to_current" && options.readyForAutomation) {
    return {
      recommended_automation_surface: "thread_automation",
      recommended_automation_reason: "Current thread is already bound as report_thread_id and runtime checks passed; prefer official Codex thread automations for same-thread continuation.",
      recommended_automation_prompt: "official_thread_automation",
    };
  }

  if (options.threadBindingState !== "bound_to_current" && options.hasReportThread) {
    let reason = "A safe report_thread_id is already bound, so same-goal continuation should wake the bound thread through the external relay scheduler fallback.";
    if (options.threadBindingState === "bound_to_other") {
      reason = options.threadBindingHint
        ?? "The current thread is not the bound operator thread. Use the external relay scheduler fallback or move back to the bound thread instead of creating a same-thread heartbeat here.";
    } else if (options.threadBindingState === "bound_without_current_thread") {
      reason = "report_thread_id is bound, but the current thread identity is unavailable in this environment. Use the external relay scheduler fallback against the bound thread instead of guessing the operator surface.";
    }

    return {
      recommended_automation_surface: "external_relay_scheduler",
      recommended_automation_reason: reason,
      recommended_automation_prompt: "external_relay_scheduler",
    };
  }

  return {
    recommended_automation_surface: "manual_only",
    recommended_automation_reason: options.nextAutomationReason
      ?? (options.currentThreadId
        ? "No safe bound report_thread_id is available yet. Bind the current operator thread before enabling automation."
        : options.threadBindingHint
          ?? "No safe bound report_thread_id is available yet, and the current thread identity is unavailable in this environment."),
    recommended_automation_prompt: null,
  };
}

const NON_BLOCKING_RUNTIME_WARNING_CODES = new Set([
  "control_surface_dirty_only",
  "background_dirty_allowlisted",
  "managed_advisory_drift",
  "completed_current_goal_id_stale",
  "ready_for_followup_autocontinue",
  "codex_process_probe_deferred",
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
  readyForExecution: boolean;
  autoContinueWithinGoal: boolean;
}): AutoContinueState {
  if (options.summaryAutoContinueState === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.readyForExecution && options.autoContinueWithinGoal) {
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
  readyForExecution: boolean;
  autoContinueWithinGoal: boolean;
  continuationDecision: "auto_continued" | "none" | "needs_confirmation" | null;
}): AutoContinueState {
  if (options.continuationDecision === "needs_confirmation") {
    return "needs_confirmation";
  }

  if (options.readyForExecution && options.autoContinueWithinGoal) {
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
    decisionPolicy?: DecisionPolicyDocument;
  } = {},
): StatusSummary {
  const openBlockerCount = countOpenBlockers(blockersDoc.blockers);
  const tasksByStatus = countTaskStatuses(tasksDoc.tasks);
  const goalsByStatus = countGoalStatuses(goalsDoc.goals);
  const activeGoalCount = goalsDoc.goals.filter((goal) => goal.status === "active").length;
  const unfinishedTaskCount = countUnfinishedTasks(tasksDoc.tasks);
  const resolvedCurrentGoalId = resolveCurrentGoalId(goalsDoc.goals, state);
  const pointedCurrentGoal = state.current_goal_id
    ? goalsDoc.goals.find((goal) => goal.id === state.current_goal_id) ?? null
    : null;
  const goalPointerMismatch = Boolean(state.current_goal_id) && state.current_goal_id !== resolvedCurrentGoalId;
  const completedCloseoutPointer =
    Boolean(pointedCurrentGoal)
    && pointedCurrentGoal?.status === "completed"
    && activeGoalCount === 0
    && unfinishedTaskCount === 0;
  const unsafeGoalPointerMismatch = goalPointerMismatch && !completedCloseoutPointer;
  const actionableTasks = hasActionableTasks(tasksDoc.tasks, resolvedCurrentGoalId);
  const pendingPlanningWork = hasPlanningWork(goalsDoc.goals);
  const hasReportThread = Boolean(state.report_thread_id?.trim());
  const threadBindingContext = options.threadBindingContext ?? inspectThreadBindingContext(state.report_thread_id, {});
  const summarySnapshot = resolveSummarySnapshot(resultsDoc, state);
  const scopedResults = scopeResultsSummary(resultsDoc, resolvedCurrentGoalId);
  const nextTask = findNextReadyTask(tasksDoc.tasks, resolvedCurrentGoalId);
  const remainingReady = countReadyTasksForGoal(tasksDoc.tasks, resolvedCurrentGoalId);
  const verificationSummary = summarizeVerification(verificationDoc, resolvedCurrentGoalId);
  const completionBlockedByVerification = isGoalCompletionBlockedByVerification(verificationDoc, resolvedCurrentGoalId);
  const approvedGoalAvailable = hasApprovedGoalAvailable(goalsDoc.goals);
  const successorGoal = resolveSuccessorGoalAvailability({
    goals: goalsDoc.goals,
    goalsByStatus,
    unfinishedTaskCount,
    decisionPolicy: options.decisionPolicy ?? createDefaultDecisionPolicyDocument(),
  });
  const planningOnlyWork = hasPlanningOnlyWorkForCurrentGoal({
    tasks: tasksDoc.tasks,
    currentGoalId: resolvedCurrentGoalId,
    verificationPending: verificationSummary.pending,
    followupSummary: scopedResults.nextStepSummary,
  });
  const goalSupplyState = resolveGoalSupplyState({
    currentGoalId: resolvedCurrentGoalId,
    approvedGoalAvailable,
    successorGoalAvailable: successorGoal.available,
    goalsByStatus,
  });
  const closeoutPolicy = resolvedCurrentGoalId && verificationDoc?.goal_id === resolvedCurrentGoalId
    ? verificationDoc.policy
    : null;
  const safeAutomationBase =
    activeGoalCount <= 1 &&
    unsafeGoalPointerMismatch === false &&
    state.cycle_status === "idle" &&
    state.needs_human_review === false &&
    state.paused === false &&
    hasReportThread &&
    threadBindingContext.bindingState === "bound_to_current" &&
    openBlockerCount === 0;
  const readyBase = safeAutomationBase && state.sprint_active === true;
  const successorBoundaryReady = safeAutomationBase && successorGoal.available;
  const readyForExecution = readyBase && (actionableTasks || approvedGoalAvailable);
  const readyForAutomation =
    (readyBase && (readyForExecution || planningOnlyWork || goalsByStatus.awaiting_confirmation > 0))
    || successorBoundaryReady;
  const nextAutomationStep = resolveNextAutomationStep({
    goalSupplyState,
    readyForAutomation,
    readyForExecution,
    planningOnlyWork,
  });
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
              code: completedCloseoutPointer ? "completed_current_goal_id_stale" : "inactive_current_goal_id",
              message: completedCloseoutPointer
                ? `state.json still points to completed goal ${state.current_goal_id}; treating this as a closed boundary and allowing successor evaluation.`
                : `state.json points to ${state.current_goal_id}, but that goal is not active in goals.json.`,
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
    readyForExecution,
    actionableTasks,
    pendingPlanningWork,
    planningOnlyWork,
    successorGoalAvailable: successorGoal.available,
    unfinishedTaskCount,
    goalsByStatus,
    nextAutomationStep,
    verificationPending: verificationSummary.pending,
    completionBlockedByVerification,
    hasReportThread,
    currentThreadId: threadBindingContext.currentThreadId,
    threadBindingState: threadBindingContext.bindingState,
    threadBindingHint: threadBindingContext.bindingHint,
    goalPointerMismatch: unsafeGoalPointerMismatch,
    multipleActiveGoals: activeGoalCount > 1,
    paused: state.paused,
    pauseReason: state.pause_reason,
    sprintActive: state.sprint_active,
    cycleStatus: state.cycle_status,
    needsHumanReview: state.needs_human_review,
    openBlockerCount,
  });
  const autoContinueState = resolveAutoContinueState({
    readyForExecution,
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
    goalPointerMismatch: unsafeGoalPointerMismatch,
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
  const recommendedAutomation = resolveRecommendedAutomation({
    readyForAutomation,
    nextAutomationReason,
    hasReportThread,
    currentThreadId: threadBindingContext.currentThreadId,
    threadBindingState: threadBindingContext.bindingState,
    threadBindingHint: threadBindingContext.bindingHint,
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
    goal_supply_state: goalSupplyState,
    next_automation_step: nextAutomationStep,
    ready_for_execution: readyForExecution,
    automation_state: automationState,
    auto_continue_state: autoContinueState,
    continuation_reason: continuationReason,
    closeout_policy: closeoutPolicy,
    verification_required: verificationSummary.required,
    verification_passed: verificationSummary.passed,
    verification_pending: verificationSummary.pending,
    completion_blocked_by_verification: completionBlockedByVerification,
    successor_goal_available: successorGoal.available,
    successor_goal_auto_approve: successorGoal.autoApprove,
    successor_goal_reason: successorGoal.reason,
    next_task_id: nextTask?.id ?? null,
    next_task_title: nextTask?.title ?? null,
    remaining_ready: remainingReady,
    last_followup_summary: scopedResults.nextStepSummary,
    upgrade_state: options.upgradeState ?? null,
    upgrade_blocking: isUpgradeBlocking(options.upgradeState ?? null),
    upgrade_hint: buildUpgradeHint(options.upgradeState ?? null),
    cli_install_state: options.cliInstallState ?? null,
    recommended_automation_surface: recommendedAutomation.recommended_automation_surface,
    recommended_automation_reason: recommendedAutomation.recommended_automation_reason,
    recommended_automation_prompt: recommendedAutomation.recommended_automation_prompt,
    decision_event: "none",
    decision_outcome: "safe_backoff",
    decision_reason: "Decision advice has not been computed yet.",
    decision_next_action: "stop_and_report",
    decision_heartbeat: "normal_15m",
    decision_evidence: [],
    results_summary: {
      planner_summary: scopedResults.plannerSummary,
      worker_result: scopedResults.workerResult,
      review_result: scopedResults.reviewResult,
      commit_result: scopedResults.commitMessage,
      reporter_sent_at: resultsDoc.reporter.sent_at ?? resultsDoc.reporter.happened_at ?? null,
    },
    next_automation_ready: readyForAutomation,
  };
  const decisionAdvice = buildDecisionAdvice(summary, options.decisionPolicy);
  const decidedSummary: StatusSummary = {
    ...summary,
    ...decisionAdvice,
  };

  return {
    ...decidedSummary,
    message: buildMessage(decidedSummary),
  };
}

export async function runStatusCommand(repoRoot = process.cwd()): Promise<StatusSummary> {
  const gitRepo = await detectGitRepository(repoRoot, { allowFilesystemFallback: true });
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [tasksDoc, goalsDoc, state, blockersDoc, resultsDoc, settingsDoc, verificationDoc, decisionPolicy] = await Promise.all([
    loadTasksDocument(paths),
    loadGoalsDocument(paths),
    loadStateDocument(paths),
    loadBlockersDocument(paths),
    loadResultsDocument(paths),
    loadSettingsDocument(paths),
    loadVerificationDocument(paths),
    loadDecisionPolicyDocument(paths),
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
    decisionPolicy,
  });
  const warnings = [...(summary.warnings ?? [])];
  let readyForAutomation = summary.ready_for_automation;
  let readyForExecution = summary.ready_for_execution;
  const hasEligibleWork = summary.goal_supply_state !== "completed_only" && summary.goal_supply_state !== "empty";
  const hasReportThread = Boolean(state.report_thread_id?.trim());
  const controlSurfaceDirtyScopes: string[] = [];

  try {
    const pendingOperation = await loadPendingOperation(paths);
    if (pendingOperation) {
      readyForAutomation = false;
      readyForExecution = false;
      pushUniqueWarning(
        warnings,
        "pending_control_plane_operation",
        `Pending control-plane operation ${pendingOperation.kind} (${pendingOperation.id}) must be recovered or cleared before the next automation loop.`,
      );
    }
  } catch (error) {
    readyForAutomation = false;
    readyForExecution = false;
    pushUniqueWarning(
      warnings,
      "pending_control_plane_operation_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!hasEligibleWork) {
    readyForAutomation = false;
    warnings.push({
      code: "no_actionable_work",
      message: buildNoWorkReason({
        goalsByStatus: summary.goals_by_status,
        unfinishedTaskCount: TASK_STATUSES
          .filter((status) => status !== "done")
          .reduce((count, status) => count + summary.tasks_by_status[status], 0),
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
        const commitGate = await inspectAutonomyCommitGate(gitRepo.path, state.autonomy_branch);
        if (commitGate.commitReady && commitGate.blockedPaths.length === 0 && commitGate.allowedPaths.length > 0) {
          pushUniqueWarning(
            warnings,
            "repo_dirty_review_recoverable",
            `Current repository has a recoverable autonomy closeout diff: ${commitGate.allowedPaths.join(", ")}. Run codex-autonomy review to verify and create the controlled closeout commit before the next automation loop.`,
          );
        } else {
          pushUniqueWarning(
            warnings,
            "repo_dirty_unmanaged",
            repositoryDirty.unmanagedDirtyPaths.length > 0
              ? `Current repository is dirty outside the managed control surface: ${repositoryDirty.unmanagedDirtyPaths.join(", ")}.`
              : "Current repository is dirty, and Git did not report which unmanaged paths changed.",
          );
        }
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
    ? summary.next_automation_reason
    : buildRuntimeAutomationReason(warnings);

  if (!readyForAutomation) {
    readyForExecution = false;
  }

  if (readyForExecution && settingsDoc.auto_continue_within_goal && hasEligibleWork) {
    pushUniqueWarning(
      warnings,
      "ready_for_followup_autocontinue",
      "Ready for follow-up autocontinue: runtime checks passed and eligible work exists.",
    );
  }

  const autoContinueState = resolveRuntimeAutoContinueState({
    summaryAutoContinueState: summary.auto_continue_state,
    readyForExecution,
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
  const recommendedAutomation = resolveRecommendedAutomation({
    readyForAutomation,
    nextAutomationReason,
    hasReportThread,
    currentThreadId: summary.current_thread_id,
    threadBindingState: summary.thread_binding_state,
    threadBindingHint: summary.thread_binding_hint,
  });

  const result: StatusSummary = {
    ...summary,
    ready_for_automation: readyForAutomation,
    next_automation_ready: readyForAutomation,
    next_automation_reason: nextAutomationReason,
    goal_supply_state: summary.goal_supply_state,
    next_automation_step: readyForAutomation ? summary.next_automation_step : (
      summary.goal_supply_state === "awaiting_confirmation"
        ? "await_confirmation"
        : summary.goal_supply_state === "completed_only" || summary.goal_supply_state === "empty"
          ? "idle"
          : "manual_triage"
    ),
    ready_for_execution: readyForExecution,
    automation_state: automationState,
    auto_continue_state: autoContinueState,
    continuation_reason: continuationReason,
    upgrade_blocking: isUpgradeBlocking(summary.upgrade_state),
    upgrade_hint: buildUpgradeHint(summary.upgrade_state),
    recommended_automation_surface: recommendedAutomation.recommended_automation_surface,
    recommended_automation_reason: recommendedAutomation.recommended_automation_reason,
    recommended_automation_prompt: recommendedAutomation.recommended_automation_prompt,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
  const decisionAdvice = buildDecisionAdvice(result, decisionPolicy);
  const decidedResult: StatusSummary = {
    ...result,
    ...decisionAdvice,
  };

  return {
    ...decidedResult,
    message: buildMessage(decidedResult),
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
