import { describe, expect, it } from "vitest";

import type { StatusSummary } from "../src/contracts/autonomy.js";
import { buildDecisionAdvice } from "../src/domain/decision.js";
import { createDefaultDecisionPolicyDocument } from "../src/shared/policy.js";

function makeStatus(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    ok: true,
    message: "",
    warnings: undefined,
    total_tasks: 1,
    total_goals: 1,
    tasks_by_status: {
      queued: 0,
      ready: 1,
      in_progress: 0,
      verify_failed: 0,
      blocked: 0,
      done: 0,
    },
    goals_by_status: {
      draft: 0,
      awaiting_confirmation: 0,
      approved: 0,
      active: 1,
      completed: 0,
      blocked: 0,
      cancelled: 0,
    },
    current_goal_id: "goal-1",
    current_task_id: null,
    cycle_status: "idle",
    run_mode: "sprint",
    open_blocker_count: 0,
    last_result: "planned",
    ready_for_automation: true,
    paused: false,
    review_pending_reason: null,
    latest_commit_hash: null,
    latest_commit_message: null,
    report_thread_id: "thread-1",
    current_thread_id: "thread-1",
    current_thread_source: "env",
    thread_binding_state: "bound_to_current",
    thread_binding_hint: null,
    autonomy_branch: "codex/autonomy",
    sprint_active: true,
    last_thread_summary_sent_at: null,
    last_inbox_run_at: null,
    latest_summary_kind: null,
    latest_summary_reason: null,
    has_recorded_run: false,
    results_scope_note: null,
    next_automation_reason: "Ready for execution: active task work is available.",
    recommended_automation_surface: "thread_automation",
    recommended_automation_reason: "Current thread is bound.",
    recommended_automation_prompt: "official_thread_automation",
    automation_state: "ready",
    auto_continue_state: "running",
    continuation_reason: "Ready for execution: active task work is available.",
    closeout_policy: null,
    verification_required: 0,
    verification_passed: 0,
    verification_pending: 0,
    completion_blocked_by_verification: false,
    successor_goal_available: false,
    successor_goal_auto_approve: false,
    successor_goal_reason: null,
    next_task_id: "task-1",
    next_task_title: "Do the task",
    remaining_ready: 1,
    last_followup_summary: null,
    upgrade_state: null,
    upgrade_blocking: false,
    upgrade_hint: null,
    cli_install_state: null,
    goal_supply_state: "active_goal",
    next_automation_step: "execute_bounded_loop",
    ready_for_execution: true,
    decision_event: "none",
    decision_outcome: "auto_continue",
    decision_reason: "",
    decision_next_action: "continue_bounded_loop",
    decision_heartbeat: "burst_1m",
    decision_evidence: [],
    results_summary: null,
    next_automation_ready: true,
    ...overrides,
  };
}

describe("decision advice", () => {
  it("continues a ready bounded task with burst follow-up", () => {
    const advice = buildDecisionAdvice(makeStatus());

    expect(advice.decision_event).toBe("none");
    expect(advice.decision_outcome).toBe("auto_continue");
    expect(advice.decision_next_action).toBe("continue_bounded_loop");
    expect(advice.decision_heartbeat).toBe("burst_1m");
  });

  it("asks at successor boundaries when auto approval is disabled", () => {
    const advice = buildDecisionAdvice(makeStatus({
      total_tasks: 0,
      tasks_by_status: {
        queued: 0,
        ready: 0,
        in_progress: 0,
        verify_failed: 0,
        blocked: 0,
        done: 0,
      },
      goals_by_status: {
        draft: 0,
        awaiting_confirmation: 0,
        approved: 0,
        active: 0,
        completed: 1,
        blocked: 0,
        cancelled: 0,
      },
      current_goal_id: null,
      ready_for_execution: false,
      next_task_id: null,
      next_task_title: null,
      remaining_ready: 0,
      goal_supply_state: "successor_goal_available",
      next_automation_step: "create_successor_goal",
      next_automation_reason: "Ready for program continuation: all approved work is complete and policy allows one minimal successor goal.",
      successor_goal_available: true,
      successor_goal_auto_approve: false,
      successor_goal_reason: "Program charter allows drafting one minimal successor goal, but auto approval is disabled.",
    }));

    expect(advice.decision_event).toBe("successor_goal_boundary");
    expect(advice.decision_outcome).toBe("ask_human");
    expect(advice.decision_next_action).toBe("pause_or_ask");
    expect(advice.decision_heartbeat).toBe("pause");
  });

  it("does not auto-continue from a non-bound thread", () => {
    const advice = buildDecisionAdvice(makeStatus({
      thread_binding_state: "bound_to_other",
      thread_binding_hint: "Current thread is not the bound operator thread.",
      recommended_automation_surface: "external_relay_scheduler",
      recommended_automation_prompt: "external_relay_scheduler",
      recommended_automation_reason: "Wake the bound thread through relay.",
    }));

    expect(advice.decision_outcome).not.toBe("auto_continue");
    expect(advice.decision_next_action).toBe("pause_or_ask");
    expect(advice.decision_reason).toContain("current thread is not the bound operator surface");
  });

  it("repairs recoverable closeout diffs once", () => {
    const advice = buildDecisionAdvice(makeStatus({
      warnings: [
        {
          code: "repo_dirty_review_recoverable",
          message: "Current repository has a recoverable autonomy closeout diff: docs/api_docs.md.",
        },
      ],
      ready_for_automation: false,
      ready_for_execution: false,
      next_automation_reason: "Current repository has a recoverable autonomy closeout diff: docs/api_docs.md.",
    }));

    expect(advice.decision_event).toBe("recoverable_closeout");
    expect(advice.decision_outcome).toBe("auto_repair_once");
    expect(advice.decision_next_action).toBe("run_verify_then_review");
  });

  it("honors policy escalation for verification failures", () => {
    const policy = createDefaultDecisionPolicyDocument();
    policy.ask_human = [...policy.ask_human, "verification_failure"];

    const advice = buildDecisionAdvice(makeStatus({
      tasks_by_status: {
        queued: 0,
        ready: 0,
        in_progress: 0,
        verify_failed: 1,
        blocked: 0,
        done: 0,
      },
      ready_for_execution: false,
      next_task_id: null,
    }), policy);

    expect(advice.decision_event).toBe("verification_failure");
    expect(advice.decision_outcome).toBe("ask_human");
    expect(advice.decision_next_action).toBe("pause_or_ask");
  });
});
