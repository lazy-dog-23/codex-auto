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
import { runReport } from "../src/commands/report.js";

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-report-"));
  tempRoots.push(root);
  await mkdir(join(root, "autonomy"), { recursive: true });
  return root;
}

async function writeControlPlaneFiles(
  workspace: string,
  docs: {
    goals: GoalsDocument;
    tasks: TasksDocument;
    state: AutonomyState;
    blockers: BlockersDocument;
    results: AutonomyResults;
    verification?: VerificationDocument;
  },
): Promise<void> {
  await writeFile(join(workspace, "autonomy", "goals.json"), `${JSON.stringify(docs.goals, null, 2)}\n`, "utf8");
  await writeFile(join(workspace, "autonomy", "tasks.json"), `${JSON.stringify(docs.tasks, null, 2)}\n`, "utf8");
  await writeFile(join(workspace, "autonomy", "state.json"), `${JSON.stringify(docs.state, null, 2)}\n`, "utf8");
  await writeFile(join(workspace, "autonomy", "blockers.json"), `${JSON.stringify(docs.blockers, null, 2)}\n`, "utf8");
  await writeFile(join(workspace, "autonomy", "results.json"), `${JSON.stringify(docs.results, null, 2)}\n`, "utf8");
  if (docs.verification) {
    await writeFile(join(workspace, "autonomy", "verification.json"), `${JSON.stringify(docs.verification, null, 2)}\n`, "utf8");
  }
}

