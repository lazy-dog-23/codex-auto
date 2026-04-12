import { describe, expect, it } from "vitest";

import type { AutonomyState, TaskRecord } from "../src/domain/types.js";
import {
  applyUnblockRestoration,
  completeWorkerTask,
  decideUnblockRestoration,
  failWorkerVerification,
  rebalanceTaskWindow,
  startWorkerTask,
} from "../src/domain/autonomy.js";

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: overrides.id ?? "task",
    title: overrides.title ?? "task",
    status: overrides.status ?? "queued",
    priority: overrides.priority ?? "P2",
    depends_on: overrides.depends_on ?? [],
    acceptance: overrides.acceptance ?? [],
    file_hints: overrides.file_hints ?? [],
    retry_count: overrides.retry_count ?? 0,
    last_error: overrides.last_error ?? null,
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
  };
}

function makeState(overrides: Partial<AutonomyState> = {}): AutonomyState {
  return {
    version: overrides.version ?? 1,
    current_task_id: overrides.current_task_id ?? null,
    cycle_status: overrides.cycle_status ?? "idle",
    last_planner_run_at: overrides.last_planner_run_at ?? null,
    last_worker_run_at: overrides.last_worker_run_at ?? null,
    last_result: overrides.last_result ?? "noop",
    consecutive_worker_failures: overrides.consecutive_worker_failures ?? 0,
    needs_human_review: overrides.needs_human_review ?? false,
    open_blocker_count: overrides.open_blocker_count ?? 0,
  };
}

describe("task flow", () => {
  it("keeps only the top five eligible tasks in ready", () => {
    const tasks = [
      makeTask({ id: "task-1", priority: "P0", updated_at: "2026-01-01T00:00:00Z" }),
      makeTask({ id: "task-2", priority: "P0", updated_at: "2026-01-02T00:00:00Z" }),
      makeTask({ id: "task-3", priority: "P1", updated_at: "2026-01-03T00:00:00Z" }),
      makeTask({ id: "task-4", priority: "P1", updated_at: "2026-01-04T00:00:00Z" }),
      makeTask({ id: "task-5", priority: "P2", updated_at: "2026-01-05T00:00:00Z" }),
      makeTask({ id: "task-6", priority: "P3", updated_at: "2026-01-06T00:00:00Z" }),
    ];

    const result = rebalanceTaskWindow(tasks, { readyLimit: 5 });

    expect(result.readyTaskIds).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
    expect(result.queuedTaskIds).toContain("task-6");
    expect(result.promotedTaskIds).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
    expect(result.demotedTaskIds).toHaveLength(0);
  });

  it("keeps dependency-blocked tasks out of the ready window", () => {
    const tasks = [
      makeTask({ id: "task-a", priority: "P0", updated_at: "2026-01-01T00:00:00Z" }),
      makeTask({ id: "task-b", priority: "P0", depends_on: ["task-a"], updated_at: "2026-01-02T00:00:00Z" }),
    ];

    const result = rebalanceTaskWindow(tasks, { readyLimit: 5 });

    expect(result.readyTaskIds).toEqual(["task-a"]);
    expect(result.queuedTaskIds).toEqual(["task-b"]);
  });

  it("walks the worker from ready to in_progress to done", () => {
    const state = makeState();
    const readyTask = makeTask({ id: "task-worker", status: "ready", priority: "P1" });

    const started = startWorkerTask(readyTask, state, "2026-01-06T00:00:00Z");
    expect(started.task.status).toBe("in_progress");
    expect(started.state.current_task_id).toBe("task-worker");
    expect(started.state.cycle_status).toBe("working");

    const completed = completeWorkerTask(started.task, started.state, "2026-01-06T01:00:00Z");
    expect(completed.task.status).toBe("done");
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
    expect(firstFailure.escalatedToBlocked).toBe(false);
    expect(firstFailure.blockerSeed).toBeNull();

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
    expect(secondFailure.task.retry_count).toBe(2);
    expect(secondFailure.escalatedToBlocked).toBe(true);
    expect(secondFailure.blockerSeed?.status).toBe("open");
  });

  it("restores a blocked task to ready when dependencies and window allow it", () => {
    const decision = decideUnblockRestoration({
      openBlockerCountForTask: 0,
      dependenciesSatisfied: true,
      readyCount: 2,
      readyLimit: 5,
    });

    expect(decision.nextTaskStatus).toBe("ready");
    expect(decision.entersReadyWindow).toBe(true);

    const restored = applyUnblockRestoration(
      makeTask({ id: "task-blocked", status: "blocked", last_error: "needs unblock" }),
      decision,
      "2026-01-06T03:00:00Z",
    );
    expect(restored.task.status).toBe("ready");
    expect(restored.task.last_error).toBeNull();
  });
});
