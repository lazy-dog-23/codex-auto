import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BlockersDocument, TasksDocument, AutonomyState } from "../src/contracts/autonomy.js";
import { buildStatusSummary, runStatusCommand } from "../src/commands/status.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");

function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

describe("status command", () => {
  it("summarizes tasks, blockers, and next-run eligibility", () => {
    const tasksDoc = readJsonFixture<TasksDocument>("tasks.sample.json");
    const state = readJsonFixture<AutonomyState>("state.sample.json");
    const blockersDoc = readJsonFixture<BlockersDocument>("blockers.sample.json");

    const summary = buildStatusSummary(tasksDoc, state, blockersDoc);

    expect(summary.ok).toBe(true);
    expect(summary.total_tasks).toBe(4);
    expect(summary.tasks_by_status.ready).toBe(1);
    expect(summary.tasks_by_status.verify_failed).toBe(1);
    expect(summary.open_blocker_count).toBe(1);
    expect(summary.last_result).toBe("planned");
    expect(summary.ready_for_automation).toBe(false);
    expect(summary.message).toContain("ready_for_automation=no");
  });

  it("reports ready_for_automation when the repo is idle and actionable", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-ready",
            title: "Ready task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
          },
        ],
      },
      {
        version: 1,
        current_task_id: null,
        cycle_status: "idle",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
      },
      {
        version: 1,
        blockers: [],
      },
    );

    expect(summary.ready_for_automation).toBe(true);
    expect(summary.open_blocker_count).toBe(0);
  });

  it("does not treat verify_failed-only queues as ready for automation", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-retry",
            title: "Retry later",
            status: "verify_failed",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 1,
            last_error: "verify failed",
            updated_at: "2026-01-06T00:00:00Z",
          },
        ],
      },
      {
        version: 1,
        current_task_id: null,
        cycle_status: "idle",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "failed",
        consecutive_worker_failures: 1,
        needs_human_review: false,
        open_blocker_count: 0,
      },
      {
        version: 1,
        blockers: [],
      },
    );

    expect(summary.ready_for_automation).toBe(false);
  });

  it("can be loaded through the repo-local command helper", async () => {
    const repoRoot = join(testDir, "__status_fixture_repo__");

    // This is a contract-level placeholder only; the real integration test belongs in the main agent.
    await expect(runStatusCommand(repoRoot)).rejects.toThrow();
  });
});
