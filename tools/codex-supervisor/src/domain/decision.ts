import type {
  DecisionAdvice,
  DecisionEvent,
  DecisionHeartbeat,
  DecisionNextAction,
  DecisionOutcome,
  DecisionPolicyDocument,
  StatusSummary,
} from "../contracts/autonomy.js";
import { createDefaultDecisionPolicyDocument } from "../shared/policy.js";

function getWarningCodes(summary: Pick<StatusSummary, "warnings">): Set<string> {
  return new Set((summary.warnings ?? []).map((warning) => warning.code));
}

function hasWarning(summary: Pick<StatusSummary, "warnings">, ...codes: readonly string[]): boolean {
  const warningCodes = getWarningCodes(summary);
  return codes.some((code) => warningCodes.has(code));
}

function evidence(...items: Array<string | null | undefined | false>): string[] {
  return items.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function advice(input: {
  event: DecisionEvent;
  outcome: DecisionOutcome;
  reason: string;
  nextAction: DecisionNextAction;
  heartbeat: DecisionHeartbeat;
  evidence: string[];
}): DecisionAdvice {
  return {
    decision_event: input.event,
    decision_outcome: input.outcome,
    decision_reason: input.reason,
    decision_next_action: input.nextAction,
    decision_heartbeat: input.heartbeat,
    decision_evidence: input.evidence,
  };
}

function maybeEscalateByPolicy(
  candidate: DecisionAdvice,
  policy: DecisionPolicyDocument,
): DecisionAdvice {
  if (!policy.ask_human.includes(candidate.decision_event)) {
    return candidate;
  }

  if (candidate.decision_outcome === "ask_human" || candidate.decision_outcome === "reject_or_rewrite") {
    return candidate;
  }

  return {
    ...candidate,
    decision_outcome: "ask_human",
    decision_next_action: "pause_or_ask",
    decision_heartbeat: "pause",
    decision_reason: `${candidate.decision_reason} The repo decision policy marks ${candidate.decision_event} as requiring operator confirmation.`,
  };
}

export function buildDecisionAdvice(
  summary: StatusSummary,
  policy: DecisionPolicyDocument = createDefaultDecisionPolicyDocument(),
): DecisionAdvice {
  let candidate: DecisionAdvice;

  if (hasWarning(summary, "repo_dirty_review_recoverable")) {
    candidate = advice({
      event: "recoverable_closeout",
      outcome: "auto_repair_once",
      reason: "A recoverable closeout diff is present. Verify and run codex-autonomy review before the next bounded loop.",
      nextAction: "run_verify_then_review",
      heartbeat: "normal_15m",
      evidence: evidence(summary.next_automation_reason, "warning:repo_dirty_review_recoverable"),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (hasWarning(summary, "repo_dirty_unmanaged", "background_dirty_unmanaged", "transient_git_state")) {
    candidate = advice({
      event: "dirty_worktree",
      outcome: "ask_human",
      reason: "The worktree is dirty outside the recoverable control surface, so automation must not guess ownership.",
      nextAction: "manual_triage",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.next_automation_reason, "warning:dirty_worktree"),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (hasWarning(summary, "pending_control_plane_operation", "pending_control_plane_operation_invalid")) {
    candidate = advice({
      event: "unknown_context",
      outcome: "safe_backoff",
      reason: "A previous control-plane write operation is still pending and must be recovered before automation continues.",
      nextAction: "stop_and_report",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.next_automation_reason, "warning:pending_control_plane_operation"),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (hasWarning(summary, "missing_background_worktree", "unexpected_background_repo", "unexpected_background_branch", "background_worktree_head_mismatch")) {
    candidate = advice({
      event: "dirty_worktree",
      outcome: "safe_backoff",
      reason: "The background worktree is missing or mismatched. Repair the automation lane before taking new work.",
      nextAction: "prepare_worktree",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.next_automation_reason, "warning:background_worktree"),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (hasWarning(summary, "active_cycle_lock", "stale_cycle_lock", "cycle_not_idle")) {
    candidate = advice({
      event: "unknown_context",
      outcome: "safe_backoff",
      reason: "Another cycle may still be active, or the previous cycle did not return to idle.",
      nextAction: "stop_and_report",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.next_automation_reason, "warning:cycle_lock_or_not_idle"),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.open_blocker_count > 0 || summary.automation_state === "needs_confirmation" || summary.automation_state === "review_pending") {
    candidate = advice({
      event: "unknown_context",
      outcome: "ask_human",
      reason: "The control plane says a blocker, confirmation boundary, or review-pending state still needs an explicit decision.",
      nextAction: "manual_triage",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.next_automation_reason, `automation_state=${summary.automation_state}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.thread_binding_state !== "bound_to_current") {
    candidate = advice({
      event: "unknown_context",
      outcome: "safe_backoff",
      reason: "The current thread is not the bound operator surface; local automation must move back to the bound thread or use relay as a bridge before continuing.",
      nextAction: "resolve_thread_binding",
      heartbeat: "safe_backoff_30m",
      evidence: evidence(summary.thread_binding_hint, `thread_binding_state=${summary.thread_binding_state}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.next_automation_step === "await_confirmation") {
    candidate = advice({
      event: "proposal_boundary",
      outcome: "ask_human",
      reason: "The next goal or proposal is awaiting confirmation and must not be approved implicitly.",
      nextAction: "pause_or_ask",
      heartbeat: "pause",
      evidence: evidence(summary.next_automation_reason, `goal_supply_state=${summary.goal_supply_state}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.next_automation_step === "create_successor_goal" && summary.ready_for_automation) {
    const successorPolicy = policy.auto_continue.auto_successor_goal;
    const canAutoApprove =
      successorPolicy.enabled &&
      Boolean(successorPolicy.objective?.trim()) &&
      summary.successor_goal_available &&
      summary.successor_goal_auto_approve;
    candidate = advice({
      event: "successor_goal_boundary",
      outcome: canAutoApprove ? "auto_continue" : "ask_human",
      reason: canAutoApprove
        ? "The long-running program charter allows one minimal successor goal after completed approved work."
        : "A successor goal would be needed, but this boundary is not approved for automatic successor creation.",
      nextAction: canAutoApprove ? "create_successor_goal" : "pause_or_ask",
      heartbeat: canAutoApprove ? "burst_1m" : "pause",
      evidence: evidence(
        summary.next_automation_reason,
        summary.successor_goal_reason,
        `auto_approve=${summary.successor_goal_auto_approve}`,
      ),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.tasks_by_status.verify_failed > 0) {
    candidate = advice({
      event: "verification_failure",
      outcome: policy.auto_continue.verification_retry.max_retry_per_task > 0 ? "auto_repair_once" : "ask_human",
      reason: policy.auto_continue.verification_retry.max_retry_per_task > 0
        ? "A verification failure exists and policy allows one bounded repair attempt."
        : "A verification failure exists and policy does not allow automatic repair attempts.",
      nextAction: policy.auto_continue.verification_retry.max_retry_per_task > 0 ? "retry_verification_once" : "pause_or_ask",
      heartbeat: policy.auto_continue.verification_retry.max_retry_per_task > 0 ? "normal_15m" : "pause",
      evidence: evidence(summary.next_automation_reason, `verify_failed=${summary.tasks_by_status.verify_failed}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.next_automation_step === "plan_or_rebalance" && summary.ready_for_automation) {
    candidate = advice({
      event: summary.verification_pending > 0 ? "verification_failure" : "none",
      outcome: "auto_continue",
      reason: summary.verification_pending > 0
        ? "The goal needs bounded planning or verification closeout, but it remains inside the approved goal boundary."
        : "The control plane is ready for a bounded planning or rebalance pass.",
      nextAction: "run_bounded_plan",
      heartbeat: "normal_15m",
      evidence: evidence(summary.next_automation_reason, `verification_pending=${summary.verification_pending}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.ready_for_execution && summary.next_task_id) {
    candidate = advice({
      event: "none",
      outcome: "auto_continue",
      reason: "A concrete next task is ready inside the active approved goal.",
      nextAction: "continue_bounded_loop",
      heartbeat: "burst_1m",
      evidence: evidence(summary.next_automation_reason, `next_task_id=${summary.next_task_id}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  if (summary.ready_for_execution) {
    candidate = advice({
      event: "none",
      outcome: "auto_continue",
      reason: "Execution is ready for one bounded loop inside the approved goal boundary.",
      nextAction: "continue_bounded_loop",
      heartbeat: "normal_15m",
      evidence: evidence(summary.next_automation_reason, `goal_supply_state=${summary.goal_supply_state}`),
    });
    return maybeEscalateByPolicy(candidate, policy);
  }

  candidate = advice({
    event: "none",
    outcome: summary.ready_for_automation ? "safe_backoff" : "ask_human",
    reason: summary.next_automation_reason ?? "No executable autonomy step is currently available.",
    nextAction: summary.ready_for_automation ? "stop_and_report" : "manual_triage",
    heartbeat: summary.ready_for_automation ? "normal_15m" : "safe_backoff_30m",
    evidence: evidence(
      summary.next_automation_reason,
      `ready_for_automation=${summary.ready_for_automation}`,
      `ready_for_execution=${summary.ready_for_execution}`,
    ),
  });
  return maybeEscalateByPolicy(candidate, policy);
}
