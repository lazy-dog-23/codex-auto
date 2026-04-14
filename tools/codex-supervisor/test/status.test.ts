import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AutonomyResults,
  AutonomyState,
  BlockersDocument,
  GoalsDocument,
  TasksDocument,
  VerificationDocument,
} from "../src/contracts/autonomy.js";
import { buildStatusSummary, runStatusCommand } from "../src/commands/status.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");
const tempRoots: string[] = [];

beforeEach(() => {
  delete process.env.CODEX_THREAD_ID;
});

afterEach(async () => {
  delete process.env.CODEX_THREAD_ID;
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-status-"));
  tempRoots.push(root);
  return root;
}

describe("status command", () => {
  it("summarizes goals, tasks, blockers, and next-run eligibility", () => {
    const tasksDoc = readJsonFixture<TasksDocument>("tasks.sample.json");
    const goalsDoc = readJsonFixture<GoalsDocument>("goals.sample.json");
    const state = readJsonFixture<AutonomyState>("state.sample.json");
    const blockersDoc = readJsonFixture<BlockersDocument>("blockers.sample.json");
    const resultsDoc = readJsonFixture<AutonomyResults>("results.sample.json");

    const summary = buildStatusSummary(tasksDoc, goalsDoc, state, blockersDoc, resultsDoc);

    expect(summary.ok).toBe(true);
    expect(summary.total_tasks).toBe(4);
    expect(summary.total_goals).toBe(2);
    expect(summary.tasks_by_status.ready).toBe(1);
    expect(summary.goals_by_status.active).toBe(1);
    expect(summary.goals_by_status.approved).toBe(1);
    expect(summary.open_blocker_count).toBe(1);
    expect(summary.last_result).toBe("planned");
    expect(summary.ready_for_automation).toBe(false);
    expect(summary.results_summary?.planner_summary).toBe("Planned the next ready window.");
    expect(summary.latest_commit_hash).toBe("abc123");
    expect(summary.last_thread_summary_sent_at).toBe("2026-01-05T02:20:00Z");
    expect(summary.last_inbox_run_at).toBe("2026-01-05T02:18:00Z");
    expect(summary.latest_summary_kind).toBe("thread_summary");
    expect(summary.latest_summary_reason).toBe("Heartbeat summary sent to the thread and Inbox.");
    expect(summary.has_recorded_run).toBe(true);
    expect(summary.results_scope_note).toBeNull();
    expect(summary.automation_state).toBe("blocked");
    expect(summary.auto_continue_state).toBe("stopped");
    expect(summary.closeout_policy).toBeNull();
    expect(summary.verification_required).toBe(0);
    expect(summary.verification_passed).toBe(0);
    expect(summary.verification_pending).toBe(0);
    expect(summary.completion_blocked_by_verification).toBe(false);
    expect(summary.next_task_id).toBe("task-b");
    expect(summary.next_task_title).toBe("Wire status report");
    expect(summary.remaining_ready).toBe(1);
    expect(summary.last_followup_summary).toBe("Add a regression check for unblock flow.");
    expect(summary.next_automation_reason).toContain("open blocker");
    expect(summary.message).toContain("ready_for_automation=no");
    expect(summary.message).toContain("auto_continue_state=stopped");
    expect(summary.message).toContain("verification_pending=0");
    expect(summary.message).toContain("summary_kind=thread_summary");
    expect(summary.message).toContain("next_automation_reason=There is 1 open blocker(s).");
  });

  it("surfaces verification closeout gaps even when task execution is otherwise done", () => {
    const verificationDoc: VerificationDocument = {
      version: 1,
      goal_id: "goal-42",
      policy: "strong_template",
      axes: [
        {
          id: "full_e2e",
          title: "Run full e2e",
          required: true,
          status: "pending",
          evidence: [],
          source_task_id: null,
          last_checked_at: null,
          reason: "Not run yet.",
        },
      ],
    };

    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-done",
            goal_id: "goal-42",
            title: "Done task",
            status: "done",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "passed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-42",
            title: "Goal 42",
            objective: "Audit the repo",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "sprint",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-42",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "passed",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-42", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, verification_pending_axes: null },
        worker: { status: "passed", goal_id: "goal-42", task_id: "task-done", summary: "completed task-done", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed", verification_pending_axes: ["full_e2e"] },
        review: { status: "passed", goal_id: "goal-42", task_id: "task-done", summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "followup_required", verification_pending_axes: ["full_e2e"] },
        commit: { status: "passed", goal_id: "goal-42", task_id: "task-done", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "abc123", message: "autonomy(goal-42/task-done): Done task", review_status: null, verification_pending_axes: null },
        reporter: { status: "sent", goal_id: "goal-42", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null, verification_pending_axes: ["full_e2e"] },
      },
      undefined,
      verificationDoc,
    );

    expect(summary.closeout_policy).toBe("strong_template");
    expect(summary.verification_required).toBe(1);
    expect(summary.verification_passed).toBe(0);
    expect(summary.verification_pending).toBe(1);
    expect(summary.completion_blocked_by_verification).toBe(true);
    expect(summary.automation_state).toBe("blocked");
    expect(summary.next_automation_reason).toContain("Verification closeout is still pending");
  });

  it("reports ready_for_automation when the repo is idle and there is active work", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-ready",
            goal_id: "goal-42",
            title: "Ready task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-42",
            title: "Goal 42",
            objective: "Ship it",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "sprint",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-42",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-42", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: "completed task-ready", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        review: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        commit: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "abc123", message: "autonomy(goal-42/task-ready): Ready task", review_status: null },
        reporter: { status: "sent", goal_id: "goal-42", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.ready_for_automation).toBe(true);
    expect(summary.next_automation_ready).toBe(true);
    expect(summary.current_goal_id).toBe("goal-42");
    expect(summary.report_thread_id).toBe("thread-99");
    expect(summary.sprint_active).toBe(true);
    expect(summary.automation_state).toBe("ready");
    expect(summary.results_summary?.worker_result).toBe("completed task-ready");
    expect(summary.auto_continue_state).toBe("running");
    expect(summary.continuation_reason).toBe("Ready for automation: active or planning work is available.");
    expect(summary.next_task_id).toBe("task-ready");
    expect(summary.remaining_ready).toBe(1);
    expect(summary.next_automation_reason).toBe("Ready for automation: active or planning work is available.");
  });

  it("requires report_thread_id before automation can run", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-ready",
            goal_id: "goal-42",
            title: "Ready task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-42",
            title: "Goal 42",
            objective: "Ship it",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "sprint",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-42",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: null,
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-42", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: "completed task-ready", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        review: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        commit: { status: "passed", goal_id: "goal-42", task_id: "task-ready", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "abc123", message: "autonomy(goal-42/task-ready): Ready task", review_status: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.ready_for_automation).toBe(false);
    expect(summary.next_automation_ready).toBe(false);
    expect(summary.thread_binding_state).toBe("unbound_current_unavailable");
    expect(summary.next_automation_reason).toBe(
      "Current thread identity is unavailable in this environment. Run codex-autonomy bind-thread --report-thread-id <id> before automation can run.",
    );
  });

  it("marks completed goal queues as idle_completed instead of generic blocked", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-done",
            title: "Completed Goal",
            objective: "Finished work",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "completed",
            run_mode: "cruise",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: "2026-01-06T00:00:00Z",
          },
        ],
      },
      {
        version: 1,
        current_goal_id: null,
        current_task_id: null,
        cycle_status: "idle",
        run_mode: null,
        last_planner_run_at: null,
        last_worker_run_at: null,
        last_result: "passed",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: false,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "passed", goal_id: "goal-done", task_id: null, summary: "done", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        review: { status: "passed", goal_id: "goal-done", task_id: null, summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        commit: { status: "passed", goal_id: "goal-done", task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "abc123", message: "autonomy(goal-done/task): Done", review_status: null },
        reporter: { status: "sent", goal_id: "goal-done", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.ready_for_automation).toBe(false);
    expect(summary.automation_state).toBe("idle_completed");
    expect(summary.next_automation_reason).toBe("All approved goal work is complete. Automation is idle until a new goal or proposal is created.");
  });

  it("recovers the active goal when state.current_goal_id is missing", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-ready",
            goal_id: "goal-42",
            title: "Ready task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-42",
            title: "Goal 42",
            objective: "Ship it",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "sprint",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: null,
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-42", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.current_goal_id).toBe("goal-42");
    expect(summary.ready_for_automation).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "current_goal_recovered")).toBe(true);
    expect(summary.latest_summary_kind).toBeNull();
    expect(summary.latest_summary_reason).toBe("No recorded autonomy run yet.");
    expect(summary.has_recorded_run).toBe(false);
  });

  it("reads result summaries from autonomy/results.json", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, "autonomy", "locks"), { recursive: true });
    await writeFile(join(workspace, "autonomy", "tasks.json"), `${readFileSync(join(fixturesDir, "tasks.sample.json"), "utf8")}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "goals.json"), `${readFileSync(join(fixturesDir, "goals.sample.json"), "utf8")}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "state.json"), `${readFileSync(join(fixturesDir, "state.sample.json"), "utf8")}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "blockers.json"), `${readFileSync(join(fixturesDir, "blockers.sample.json"), "utf8")}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "results.json"), `${readFileSync(join(fixturesDir, "results.sample.json"), "utf8")}\n`, "utf8");

    const summary = await runStatusCommand(workspace);

    expect(summary.results_summary?.planner_summary).toBe("Planned the next ready window.");
    expect(summary.results_summary?.commit_result).toBe("autonomy(goal-alpha/task-b): Wire status report");
    expect(summary.next_automation_reason).toContain("Current workspace is not a Git repository");
    expect(summary.message).toContain("commit=abc123");
    expect(summary.message).toContain("next_automation_reason=Current workspace is not a Git repository");
  });

  it("runStatusCommand keeps recovered active goals eligible for automation checks", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, "autonomy", "locks"), { recursive: true });
    await writeFile(join(workspace, "autonomy", "tasks.json"), `${JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "task-ready",
          goal_id: "goal-42",
          title: "Ready task",
          status: "ready",
          priority: "P1",
          depends_on: [],
          acceptance: [],
          file_hints: [],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-01-06T00:00:00Z",
          commit_hash: null,
          review_status: "not_reviewed",
        },
      ],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "goals.json"), `${JSON.stringify({
      version: 1,
      goals: [
        {
          id: "goal-42",
          title: "Goal 42",
          objective: "Ship it",
          success_criteria: ["done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "sprint",
          created_at: "2026-01-05T00:00:00Z",
          approved_at: "2026-01-05T00:10:00Z",
          completed_at: null,
        },
      ],
    }, null, 2)}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "state.json"), `${JSON.stringify({
      version: 1,
      current_goal_id: null,
      current_task_id: null,
      cycle_status: "idle",
      run_mode: "sprint",
      last_planner_run_at: "2026-01-05T00:00:00Z",
      last_worker_run_at: "2026-01-05T02:00:00Z",
      last_result: "planned",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: "thread-99",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
      paused: false,
      pause_reason: null,
    }, null, 2)}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "blockers.json"), `${JSON.stringify({ version: 1, blockers: [] }, null, 2)}\n`, "utf8");
    await writeFile(join(workspace, "autonomy", "results.json"), `${JSON.stringify({
      version: 1,
      planner: { status: "planned", goal_id: "goal-42", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
    }, null, 2)}\n`, "utf8");

    const summary = await runStatusCommand(workspace);

    expect(summary.current_goal_id).toBe("goal-42");
    expect(summary.ready_for_automation).toBe(false);
    expect(summary.next_automation_reason).toContain("Current workspace is not a Git repository");
    expect(summary.warnings?.some((warning) => warning.code === "current_goal_recovered")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "no_actionable_work")).toBe(false);
    expect(summary.latest_summary_kind).toBeNull();
    expect(summary.latest_summary_reason).toBe("No recorded autonomy run yet.");
    expect(summary.has_recorded_run).toBe(false);
  });

  it("does not treat verify_failed-only queues as ready for automation", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-retry",
            goal_id: "goal-retry",
            title: "Retry later",
            status: "verify_failed",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 1,
            last_error: "verify failed",
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-retry",
            title: "Retry Goal",
            objective: "retry",
            success_criteria: ["retry"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "cruise",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:01:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-retry",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "cruise",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "failed",
        consecutive_worker_failures: 1,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: null,
        autonomy_branch: "codex/autonomy",
        sprint_active: false,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "failed", goal_id: "goal-retry", task_id: "task-retry", summary: "verify failed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.ready_for_automation).toBe(false);
  });

  it("scopes execution summaries to the current goal", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-new",
            goal_id: "goal-new",
            title: "Current goal task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-new",
            title: "Current goal",
            objective: "Ship the new work",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            run_mode: "sprint",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-new",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-new", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: "completed old task", happened_at: null, sent_at: null, verify_summary: "old verify", hash: null, message: null, review_status: "passed" },
        review: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: "old review", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        commit: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "old123", message: "autonomy(goal-old/task-old): Old task", review_status: null },
        reporter: { status: "sent", goal_id: "goal-old", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.results_summary?.planner_summary).toBe("planned next task");
    expect(summary.results_summary?.worker_result).toBeNull();
    expect(summary.results_summary?.review_result).toBeNull();
    expect(summary.results_summary?.commit_result).toBeNull();
    expect(summary.latest_commit_hash).toBeNull();
    expect(summary.results_scope_note).toContain("goal-old");
  });

  it("does not treat stale current_goal_id pointers as actionable work", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [
          {
            id: "task-stale",
            goal_id: "goal-stale",
            title: "Stale task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-06T00:00:00Z",
            commit_hash: null,
            review_status: "not_reviewed",
            source: "proposal",
            source_task_id: null,
          },
        ],
      },
      {
        version: 1,
        goals: [
          {
            id: "goal-other",
            title: "Other goal",
            objective: "No active goal should be recovered here.",
            success_criteria: ["done"],
            constraints: [],
            out_of_scope: [],
            status: "approved",
            run_mode: "cruise",
            created_at: "2026-01-05T00:00:00Z",
            approved_at: "2026-01-05T00:10:00Z",
            completed_at: null,
          },
        ],
      },
      {
        version: 1,
        current_goal_id: "goal-stale",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "cruise",
        last_planner_run_at: "2026-01-05T00:00:00Z",
        last_worker_run_at: "2026-01-05T02:00:00Z",
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: false,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.current_goal_id).toBeNull();
    expect(summary.ready_for_automation).toBe(false);
    expect(summary.warnings?.some((warning) => warning.code === "stale_current_goal_id")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "inactive_current_goal_id")).toBe(false);
  });

  it("hides historical execution results when the current goal cannot be resolved", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [],
      },
      {
        version: 1,
        goals: [],
      },
      {
        version: 1,
        current_goal_id: null,
        current_task_id: null,
        cycle_status: "idle",
        run_mode: null,
        last_planner_run_at: null,
        last_worker_run_at: null,
        last_result: "noop",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-99",
        autonomy_branch: "codex/autonomy",
        sprint_active: false,
        paused: false,
        pause_reason: null,
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "planned", goal_id: "goal-next", task_id: null, summary: "planned next task", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: "completed old task", happened_at: null, sent_at: null, verify_summary: "old verify", hash: null, message: null, review_status: "passed" },
        review: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: "old review", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
        commit: { status: "passed", goal_id: "goal-old", task_id: "task-old", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "old123", message: "autonomy(goal-old/task-old): Old task", review_status: null },
        reporter: { status: "sent", goal_id: "goal-old", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.results_summary?.planner_summary).toBe("planned next task");
    expect(summary.results_summary?.worker_result).toBeNull();
    expect(summary.results_summary?.review_result).toBeNull();
    expect(summary.results_summary?.commit_result).toBeNull();
    expect(summary.latest_commit_hash).toBeNull();
    expect(summary.results_scope_note).toContain("Current goal is unresolved");
  });

  it("preserves legacy summary timestamps as recorded run metadata", () => {
    const summary = buildStatusSummary(
      {
        version: 1,
        tasks: [],
      },
      {
        version: 1,
        goals: [],
      },
      {
        version: 1,
        current_goal_id: null,
        current_task_id: null,
        cycle_status: "idle",
        run_mode: null,
        last_planner_run_at: null,
        last_worker_run_at: null,
        last_result: "noop",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: null,
        autonomy_branch: "codex/autonomy",
        sprint_active: false,
        paused: false,
        pause_reason: null,
        last_thread_summary_sent_at: "2026-04-13T01:00:00Z",
        last_inbox_run_at: "2026-04-13T00:55:00Z",
      },
      {
        version: 1,
        blockers: [],
      },
      {
        version: 1,
        planner: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      },
    );

    expect(summary.has_recorded_run).toBe(true);
    expect(summary.latest_summary_kind).toBe("thread_summary");
    expect(summary.last_thread_summary_sent_at).toBe("2026-04-13T01:00:00Z");
    expect(summary.last_inbox_run_at).toBe("2026-04-13T00:55:00Z");
  });
});