describe("report command", () => {
  it("summarizes the current goal, task, recent verify/review/commit, blockers, and paused state", async () => {
    const goals = readJsonFixture<GoalsDocument>("goals.sample.json");
    const tasks = readJsonFixture<TasksDocument>("tasks.sample.json");
    const state = readJsonFixture<AutonomyState>("state.sample.json");
    const blockers = readJsonFixture<BlockersDocument>("blockers.sample.json");
    const results = readJsonFixture<AutonomyResults>("results.sample.json");
    const workspace = await makeTempWorkspace();

    state.paused = true;
    state.pause_reason = "needs human review";

    await writeControlPlaneFiles(workspace, { goals, tasks, state, blockers, results });

    const report = await runReport(workspace);

    expect(report.current_goal?.id).toBe("goal-alpha");
    expect(report.previous_goal).toBeNull();
    expect(report.current_task?.id).toBe("task-b");
    expect(report.latest_verify_summary).toBe("verify passed");
    expect(report.latest_review_summary).toBe("Review passed.");
    expect(report.latest_commit_hash).toBe("abc123");
    expect(report.latest_commit_message).toBe("autonomy(goal-alpha/task-b): Wire status report");
    expect(report.last_thread_summary_sent_at).toBe("2026-01-05T02:20:00Z");
    expect(report.last_inbox_run_at).toBe("2026-01-05T02:18:00Z");
    expect(report.latest_summary_kind).toBe("thread_summary");
    expect(report.latest_summary_reason).toBe("Heartbeat summary sent to the thread and Inbox.");
    expect(report.has_recorded_run).toBe(true);
    expect(report.results_scope_note).toBeNull();
    expect(report.auto_continue_state).toBe("stopped");
    expect(report.closeout_policy).toBeNull();
    expect(report.verification_required).toBe(0);
    expect(report.verification_passed).toBe(0);
    expect(report.verification_pending).toBe(0);
    expect(report.completion_blocked_by_verification).toBe(false);
    expect(report.next_task_id).toBe("task-b");
    expect(report.remaining_ready).toBe(1);
    expect(report.last_followup_summary).toBe("Add a regression check for unblock flow.");
    expect(report.next_automation_reason).toContain("Current workspace is not a Git repository");
    expect(report.runtime_reason).toContain("Current workspace is not a Git repository");
    expect(report.open_blockers).toHaveLength(1);
    expect(report.open_blockers[0]?.id).toBe("blocker-a");
    expect(report.goal_transition).toBeNull();
    expect(report.healthy_runtime).toBe(false);
    expect(report.runtime_warnings.some((warning) => warning.code === "not_a_git_repo")).toBe(true);
    expect(report.message).toContain("goal=goal-alpha(Stabilize the autonomy control plane)");
    expect(report.message).toContain("task=task-b(Wire status report)[ready,priority=P1,review=passed,commit=abc123]");
    expect(report.message).toContain("verify=verify passed");
    expect(report.message).toContain("review=Review passed.");
    expect(report.message).toContain("commit=abc123:autonomy(goal-alpha/task-b): Wire status report");
    expect(report.message).toContain("open_blockers=1[blocker-a/task-c:medium]");
    expect(report.message).toContain("paused=yes(needs human review)");
    expect(report.message).toContain("goal_transition=none");
    expect(report.message).toContain("auto_continue_state=stopped");
    expect(report.message).toContain("verification_pending=0");
    expect(report.message).toContain("runtime=warning[not_a_git_repo]");
  });

  it("reports verification closeout gaps as a first-class stop reason", async () => {
    const goals = clone(readJsonFixture<GoalsDocument>("goals.sample.json"));
    const tasks = clone(readJsonFixture<TasksDocument>("tasks.sample.json"));
    const state = clone(readJsonFixture<AutonomyState>("state.sample.json"));
    const blockers = clone(readJsonFixture<BlockersDocument>("blockers.sample.json"));
    const results = clone(readJsonFixture<AutonomyResults>("results.sample.json"));
    const workspace = await makeTempWorkspace();

    tasks.tasks = [
      {
        ...tasks.tasks[0]!,
        id: "task-done",
        goal_id: "goal-alpha",
        title: "Done task",
        status: "done",
        review_status: "passed",
      },
    ];
    blockers.blockers = [];
    state.open_blocker_count = 0;
    state.current_task_id = null;

    await writeControlPlaneFiles(workspace, {
      goals,
      tasks,
      state,
      blockers,
      results,
      verification: {
        version: 1,
        goal_id: "goal-alpha",
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
      },
    });

    const report = await runReport(workspace);

    expect(report.closeout_policy).toBe("strong_template");
    expect(report.verification_required).toBe(1);
    expect(report.verification_passed).toBe(0);
    expect(report.verification_pending).toBe(1);
    expect(report.completion_blocked_by_verification).toBe(true);
    expect(report.message).toContain("completion_blocked_by_verification=yes");
  });

  it("describes a completed goal and the newly active goal when the thread has switched goals", async () => {
    const goals = clone(readJsonFixture<GoalsDocument>("goals.sample.json"));
    const tasks = clone(readJsonFixture<TasksDocument>("tasks.sample.json"));
    const state = clone(readJsonFixture<AutonomyState>("state.sample.json"));
    const blockers = clone(readJsonFixture<BlockersDocument>("blockers.sample.json"));
    const results = clone(readJsonFixture<AutonomyResults>("results.sample.json"));
    const workspace = await makeTempWorkspace();

    goals.goals = [
      {
        ...goals.goals[0]!,
        id: "goal-alpha",
        title: "Wrap up the first goal",
        status: "completed",
        completed_at: "2026-01-07T10:00:00Z",
      },
      {
        ...goals.goals[1]!,
        id: "goal-beta",
        title: "Start the follow-up goal",
        status: "active",
        run_mode: "sprint",
        approved_at: "2026-01-07T10:01:00Z",
      },
    ];
    tasks.tasks = [
      {
        ...tasks.tasks[0]!,
        id: "task-beta-1",
        goal_id: "goal-beta",
        title: "Kick off the next goal",
        status: "ready",
        priority: "P0",
        updated_at: "2026-01-07T10:02:00Z",
        commit_hash: "def456",
        review_status: "passed",
      },
    ];
    state.current_goal_id = "goal-beta";
    state.current_task_id = null;
    state.run_mode = "sprint";
    state.paused = false;
    state.pause_reason = null;
    state.report_thread_id = "thread-123";
    state.open_blocker_count = 0;
    blockers.blockers = [];
    results.worker.goal_id = "goal-beta";
    results.worker.task_id = "task-beta-1";
    results.worker.summary = "Completed the follow-up task.";
    results.worker.verify_summary = "verify passed again";
    results.review.goal_id = "goal-beta";
    results.review.task_id = "task-beta-1";
    results.review.summary = "Follow-up review passed.";
    results.commit.goal_id = "goal-beta";
    results.commit.task_id = "task-beta-1";
    results.commit.hash = "def456";
    results.commit.message = "autonomy(goal-beta/task-beta-1): Kick off the next goal";
    results.last_summary_kind = "goal_transition";
    results.last_summary_reason = "The previous goal completed and the next approved goal is active.";
    results.latest_goal_transition = {
      from_goal_id: "goal-alpha",
      to_goal_id: "goal-beta",
      happened_at: "2026-01-07T10:01:00Z",
    };

    await writeControlPlaneFiles(workspace, { goals, tasks, state, blockers, results });

    const report = await runReport(workspace);

    expect(report.previous_goal?.id).toBe("goal-alpha");
    expect(report.current_goal?.id).toBe("goal-beta");
    expect(report.current_task?.id).toBe("task-beta-1");
    expect(report.goal_transition).toBe("completed goal-alpha(Wrap up the first goal) -> active goal-beta(Start the follow-up goal)");
    expect(report.latest_summary_kind).toBe("goal_transition");
    expect(report.latest_summary_reason).toBe("The previous goal completed and the next approved goal is active.");
    expect(report.runtime_warnings.some((warning) => warning.code === "not_a_git_repo")).toBe(true);
    expect(report.next_automation_reason).toContain("Current workspace is not a Git repository");
    expect(report.message).toContain("previous_goal=goal-alpha(Wrap up the first goal)");
    expect(report.message).toContain("goal=goal-beta(Start the follow-up goal)");
    expect(report.message).toContain("goal_transition=completed goal-alpha(Wrap up the first goal) -> active goal-beta(Start the follow-up goal)");
    expect(report.message).toContain("summary_kind=goal_transition");
    expect(report.message).toContain("next_automation_reason=Current workspace is not a Git repository");
    expect(report.message).toContain("commit=def456:autonomy(goal-beta/task-beta-1): Kick off the next goal");
    expect(report.message).toContain("paused=no");
    expect(report.message).toContain("runtime=warning[not_a_git_repo]");
  });

  it("keeps steady-state summaries out of goal_transition even when history already contains completed goals", async () => {
    const goals = clone(readJsonFixture<GoalsDocument>("goals.sample.json"));
    const tasks = clone(readJsonFixture<TasksDocument>("tasks.sample.json"));
    const state = clone(readJsonFixture<AutonomyState>("state.sample.json"));
    const blockers = clone(readJsonFixture<BlockersDocument>("blockers.sample.json"));
    const results = clone(readJsonFixture<AutonomyResults>("results.sample.json"));
    const workspace = await makeTempWorkspace();

    goals.goals = [
      {
        ...goals.goals[0]!,
        id: "goal-old",
        title: "Historical completed goal",
        status: "completed",
        completed_at: "2026-01-07T10:00:00Z",
      },
      {
        ...goals.goals[1]!,
        id: "goal-steady",
        title: "Steady active goal",
        status: "active",
        run_mode: "cruise",
        approved_at: "2026-01-07T10:01:00Z",
      },
    ];
    tasks.tasks = [
      {
        ...tasks.tasks[0]!,
        id: "task-steady-1",
        goal_id: "goal-steady",
        title: "Continue steady work",
        status: "ready",
        priority: "P1",
        updated_at: "2026-01-07T10:02:00Z",
        commit_hash: null,
        review_status: "not_reviewed",
      },
    ];
    state.current_goal_id = "goal-steady";
    state.current_task_id = null;
    state.run_mode = "cruise";
    state.paused = false;
    state.pause_reason = null;
    blockers.blockers = [];
    results.last_summary_kind = "normal_success";
    results.last_summary_reason = "The latest run completed successfully and is waiting for summary handling.";
    results.worker.goal_id = "goal-steady";
    results.worker.task_id = "task-steady-1";
    results.worker.summary = "Steady-state work completed.";

    await writeControlPlaneFiles(workspace, { goals, tasks, state, blockers, results });

    const report = await runReport(workspace);

    expect(report.goal_transition).toBeNull();
    expect(report.latest_summary_kind).toBe("normal_success");
    expect(report.latest_summary_reason).toBe("The latest run completed successfully and is waiting for summary handling.");
    expect(report.message).toContain("goal_transition=none");
  });

  it("treats a missing report_thread_id as a blocking runtime issue when work exists", async () => {
    const goals = clone(readJsonFixture<GoalsDocument>("goals.sample.json"));
    const tasks = clone(readJsonFixture<TasksDocument>("tasks.sample.json"));
    const state = clone(readJsonFixture<AutonomyState>("state.sample.json"));
    const blockers = clone(readJsonFixture<BlockersDocument>("blockers.sample.json"));
    const results = clone(readJsonFixture<AutonomyResults>("results.sample.json"));
    const workspace = await makeTempWorkspace();

    state.report_thread_id = null;
    state.open_blocker_count = 0;
    blockers.blockers = [];

    await writeControlPlaneFiles(workspace, { goals, tasks, state, blockers, results });

    const report = await runReport(workspace);

    expect(report.healthy_runtime).toBe(false);
    expect(report.runtime_warnings.some((warning) => warning.code === "missing_report_thread_id")).toBe(true);
    expect(report.runtime_reason).toContain("Current thread identity is unavailable");
  });

  it("does not reuse previous-goal execution summaries for the current goal", async () => {
    const goals = clone(readJsonFixture<GoalsDocument>("goals.sample.json"));
    const tasks = clone(readJsonFixture<TasksDocument>("tasks.sample.json"));
    const state = clone(readJsonFixture<AutonomyState>("state.sample.json"));
    const blockers = clone(readJsonFixture<BlockersDocument>("blockers.sample.json"));
    const results = clone(readJsonFixture<AutonomyResults>("results.sample.json"));
    const workspace = await makeTempWorkspace();

    goals.goals = [
      {
        ...goals.goals[0]!,
        id: "goal-old",
        title: "Completed historical goal",
        status: "completed",
        completed_at: "2026-01-06T10:00:00Z",
      },
      {
        ...goals.goals[1]!,
        id: "goal-new",
        title: "Current active goal",
        status: "active",
        run_mode: "sprint",
        approved_at: "2026-01-06T10:01:00Z",
      },
    ];
    tasks.tasks = [
      {
        ...tasks.tasks[0]!,
        id: "task-new-1",
        goal_id: "goal-new",
        title: "Plan the next change",
        status: "ready",
        review_status: "not_reviewed",
        commit_hash: null,
      },
    ];
    state.current_goal_id = "goal-new";
    state.current_task_id = null;
    state.run_mode = "sprint";
    blockers.blockers = [];
    results.planner.goal_id = "goal-new";
    results.planner.summary = "Prepared the new ready window.";
    results.worker.goal_id = "goal-old";
    results.worker.task_id = "task-old-1";
    results.worker.verify_summary = "old verify passed";
    results.worker.summary = "Completed an old task.";
    results.review.goal_id = "goal-old";
    results.review.task_id = "task-old-1";
    results.review.summary = "Old review passed.";
    results.commit.goal_id = "goal-old";
    results.commit.task_id = "task-old-1";
    results.commit.hash = "old123";
    results.commit.message = "autonomy(goal-old/task-old-1): Old task";

    await writeControlPlaneFiles(workspace, { goals, tasks, state, blockers, results });

    const report = await runReport(workspace);

    expect(report.current_goal?.id).toBe("goal-new");
    expect(report.latest_verify_summary).toBeNull();
    expect(report.latest_review_summary).toBeNull();
    expect(report.latest_commit_hash).toBeNull();
    expect(report.latest_commit_message).toBeNull();
    expect(report.results_scope_note).toContain("goal-old");
    expect(report.message).toContain("results_scope_note=Latest execution results belong to goal-old, not current goal goal-new.");
  });
});
