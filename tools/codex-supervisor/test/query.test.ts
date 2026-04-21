import { describe, expect, it } from "vitest";

import type {
  AutonomyResults,
  AutonomyState,
  BlockersDocument,
  GoalsDocument,
  TasksDocument,
  VerificationDocument,
} from "../src/contracts/autonomy.js";
import {
  buildQueryResult,
} from "../src/commands/query.js";
import { buildStatusSummary } from "../src/commands/status.js";
import {
  createDefaultDecisionPolicy,
  createDefaultResultsDocument,
  createDefaultSettingsDocument,
} from "../src/commands/control-plane.js";

function baseState(): AutonomyState {
  return {
    version: 1,
    current_goal_id: "goal-1",
    current_task_id: null,
    cycle_status: "idle",
    run_mode: "sprint",
    last_planner_run_at: null,
    last_worker_run_at: null,
    last_result: "planned",
    consecutive_worker_failures: 0,
    needs_human_review: false,
    open_blocker_count: 0,
    report_thread_id: "thread-1",
    autonomy_branch: "codex/autonomy",
    sprint_active: true,
    paused: false,
    pause_reason: null,
  };
}

function baseDocuments(): {
  tasks: TasksDocument;
  goals: GoalsDocument;
  state: AutonomyState;
  blockers: BlockersDocument;
  results: AutonomyResults;
  verification: VerificationDocument;
} {
  return {
    tasks: {
      version: 1,
      tasks: [
        {
          id: "task-1",
          goal_id: "goal-1",
          title: "Do one thing",
          status: "ready",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/main.ts"],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-04-20T00:00:00.000Z",
          commit_hash: null,
          review_status: "not_reviewed",
          source: "proposal",
          source_task_id: null,
        },
      ],
    },
    goals: {
      version: 1,
      goals: [
        {
          id: "goal-1",
          title: "Goal",
          objective: "Ship the goal",
          success_criteria: ["done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "sprint",
          created_at: "2026-04-20T00:00:00.000Z",
          approved_at: "2026-04-20T00:01:00.000Z",
          completed_at: null,
        },
      ],
    },
    state: baseState(),
    blockers: { version: 1, blockers: [] },
    results: createDefaultResultsDocument(),
    verification: { version: 1, goal_id: "goal-1", policy: "strong_template", axes: [] },
  };
}

describe("query", () => {
  it("compresses status into a stable machine-readable automation payload", () => {
    const docs = baseDocuments();
    const status = buildStatusSummary(
      docs.tasks,
      docs.goals,
      docs.state,
      docs.blockers,
      docs.results,
      createDefaultSettingsDocument(),
      docs.verification,
      {
        decisionPolicy: createDefaultDecisionPolicy(),
        threadBindingContext: {
          currentThreadId: "thread-1",
          currentThreadSource: "env",
          bindingState: "bound_to_current",
          bindingHint: null,
        },
      },
    );

    const query = buildQueryResult("C:/repo", status);

    expect(query.ok).toBe(true);
    expect(query.target_path).toBe("C:/repo");
    expect(query.state.ready_for_automation).toBe(true);
    expect(query.state.next_automation_step).toBe("execute_bounded_loop");
    expect(query.thread.binding_state).toBe("bound_to_current");
    expect(query.next_task).toEqual({
      id: "task-1",
      title: "Do one thing",
      remaining_ready: 1,
    });
    expect(query.recommended_action).toBe("continue_bounded_loop");
  });

  it("preserves blocking warnings and recommended stop action", () => {
    const docs = baseDocuments();
    docs.state = {
      ...docs.state,
      cycle_status: "blocked",
      needs_human_review: true,
      open_blocker_count: 1,
    };
    docs.blockers = {
      version: 1,
      blockers: [
        {
          id: "blocker-1",
          task_id: "task-1",
          question: "Need input",
          severity: "medium",
          status: "open",
          resolution: null,
          opened_at: "2026-04-20T00:00:00.000Z",
          resolved_at: null,
        },
      ],
    };

    const status = buildStatusSummary(
      docs.tasks,
      docs.goals,
      docs.state,
      docs.blockers,
      docs.results,
      createDefaultSettingsDocument(),
      docs.verification,
      {
        decisionPolicy: createDefaultDecisionPolicy(),
        threadBindingContext: {
          currentThreadId: "thread-1",
          currentThreadSource: "env",
          bindingState: "bound_to_current",
          bindingHint: null,
        },
      },
    );
    const query = buildQueryResult("C:/repo", status);

    expect(query.state.ready_for_automation).toBe(false);
    expect(query.blockers.open_count).toBe(1);
    expect(query.recommended_action).toBe("manual_triage");
    expect(query.message).toContain("ready_for_automation=no");
  });
});
