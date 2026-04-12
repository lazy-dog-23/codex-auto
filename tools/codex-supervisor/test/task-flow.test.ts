import { describe, expect, it } from "vitest";

import type { AutonomyState, GoalRecord, GoalProposal, TaskRecord } from "../src/domain/types.js";
import {
  activateGoal,
  applyUnblockRestoration,
  completeCurrentGoalIfEligible,
  completeWorkerTask,
  decideUnblockRestoration,
  failWorkerVerification,
  materializeProposal,
  rebalanceTaskWindow,
  startWorkerTask,
} from "../src/domain/autonomy.js";

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: overrides.id ?? "task",
    goal_id: overrides.goal_id ?? "goal-a",
    title: overrides.title ?? "task",
    status: overrides.status ?? "queued",
    priority: overrides.priority ?? "P2",
    depends_on: overrides.depends_on ?? [],
    acceptance: overrides.acceptance ?? [],
    file_hints: overrides.file_hints ?? [],
    retry_count: overrides.retry_count ?? 0,
    last_error: overrides.last_error ?? null,
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
    commit_hash: overrides.commit_hash ?? null,
    review_status: overrides.review_status ?? "not_reviewed",
  };
}

function makeState(overrides: Partial<AutonomyState> = {}): AutonomyState {
  return {
    version: overrides.version ?? 1,
    current_goal_id: overrides.current_goal_id ?? "goal-a",
    current_task_id: overrides.current_task_id ?? null,
    cycle_status: overrides.cycle_status ?? "idle",
    run_mode: overrides.run_mode ?? "cruise",
    last_planner_run_at: overrides.last_planner_run_at ?? null,
    last_worker_run_at: overrides.last_worker_run_at ?? null,
    last_result: overrides.last_result ?? "noop",
    consecutive_worker_failures: overrides.consecutive_worker_failures ?? 0,
    needs_human_review: overrides.needs_human_review ?? false,
    open_blocker_count: overrides.open_blocker_count ?? 0,
    report_thread_id: overrides.report_thread_id ?? null,
    autonomy_branch: overrides.autonomy_branch ?? "codex/autonomy",
    sprint_active: overrides.sprint_active ?? false,
    paused: overrides.paused ?? false,
    pause_reason: overrides.pause_reason ?? null,
  };
}

function makeGoal(overrides: Partial<GoalRecord>): GoalRecord {
  return {
    id: overrides.id ?? "goal-a",
    title: overrides.title ?? "Goal A",
    objective: overrides.objective ?? "Ship goal A",
    success_criteria: overrides.success_criteria ?? ["done"],
    constraints: overrides.constraints ?? [],
    out_of_scope: overrides.out_of_scope ?? [],
    status: overrides.status ?? "active",
    run_mode: overrides.run_mode ?? "cruise",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    approved_at: overrides.approved_at ?? "2026-01-01T00:10:00Z",
    completed_at: overrides.completed_at ?? null,
  };
}

function makeProposal(overrides: Partial<GoalProposal> = {}): GoalProposal {
  return {
    goal_id: overrides.goal_id ?? "goal-a",
    status: overrides.status ?? "awaiting_confirmation",
    summary: overrides.summary ?? "Plan the first two tasks.",
    tasks: overrides.tasks ?? [
      {
        id: "task-1",
        title: "Task 1",
        priority: "P1",
        depends_on: [],
        acceptance: ["done"],
        file_hints: ["src/task.ts"],
      },
    ],
    created_at: overrides.created_at ?? "2026-01-01T01:00:00Z",
    approved_at: overrides.approved_at ?? null,
  };
}

