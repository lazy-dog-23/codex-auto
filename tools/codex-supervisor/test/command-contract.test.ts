import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runApproveProposal } from "../src/commands/approve-proposal.js";
import { runPrepareWorktree } from "../src/commands/prepare-worktree.js";
import { runMergeAutonomyBranch } from "../src/commands/merge-autonomy-branch.js";
import { runStatusCommand } from "../src/commands/status.js";
import { runIntakeGoal } from "../src/commands/intake-goal.js";
import { runUnblock } from "../src/commands/unblock.js";
import { pathExists } from "../src/infra/json.js";
import { inspectAutonomyCommitGate } from "../src/infra/git.js";
import type { BlockersDocument, TasksDocument } from "../src/contracts/autonomy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("command integration contracts", () => {
  it("bootstrap creates the repo control surface and warns in a non-git workspace", async () => {
    const workspace = await makeTempWorkspace();

    const result = await runBootstrapCommand(workspace);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("not a Git repository");
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).resolves.toContain("Repo Control Surface");
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toContain("codex-autonomy");
    await expect(readFile(join(workspace, ".codex", "config.toml"), "utf8")).resolves.toContain(
      'sandbox_mode = "workspace-write"',
    );
    await expect(readFile(join(workspace, ".codex", "config.toml"), "utf8")).resolves.toContain(
      'model = "gpt-5.4"',
    );
    await expect(readFile(join(workspace, ".codex", "config.toml"), "utf8")).resolves.toContain(
      'model_reasoning_effort = "xhigh"',
    );
    await expect(readFile(join(workspace, ".codex", "config.toml"), "utf8")).resolves.toContain(
      'service_tier = "fast"',
    );
    await expect(readFile(join(workspace, "autonomy", "schema", "tasks.schema.json"), "utf8")).resolves.toContain(
      '"queued"',
    );
    expect(await pathExists(join(workspace, "autonomy", "locks", "cycle.lock"))).toBe(false);
  });

  it("doctor reports schema errors before any write path runs", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeFile(join(workspace, "autonomy", "tasks.json"), "{ invalid json }\n", "utf8");

    const report = await runDoctor({ workspaceRoot: workspace });

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "tasks_schema_invalid")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "not_a_git_repo")).toBe(true);
  });

  it("doctor reports invalid repo-scoped Codex config", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeFile(join(workspace, ".codex", "config.toml"), "[windows]\nsandbox = true\n", "utf8");

    const report = await runDoctor({ workspaceRoot: workspace });

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "config_toml_invalid")).toBe(true);
  });

  it("status blocks automation when the workspace is not a git repo", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeJson(join(workspace, "autonomy", "tasks.json"), {
      version: 1,
      tasks: [
        {
          id: "task-ready",
          goal_id: "goal-ready",
          title: "Ready task",
          status: "ready",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/example.ts"],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-04-12T00:00:00Z",
          commit_hash: null,
          review_status: "not_reviewed",
        },
      ],
    } satisfies TasksDocument);
    await writeJson(join(workspace, "autonomy", "goals.json"), {
      version: 1,
      goals: [
        {
          id: "goal-ready",
          title: "Ready Goal",
          objective: "Ship ready task",
          success_criteria: ["done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "cruise",
          created_at: "2026-04-11T00:00:00Z",
          approved_at: "2026-04-11T00:10:00Z",
          completed_at: null,
        },
      ],
    });
    await writeJson(join(workspace, "autonomy", "results.json"), {
      version: 1,
      planner: { status: "planned", goal_id: "goal-ready", task_id: null, summary: "planned", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
    });
    await writeJson(join(workspace, "autonomy", "state.json"), {
      version: 1,
      current_goal_id: "goal-ready",
      current_task_id: null,
      cycle_status: "idle",
      run_mode: "cruise",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "planned",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: null,
      autonomy_branch: "codex/autonomy",
      sprint_active: false,
      paused: false,
      pause_reason: null,
    });

    const summary = await runStatusCommand(workspace);

    expect(summary.ready_for_automation).toBe(false);
    expect(summary.warnings?.some((warning) => warning.code === "not_a_git_repo")).toBe(true);
  });

  it("intake-goal creates an awaiting_confirmation goal and preserves the report thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const result = await runIntakeGoal(
      {
        title: "Upgrade autonomy",
        objective: "Ship the v2 autonomy control plane",
        successCriteria: ["goal exists"],
        runMode: "sprint",
        reportThreadId: "thread-123",
      },
      workspace,
    );

    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(goalsDoc.goals).toHaveLength(1);
    expect(goalsDoc.goals[0]?.status).toBe("awaiting_confirmation");
    expect(goalsDoc.goals[0]?.run_mode).toBe("sprint");
    expect(stateDoc.report_thread_id).toBe("thread-123");
  });

  it("approve-proposal materializes tasks and activates the goal", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await writeJson(join(workspace, "autonomy", "goals.json"), {
      version: 1,
      goals: [
        {
          id: "goal-approve",
          title: "Approved Goal",
          objective: "Activate and materialize tasks",
          success_criteria: ["tasks materialized"],
          constraints: [],
          out_of_scope: [],
          status: "awaiting_confirmation",
          run_mode: "sprint",
          created_at: "2026-04-10T00:00:00Z",
          approved_at: null,
          completed_at: null,
        },
      ],
    });
    await writeJson(join(workspace, "autonomy", "proposals.json"), {
      version: 1,
      proposals: [
        {
          goal_id: "goal-approve",
          status: "awaiting_confirmation",
          summary: "Create one task.",
          tasks: [
            {
              id: "task-approve",
              title: "Implement approval flow",
              priority: "P1",
              depends_on: [],
              acceptance: ["done"],
              file_hints: ["src/commands/approve-proposal.ts"],
            },
          ],
          created_at: "2026-04-10T00:10:00Z",
          approved_at: null,
        },
      ],
    });

    const result = await runApproveProposal("goal-approve", workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(goalsDoc.goals[0]?.status).toBe("active");
    expect(tasksDoc.tasks[0]?.goal_id).toBe("goal-approve");
    expect(stateDoc.current_goal_id).toBe("goal-approve");
    expect(stateDoc.run_mode).toBe("sprint");
  });

  it("merge-autonomy-branch fast-forwards a reviewed autonomy branch into the current branch", async () => {
    const workspace = await makeTempWorkspace();
    execFileSync("git", ["init", workspace], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "config", "user.name", "Codex Test"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "config", "user.email", "codex-test@example.com"], { stdio: "pipe" });
    await runBootstrapCommand(workspace);
    execFileSync("git", ["-C", workspace, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "commit", "-m", "bootstrap"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "branch", "-M", "main"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "switch", "-c", "codex/autonomy"], { stdio: "pipe" });
    await writeFile(join(workspace, "README.md"), "# changed\n", "utf8");
    await writeJson(join(workspace, "autonomy", "results.json"), {
      version: 1,
      planner: { status: "planned", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      worker: { status: "passed", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      review: { status: "passed", goal_id: null, task_id: null, summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
      commit: { status: "passed", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: "autonomy update", review_status: null },
      reporter: { status: "sent", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
    });
    execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "add", "autonomy/results.json"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspace, "commit", "-m", "autonomy update"], { stdio: "pipe" });
    const autonomyHead = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", workspace, "switch", "main"], { stdio: "pipe" });

    const result = await runMergeAutonomyBranch(workspace);
    const mergedHead = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    expect(result.ok).toBe(true);
    expect(mergedHead).toBe(autonomyHead);
  });

  it("commit gate reports not_a_git_repo for non-git workspaces", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const gate = await inspectAutonomyCommitGate(workspace);

    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("not_a_git_repo");
    expect(gate.hasDiff).toBe(false);
    expect(gate.branchDrift).toBe(true);
  });

  it("prepare-worktree refuses non-git workspaces", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a Git repository");
  });

  it("bootstrap rejects redirected autonomy directories", async () => {
    const workspace = await makeTempWorkspace();
    const redirectedTarget = await makeTempWorkspace();

    await symlink(redirectedTarget, join(workspace, "autonomy"), "junction");

    await expect(runBootstrapCommand(workspace)).rejects.toThrow(/redirected|symbolic link|junction/i);
  });

  it("bootstrap rejects dangling redirected autonomy directories", async () => {
    const workspace = await makeTempWorkspace();
    const redirectedRoot = await makeTempWorkspace();
    const missingRedirectTarget = join(redirectedRoot, "missing-autonomy-target");

    await symlink(missingRedirectTarget, join(workspace, "autonomy"), "junction");

    await expect(runBootstrapCommand(workspace)).rejects.toThrow(/redirected|symbolic link|junction/i);
  });

  it("unblock resolves blockers and restores the task into ready when capacity allows", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeJson(join(workspace, "autonomy", "tasks.json"), {
      version: 1,
      tasks: [
        {
          id: "task-blocked",
          goal_id: "goal-blocked",
          title: "Blocked task",
          status: "blocked",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/task.ts"],
          retry_count: 1,
          last_error: "needs input",
          updated_at: "2026-04-10T00:00:00Z",
          commit_hash: null,
          review_status: "not_reviewed",
        },
      ],
    } satisfies TasksDocument);
    await writeJson(join(workspace, "autonomy", "goals.json"), {
      version: 1,
      goals: [
        {
          id: "goal-blocked",
          title: "Blocked Goal",
          objective: "Unblock task",
          success_criteria: ["done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "cruise",
          created_at: "2026-04-09T00:00:00Z",
          approved_at: "2026-04-09T00:10:00Z",
          completed_at: null,
        },
      ],
    });
    await writeJson(join(workspace, "autonomy", "blockers.json"), {
      version: 1,
      blockers: [
        {
          id: "blocker-1",
          task_id: "task-blocked",
          question: "Need a decision",
          severity: "medium",
          status: "open",
          resolution: null,
          opened_at: "2026-04-10T00:00:00Z",
          resolved_at: null,
        },
      ],
    } satisfies BlockersDocument);
    await writeJson(join(workspace, "autonomy", "state.json"), {
      version: 1,
      current_goal_id: "goal-blocked",
      current_task_id: null,
      cycle_status: "blocked",
      run_mode: "cruise",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "blocked",
      consecutive_worker_failures: 1,
      needs_human_review: true,
      open_blocker_count: 1,
      report_thread_id: null,
      autonomy_branch: "codex/autonomy",
      sprint_active: false,
      paused: false,
      pause_reason: null,
    });

    const result = await runUnblock("task-blocked", workspace);
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8")) as TasksDocument;
    const blockersDoc = JSON.parse(
      await readFile(join(workspace, "autonomy", "blockers.json"), "utf8"),
    ) as BlockersDocument;
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const journalText = await readFile(join(workspace, "autonomy", "journal.md"), "utf8");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("task-blocked");
    expect(tasksDoc.tasks[0]?.status).toBe("ready");
    expect(tasksDoc.tasks[0]?.last_error).toBeNull();
    expect(blockersDoc.blockers[0]?.status).toBe("resolved");
    expect(blockersDoc.blockers[0]?.resolution).toContain("codex-supervisor unblock");
    expect(stateDoc.open_blocker_count).toBe(0);
    expect(stateDoc.cycle_status).toBe("idle");
    expect(stateDoc.last_result).toBe("planned");
    expect(stateDoc.needs_human_review).toBe(false);
    expect(journalText).toContain("task-blocked");
    expect(journalText).toContain("result: planned");
  });
});