describe("task flow", () => {
  it("keeps only the top five eligible tasks in ready for the current goal", () => {
    const tasks = [
      makeTask({ id: "task-1", priority: "P0", updated_at: "2026-01-01T00:00:00Z" }),
      makeTask({ id: "task-2", priority: "P0", updated_at: "2026-01-02T00:00:00Z" }),
      makeTask({ id: "task-3", priority: "P1", updated_at: "2026-01-03T00:00:00Z" }),
      makeTask({ id: "task-4", priority: "P1", updated_at: "2026-01-04T00:00:00Z" }),
      makeTask({ id: "task-5", priority: "P2", updated_at: "2026-01-05T00:00:00Z" }),
      makeTask({ id: "task-6", priority: "P3", updated_at: "2026-01-06T00:00:00Z" }),
      makeTask({ id: "task-other-goal", goal_id: "goal-b", priority: "P0" }),
    ];

    const result = rebalanceTaskWindow(tasks, { readyLimit: 5, currentGoalId: "goal-a" });

    expect(result.readyTaskIds).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
    expect(result.queuedTaskIds).toContain("task-6");
    expect(result.queuedTaskIds).toContain("task-other-goal");
  });

  it("walks the worker from ready to in_progress to done", () => {
    const state = makeState();
    const readyTask = makeTask({ id: "task-worker", status: "ready", priority: "P1" });

    const started = startWorkerTask(readyTask, state, "2026-01-06T00:00:00Z");
    expect(started.task.status).toBe("in_progress");
    expect(started.state.current_task_id).toBe("task-worker");
    expect(started.state.current_goal_id).toBe("goal-a");

    const completed = completeWorkerTask(started.task, started.state, "2026-01-06T01:00:00Z", {
      reviewStatus: "passed",
      commitHash: "abc123",
    });
    expect(completed.task.status).toBe("done");
    expect(completed.task.review_status).toBe("passed");
    expect(completed.task.commit_hash).toBe("abc123");
    expect(completed.state.current_task_id).toBeNull();
    expect(completed.state.cycle_status).toBe("idle");
    expect(completed.state.last_result).toBe("passed");
  });

  it("moves a failed verification from verify_failed to blocked on retry", () => {
    const state = makeState({ current_task_id: "task-worker", cycle_status: "working" });
    const inProgress = makeTask({ id: "task-worker", status: "in_progress", priority: "P1", retry_count: 0 });

    const firstFailure = failWorkerVerification(inProgress, state, "2026-01-06T01:00:00Z", {
      reason: "schema mismatch",
    });
    expect(firstFailure.task.status).toBe("verify_failed");
    expect(firstFailure.task.retry_count).toBe(1);

    const secondFailure = failWorkerVerification(
      {
        ...inProgress,
        retry_count: 1,
      },
      state,
      "2026-01-06T02:00:00Z",
      {
        reason: "schema mismatch again",
      },
    );
    expect(secondFailure.task.status).toBe("blocked");
    expect(secondFailure.blockerSeed?.status).toBe("open");
  });

  it("restores a blocked task to ready only when its goal is active", () => {
    const activeDecision = decideUnblockRestoration({
      taskGoalId: "goal-a",
      currentGoalId: "goal-a",
      openBlockerCountForTask: 0,
      dependenciesSatisfied: true,
      readyCount: 2,
      readyLimit: 5,
    });
    expect(activeDecision.nextTaskStatus).toBe("ready");

    const inactiveDecision = decideUnblockRestoration({
      taskGoalId: "goal-b",
      currentGoalId: "goal-a",
      openBlockerCountForTask: 0,
      dependenciesSatisfied: true,
      readyCount: 0,
      readyLimit: 5,
    });
    expect(inactiveDecision.nextTaskStatus).toBe("queued");
    expect(inactiveDecision.reason).toBe("goal_not_active");

    const restored = applyUnblockRestoration(
      makeTask({ id: "task-blocked", status: "blocked", last_error: "needs unblock" }),
      activeDecision,
      "2026-01-06T03:00:00Z",
    );
    expect(restored.task.status).toBe("ready");
  });

  it("materializes an approved proposal into queued tasks and activates the goal", () => {
    const proposal = makeProposal();
    const result = materializeProposal(
      [makeGoal({ id: "goal-a", status: "awaiting_confirmation" })],
      [proposal],
      [],
      makeState({ current_goal_id: null, run_mode: null }),
      "goal-a",
      "2026-01-06T04:00:00Z",
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.goal_id).toBe("goal-a");
    expect(result.tasks[0]?.status).toBe("queued");
    expect(result.goals[0]?.status).toBe("active");
    expect(result.state.current_goal_id).toBe("goal-a");
  });

  it("completes the current goal and activates the next approved goal", () => {
    const goals = [
      makeGoal({ id: "goal-a", status: "active" }),
      makeGoal({ id: "goal-b", status: "approved", run_mode: "sprint", approved_at: "2026-01-02T00:00:00Z" }),
    ];
    const tasks = [makeTask({ id: "task-done", goal_id: "goal-a", status: "done" })];
    const state = makeState({ current_goal_id: "goal-a", run_mode: "cruise" });

    const result = completeCurrentGoalIfEligible(goals, tasks, state, "2026-01-06T05:00:00Z");

    expect(result.completedGoalId).toBe("goal-a");
    expect(result.activatedGoalId).toBe("goal-b");
    expect(result.state.current_goal_id).toBe("goal-b");
    expect(result.state.run_mode).toBe("sprint");
    expect(result.state.sprint_active).toBe(true);
  });

  it("activates a chosen goal and demotes any other active goal back to approved", () => {
    const result = activateGoal(
      [makeGoal({ id: "goal-a", status: "active" }), makeGoal({ id: "goal-b", status: "approved" })],
      makeState({ current_goal_id: "goal-a" }),
      "goal-b",
    );

    expect(result.goals.find((goal) => goal.id === "goal-a")?.status).toBe("approved");
    expect(result.goals.find((goal) => goal.id === "goal-b")?.status).toBe("active");
    expect(result.state.current_goal_id).toBe("goal-b");
  });
});
