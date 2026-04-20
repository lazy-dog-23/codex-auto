import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runBindThreadCommand } from "../src/commands/bind-thread.js";
import { runApproveProposal } from "../src/commands/approve-proposal.js";
import { runCreateSuccessorGoal } from "../src/commands/create-successor-goal.js";
import { runGenerateProposal } from "../src/commands/generate-proposal.js";
import { registerInstallCommand } from "../src/commands/install.js";
import { runPrepareWorktree } from "../src/commands/prepare-worktree.js";
import { runMergeAutonomyBranch } from "../src/commands/merge-autonomy-branch.js";
import { runQuickCommand } from "../src/commands/quick.js";
import { runStatusCommand } from "../src/commands/status.js";
import { runIntakeGoal } from "../src/commands/intake-goal.js";
import { runUnblock } from "../src/commands/unblock.js";
import { registerRebaselineManagedCommand, registerUpgradeManagedCommand } from "../src/commands/upgrade-managed.js";
import { pathExists } from "../src/infra/json.js";
import { inspectAutonomyCommitGate } from "../src/infra/git.js";
import type { BlockersDocument, TasksDocument } from "../src/contracts/autonomy.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tempRoots: string[] = [];
const gitEnvStack: Array<{
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  GIT_CONFIG_GLOBAL: string | undefined;
}> = [];

beforeEach(() => {
  delete process.env.CODEX_THREAD_ID;
});

afterEach(async () => {
  delete process.env.CODEX_THREAD_ID;
  while (gitEnvStack.length > 0) {
    const env = gitEnvStack.pop();
    restoreEnv("HOME", env?.HOME);
    restoreEnv("USERPROFILE", env?.USERPROFILE);
    restoreEnv("GIT_CONFIG_GLOBAL", env?.GIT_CONFIG_GLOBAL);
  }
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

function restoreEnv(name: "HOME" | "USERPROFILE" | "GIT_CONFIG_GLOBAL", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  }).trim();
}

async function prepareGitAutomationWorkspace(workspace: string): Promise<void> {
  const gitHome = await mkdtemp(join(tmpdir(), "codex-git-home-"));
  tempRoots.push(gitHome);
  const gitConfigGlobal = join(gitHome, "gitconfig");
  await mkdir(gitHome, { recursive: true });
  await writeFile(gitConfigGlobal, "", "utf8");
  gitEnvStack.push({
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  });
  process.env.HOME = gitHome;
  process.env.USERPROFILE = gitHome;
  process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

  runGit(workspace, ["init"]);
  runGit(workspace, ["config", "user.name", "Codex Test"]);
  runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
  await runBootstrapCommand(workspace);
  runGit(workspace, ["add", "-A"]);
  runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
  const prepare = await runPrepareWorktree({ workspaceRoot: workspace });
  if (prepare.backgroundPath) {
    tempRoots.push(prepare.backgroundPath);
  }
}

async function seedCompletedOnlySuccessorState(
  workspace: string,
  options: { reportThreadId?: string; allowedLanes?: string[]; sprintActive?: boolean } = {},
): Promise<void> {
  await writeJson(join(workspace, "autonomy", "decision-policy.json"), {
    version: 1,
    auto_continue: {
      docs_only_changes: true,
      approved_goal_followups: true,
      recoverable_closeout_paths: ["autonomy/**", "docs/**", "README.md", "TEAM_GUIDE.md"],
      verification_retry: {
        max_retry_per_task: 1,
        allowed_failure_kinds: ["timeout"],
      },
      auto_successor_goal: {
        enabled: true,
        auto_approve_minimal_successor: true,
        default_run_mode: "sprint",
        max_consecutive_auto_successors: 3,
        max_successor_goals_per_day: 8,
        objective: "Keep improving this repository through small verified slices.",
        success_criteria: ["A bounded successor goal is completed or blocked with evidence"],
        constraints: ["Stay inside the repository"],
        out_of_scope: ["Deployments"],
        allowed_lanes: options.allowedLanes ?? ["documentation", "verification"],
        forbidden_lanes: ["deploy", "release", "secret", "external_service"],
      },
    },
    ask_human: ["proposal_boundary", "scope_change", "dependency_or_env", "security_or_secret", "release_or_git", "external_service", "unknown_context"],
    heartbeat: {
      ready_next_task: "1m",
      recoverable_or_slow_verify: "15m",
      blocked_or_confirmation: "30m_or_pause",
    },
  });
  await writeJson(join(workspace, "autonomy", "goals.json"), {
    version: 1,
    goals: [
      {
        id: "goal-complete",
        title: "Completed Goal",
        objective: "Finish the previous slice",
        success_criteria: ["done"],
        constraints: [],
        out_of_scope: [],
        status: "completed",
        run_mode: "sprint",
        created_at: "2026-04-10T00:00:00Z",
        approved_at: "2026-04-10T00:05:00Z",
        completed_at: "2026-04-10T01:00:00Z",
      },
    ],
  });
  await writeJson(join(workspace, "autonomy", "state.json"), {
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
    report_thread_id: options.reportThreadId ?? "thread-123",
    autonomy_branch: "codex/autonomy",
    sprint_active: options.sprintActive ?? true,
    paused: false,
    pause_reason: null,
  });
}

describe("command integration contracts", () => {
  it("keeps README command examples aligned with the CLI contract", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");

    expect(readme).toContain("codex-autonomy install --target <repo>");
    expect(readme).toContain("codex-autonomy bind-thread --report-thread-id <thread-id>");
    expect(readme).toContain("codex-autonomy scan --target <repo>");
    expect(readme).toContain("codex-autonomy query --target <repo> --json");
    expect(readme).toContain("codex-autonomy approve-proposal --goal-id <goalId>");
    expect(readme).toContain("codex-autonomy create-successor-goal --auto-approve");
    expect(readme).toContain("codex-autonomy rebaseline-managed --target <repo>");
    expect(readme).toContain("pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1");
    expect(readme).toContain("## Developer Fallback");
    expect(readme).toContain("node tools/codex-supervisor/dist/cli.js <command>");
    expect(readme.split("## Developer Fallback")[0]).not.toContain("node tools/codex-supervisor/dist/cli.js");
    expect(readme).not.toContain("codex-autonomy approve-proposal <goal-id>");
  });

  it("keeps the global install helper and package script aligned", async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "tools/codex-supervisor", "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["install:global"]).toBe(
      "pwsh -NoProfile -ExecutionPolicy Bypass -File ../../scripts/install-global.ps1",
    );
    await expect(pathExists(join(repoRoot, "scripts", "install-global.ps1"))).resolves.toBe(true);
  });

  it("registers install, upgrade-managed, and rebaseline-managed exactly once in the shared CLI program", () => {
    const program = new Command();

    expect(() => {
      registerInstallCommand(program);
      registerUpgradeManagedCommand(program);
      registerRebaselineManagedCommand(program);
    }).not.toThrow();
  });

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

  it("doctor warns when config.toml enables unattended full-access execution", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    execFileSync("git", ["init", workspace], { stdio: "pipe" });

    await writeFile(
      join(workspace, ".codex", "config.toml"),
      [
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '',
        '[sandbox_workspace_write]',
        'network_access = true',
        '',
        '[windows]',
        'sandbox = "unelevated"',
        '',
      ].join("\n"),
      "utf8",
    );

    const report = await runDoctor({ workspaceRoot: workspace });

    expect(report.issues.some((issue) => issue.code === "config_toml_high_risk_approval_policy")).toBe(true);
    expect(report.issues.some((issue) => issue.code === "config_toml_high_risk_sandbox_mode")).toBe(true);
  });

  it("doctor accepts complex Codex TOML structures when required fields are present", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeFile(
      join(workspace, ".codex", "config.toml"),
      [
        "# comment before the required keys",
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'model = "gpt-5.4"',
        'model_reasoning_effort = "xhigh"',
        'service_tier = "fast"',
        '',
        '[sandbox_workspace_write]',
        'network_access = true',
        'allowed_hosts = ["localhost", "127.0.0.1"]',
        'limits = { retries = 3, nested = { enabled = true } }',
        '',
        '[windows]',
        'sandbox = "unelevated"',
        '',
        '[extra.section]',
        'enabled = true',
        '',
        '[[plugins]]',
        'name = "alpha"',
        'enabled = true',
        '',
      ].join("\n"),
      "utf8",
    );

    const report = await runDoctor({ workspaceRoot: workspace });

    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.code === "config_toml_invalid")).toBe(false);
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

  it("auto-binds the current thread when intake-goal runs inside a Codex thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    process.env.CODEX_THREAD_ID = "thread-auto-123";

    const result = await runIntakeGoal(
      {
        title: "Upgrade autonomy",
        objective: "Ship the v2 autonomy control plane",
        successCriteria: ["goal exists"],
        runMode: "sprint",
      },
      workspace,
    );
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(stateDoc.report_thread_id).toBe("thread-auto-123");
  });

  it("requires explicit report_thread_id when intake-goal cannot resolve the current thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    delete process.env.CODEX_THREAD_ID;

    await expect(runIntakeGoal(
      {
        title: "Upgrade autonomy",
        objective: "Ship the v2 autonomy control plane",
        successCriteria: ["goal exists"],
        runMode: "sprint",
      },
      workspace,
    )).rejects.toThrow(/Current thread identity is unavailable/i);
  });

  it("bind-thread auto-resolves the current thread id when available", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    process.env.CODEX_THREAD_ID = "thread-auto-bind";

    const result = await runBindThreadCommand({}, workspace);
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8")) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.message).toContain("thread-auto-bind");
    expect(stateDoc.report_thread_id).toBe("thread-auto-bind");
  });

  it("bind-thread updates report_thread_id independently of intake-goal", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const result = await runBindThreadCommand(
      {
        reportThreadId: "thread-456",
      },
      workspace,
    );
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8")) as Record<string, unknown>;
    const journalText = await readFile(join(workspace, "autonomy", "journal.md"), "utf8");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("thread-456");
    expect(stateDoc.report_thread_id).toBe("thread-456");
    expect(journalText).toContain("bind-thread");
    expect(journalText).toContain("thread-456");
  });

  it("blocks intake-goal when the current thread differs from the bound report thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await runBindThreadCommand({ reportThreadId: "thread-bound" }, workspace);
    process.env.CODEX_THREAD_ID = "thread-other";

    await expect(runIntakeGoal(
      {
        title: "Mismatch goal",
        objective: "Do not silently reuse another thread binding",
        successCriteria: ["blocked"],
        runMode: "sprint",
      },
      workspace,
    )).rejects.toThrow(/current thread is thread-other/i);
  });

  it("intake-goal followed by generate-proposal creates a repo-aware fallback proposal and rejects duplicates", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await runIntakeGoal(
      {
        title: "First goal",
        objective: "First objective",
        successCriteria: ["first success"],
        runMode: "cruise",
        reportThreadId: "thread-123",
      },
      workspace,
    );
    const firstGoalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const firstGoalId = firstGoalsDoc.goals[0]?.id as string;

    await runIntakeGoal(
      {
        title: "Second goal",
        objective: "Second objective",
        successCriteria: ["second success"],
        runMode: "sprint",
        reportThreadId: "thread-123",
      },
      workspace,
    );

    const result = await runGenerateProposal({}, workspace);
    const proposalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "proposals.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));
    const journalText = await readFile(join(workspace, "autonomy", "journal.md"), "utf8");

    expect(result.ok).toBe(true);
    expect(proposalsDoc.proposals).toHaveLength(1);
    expect(proposalsDoc.proposals[0]?.goal_id).toBe(firstGoalId);
    expect(proposalsDoc.proposals[0]?.status).toBe("awaiting_confirmation");
    expect((proposalsDoc.proposals[0]?.summary ?? "").toLowerCase()).toContain("repo-aware");
    expect((proposalsDoc.proposals[0]?.tasks.length ?? 0)).toBeGreaterThan(0);
    expect((proposalsDoc.proposals[0]?.tasks.length ?? 0)).toBeLessThanOrEqual(5);
    expect(proposalsDoc.proposals[0]?.tasks.every((task: { acceptance: string[] }) => task.acceptance.length > 0)).toBe(true);
    expect(proposalsDoc.proposals[0]?.tasks.some((task: { file_hints: string[] }) => task.file_hints.length > 0)).toBe(true);
    expect(proposalsDoc.proposals[0]?.tasks.some((task: { file_hints: string[] }) => task.file_hints.includes("AGENTS.md") || task.file_hints.includes("README.md"))).toBe(true);
    expect(tasksDoc.tasks).toHaveLength(0);
    expect(resultsDoc.last_summary_kind).toBe("normal_success");
    expect(resultsDoc.planner.goal_id).toBe(firstGoalId);
    expect(journalText).toContain(`task: ${firstGoalId}`);
    expect(journalText).toContain("generate-proposal");

    await expect(runGenerateProposal({ goalId: firstGoalId }, workspace)).rejects.toThrow(
      /already has an awaiting_confirmation proposal/i,
    );
  });

  it("generate-proposal skips older goals that already have awaiting proposals", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await runIntakeGoal(
      {
        title: "First goal",
        objective: "First objective",
        successCriteria: ["first success"],
        runMode: "cruise",
        reportThreadId: "thread-123",
      },
      workspace,
    );
    await runIntakeGoal(
      {
        title: "Second goal",
        objective: "Second objective",
        successCriteria: ["second success"],
        runMode: "sprint",
        reportThreadId: "thread-123",
      },
      workspace,
    );

    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const firstGoalId = goalsDoc.goals[0]?.id as string;
    const secondGoalId = goalsDoc.goals[1]?.id as string;

    await writeJson(join(workspace, "autonomy", "proposals.json"), {
      version: 1,
      proposals: [
        {
          goal_id: firstGoalId,
          status: "awaiting_confirmation",
          summary: "Existing proposal for first goal.",
          tasks: [
            {
              id: "proposal-first-existing",
              title: "Keep existing first goal proposal",
              priority: "P1",
              depends_on: [],
              acceptance: ["done"],
              file_hints: [],
            },
          ],
          created_at: "2026-04-10T00:10:00Z",
          approved_at: null,
        },
      ],
    });

    const result = await runGenerateProposal({}, workspace);
    const proposalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "proposals.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(proposalsDoc.proposals).toHaveLength(2);
    expect(proposalsDoc.proposals[1]?.goal_id).toBe(secondGoalId);
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
    const slicesDoc = JSON.parse(await readFile(join(workspace, "autonomy", "slices.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(goalsDoc.goals[0]?.status).toBe("active");
    expect(slicesDoc.slices[0]?.goal_id).toBe("goal-approve");
    expect(slicesDoc.slices[0]?.task_ids).toEqual(["task-approve"]);
    expect(tasksDoc.tasks[0]?.goal_id).toBe("goal-approve");
    expect(tasksDoc.tasks[0]?.slice_id).toBe("slice-goal-approve-default");
    expect(stateDoc.current_goal_id).toBe("goal-approve");
    expect(stateDoc.run_mode).toBe("sprint");
    expect(resultsDoc.last_summary_kind).toBe("normal_success");
    expect(resultsDoc.last_summary_reason).toContain("Approved proposal for goal-approve");
  });

  it("quick can preview or track one ready quick task without a proposal", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const preview = await runQuickCommand({
      target: workspace,
      request: "Fix docs typo in README.md",
      validate: true,
    }, workspace);
    const previewTasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    expect(preview.ok).toBe(true);
    expect(preview.tracked).toBe(false);
    expect(previewTasksDoc.tasks).toHaveLength(0);

    await expect(runQuickCommand({
      target: workspace,
      request: "Fix docs typo in README.md",
      validate: true,
      track: true,
    }, workspace)).rejects.toThrow(/requires the current operator thread to be bound/i);

    process.env.CODEX_THREAD_ID = "thread-quick";
    const tracked = await runQuickCommand({
      target: workspace,
      request: "Fix docs typo in README.md",
      validate: true,
      track: true,
    }, workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const slicesDoc = JSON.parse(await readFile(join(workspace, "autonomy", "slices.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));
    const verificationDoc = JSON.parse(await readFile(join(workspace, "autonomy", "verification.json"), "utf8"));

    expect(tracked.ok).toBe(true);
    expect(tracked.tracked).toBe(true);
    expect(goalsDoc.goals[0]?.id).toBe(tracked.goal_id);
    expect(goalsDoc.goals[0]?.status).toBe("active");
    expect(slicesDoc.slices[0]?.id).toBe(tracked.slice_id);
    expect(slicesDoc.slices[0]?.task_ids).toEqual([tracked.task_id]);
    expect(tasksDoc.tasks[0]?.id).toBe(tracked.task_id);
    expect(tasksDoc.tasks[0]?.source).toBe("quick");
    expect(tasksDoc.tasks[0]?.slice_id).toBe(tracked.slice_id);
    expect(tasksDoc.tasks[0]?.file_hints).toEqual(["README.md"]);
    expect(stateDoc.current_goal_id).toBe(tracked.goal_id);
    expect(stateDoc.report_thread_id).toBe("thread-quick");
    expect(stateDoc.sprint_active).toBe(true);
    expect(resultsDoc.planner.task_id).toBe(tracked.task_id);
    expect(verificationDoc.goal_id).toBe(tracked.goal_id);
    expect(verificationDoc.axes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "quick_verify",
        required: true,
        status: "pending",
        source_task_id: tracked.task_id,
      }),
    ]));
  });

  it("quick --track refuses to create active work from a non-bound current thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await runBindThreadCommand({ reportThreadId: "thread-bound" }, workspace);
    process.env.CODEX_THREAD_ID = "thread-other";

    await expect(runQuickCommand({
      target: workspace,
      request: "Fix docs typo in README.md",
      track: true,
    }, workspace)).rejects.toThrow(/thread_binding_state=bound_to_other/i);

    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    expect(goalsDoc.goals).toHaveLength(0);
    expect(tasksDoc.tasks).toHaveLength(0);
  });

  it("quick --track refuses to write while a control-plane operation is pending", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await mkdir(join(workspace, "autonomy", "operations"), { recursive: true });
    await writeJson(join(workspace, "autonomy", "operations", "pending.json"), {
      version: 1,
      id: "op-pending",
      kind: "create_successor_goal",
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      command: "codex-autonomy create-successor-goal",
      auto_approved: false,
      goal_id: "goal-next",
      source_goal_id: "goal-complete",
      task_ids: [],
      expected_paths: ["autonomy/goals.json"],
      payload: {
        goals: {},
        proposals: {},
        state: {},
        results: {},
        active_goal_id: null,
        journal_entry: {},
      },
    });

    await expect(runQuickCommand({
      target: workspace,
      request: "Fix docs typo in README.md",
      track: true,
    }, workspace)).rejects.toThrow(/pending control-plane operation op-pending/i);

    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    expect(tasksDoc.tasks).toHaveLength(0);
  });

  it("quick --track recovers a pending quick operation without creating duplicate active work", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await mkdir(join(workspace, "autonomy", "operations"), { recursive: true });
    process.env.CODEX_THREAD_ID = "thread-quick";
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));
    const quickGoal = {
      id: "goal-quick-recover",
      title: "Quick: Recover pending docs fix",
      objective: "Recover the interrupted quick task.",
      success_criteria: ["done"],
      constraints: ["bounded"],
      out_of_scope: ["deployment"],
      status: "active",
      run_mode: "sprint",
      created_at: "2026-04-10T01:01:00Z",
      approved_at: "2026-04-10T01:01:00Z",
      completed_at: null,
    };
    const quickSlice = {
      id: "slice-goal-quick-recover-quick",
      goal_id: "goal-quick-recover",
      title: "Quick implementation slice",
      objective: "Recover the interrupted quick task.",
      status: "active",
      acceptance: ["done"],
      file_hints: ["README.md"],
      task_ids: ["quick-recover"],
      created_at: "2026-04-10T01:01:00Z",
      updated_at: "2026-04-10T01:01:00Z",
      completed_at: null,
    };
    const quickTask = {
      id: "quick-recover",
      goal_id: "goal-quick-recover",
      slice_id: "slice-goal-quick-recover-quick",
      title: "Recover the interrupted quick task.",
      status: "ready",
      priority: "P1",
      depends_on: [],
      acceptance: ["done"],
      file_hints: ["README.md"],
      retry_count: 0,
      last_error: null,
      updated_at: "2026-04-10T01:01:00Z",
      commit_hash: null,
      review_status: "not_reviewed",
      source: "quick",
      source_task_id: null,
    };

    await writeJson(join(workspace, "autonomy", "operations", "pending.json"), {
      version: 1,
      id: "op-quick-recover",
      kind: "quick",
      created_at: "2026-04-10T01:01:00Z",
      updated_at: "2026-04-10T01:01:00Z",
      command: "codex-autonomy quick",
      auto_approved: true,
      goal_id: "goal-quick-recover",
      source_goal_id: null,
      task_ids: ["quick-recover"],
      expected_paths: ["autonomy/goals.json", "autonomy/tasks.json"],
      payload: {
        goals: { version: 1, goals: [quickGoal] },
        proposals: { version: 1, proposals: [] },
        slices: { version: 1, slices: [quickSlice] },
        tasks: { version: 1, tasks: [quickTask] },
        state: {
          version: 1,
          current_goal_id: "goal-quick-recover",
          current_task_id: null,
          cycle_status: "idle",
          run_mode: "sprint",
          last_planner_run_at: "2026-04-10T01:01:00Z",
          last_worker_run_at: null,
          last_result: "planned",
          consecutive_worker_failures: 0,
          needs_human_review: false,
          open_blocker_count: 0,
          report_thread_id: "thread-quick",
          autonomy_branch: "codex/autonomy",
          sprint_active: true,
          paused: false,
          pause_reason: null,
        },
        verification: {
          version: 1,
          goal_id: "goal-quick-recover",
          policy: "strong_template",
          axes: [
            {
              id: "quick_verify",
              title: "Run repository verification for the quick task",
              required: true,
              status: "pending",
              evidence: [],
              source_task_id: "quick-recover",
              last_checked_at: null,
              reason: "pending quick validation",
            },
          ],
        },
        results: {
          ...resultsDoc,
          last_summary_kind: "normal_success",
          last_summary_reason: "Recovered quick operation op-quick-recover.",
        },
        active_goal_id: "goal-quick-recover",
        journal_entry: {
          timestamp: "2026-04-10T01:01:00Z",
          actor: "supervisor",
          taskId: "quick-recover",
          result: "planned",
          summary: "Recovered quick task",
          verify: "pending",
          blocker: "none",
        },
      },
    });

    const result = await runQuickCommand({
      target: workspace,
      request: "Recover the interrupted quick task.",
      track: true,
    }, workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const journalText = await readFile(join(workspace, "autonomy", "journal.md"), "utf8");

    expect(result.message).toContain("Recovered pending quick operation");
    expect(goalsDoc.goals.filter((goal: { id: string }) => goal.id === "goal-quick-recover")).toHaveLength(1);
    expect(tasksDoc.tasks.filter((task: { id: string }) => task.id === "quick-recover")).toHaveLength(1);
    await expect(pathExists(join(workspace, "autonomy", "operations", "pending.json"))).resolves.toBe(false);
    expect(journalText).toContain("operation op-quick-recover");
  });

  it("create-successor-goal can auto-approve a minimal charter-bound successor", async () => {
    const workspace = await makeTempWorkspace();
    await prepareGitAutomationWorkspace(workspace);
    process.env.CODEX_THREAD_ID = "thread-123";
    await seedCompletedOnlySuccessorState(workspace);

    const result = await runCreateSuccessorGoal({ autoApprove: true }, workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(result.auto_approved).toBe(true);
    expect(goalsDoc.goals).toHaveLength(2);
    expect(goalsDoc.goals[1]?.source).toBe("auto_successor");
    expect(goalsDoc.goals[1]?.source_goal_id).toBe("goal-complete");
    expect(goalsDoc.goals[1]?.status).toBe("active");
    expect(tasksDoc.tasks.length).toBeGreaterThan(0);
    expect(stateDoc.current_goal_id).toBe(goalsDoc.goals[1]?.id);
    expect(stateDoc.sprint_active).toBe(true);
    expect(resultsDoc.last_summary_kind).toBe("goal_transition");
  });

  it("create-successor-goal auto-approve rejects a non-bound current thread", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await seedCompletedOnlySuccessorState(workspace, { reportThreadId: "thread-bound" });
    process.env.CODEX_THREAD_ID = "thread-other";

    await expect(runCreateSuccessorGoal({ autoApprove: true }, workspace)).rejects.toThrow(/thread_binding_state=bound_to_other/i);
  });

  it("create-successor-goal auto-approve rejects when current thread identity is unavailable", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await seedCompletedOnlySuccessorState(workspace, { reportThreadId: "thread-bound" });

    await expect(runCreateSuccessorGoal({ autoApprove: true }, workspace)).rejects.toThrow(/thread_binding_state=bound_without_current_thread/i);
  });

  it("create-successor-goal auto-approve can resume a completed long-running program when the sprint runner is inactive", async () => {
    const workspace = await makeTempWorkspace();
    await prepareGitAutomationWorkspace(workspace);
    await seedCompletedOnlySuccessorState(workspace, { sprintActive: false });
    process.env.CODEX_THREAD_ID = "thread-123";

    const result = await runCreateSuccessorGoal({ autoApprove: true }, workspace);
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));

    expect(result.goal_id).toMatch(/^goal-/);
    expect(stateDoc.current_goal_id).toBe(result.goal_id);
    expect(stateDoc.sprint_active).toBe(true);
  });

  it("status and doctor block while a control-plane operation is pending", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await mkdir(join(workspace, "autonomy", "operations"), { recursive: true });
    await writeJson(join(workspace, "autonomy", "operations", "pending.json"), {
      version: 1,
      id: "op-pending",
      kind: "create_successor_goal",
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      command: "codex-autonomy create-successor-goal",
      auto_approved: true,
      goal_id: "goal-next",
      source_goal_id: "goal-complete",
      task_ids: ["task-next"],
      expected_paths: ["autonomy/goals.json"],
      payload: {
        goals: { version: 1, goals: [] },
        proposals: { version: 1, proposals: [] },
        tasks: { version: 1, tasks: [] },
        state: {
          version: 1,
          current_goal_id: null,
          current_task_id: null,
          cycle_status: "idle",
          run_mode: null,
          last_planner_run_at: null,
          last_worker_run_at: null,
          last_result: "planned",
          consecutive_worker_failures: 0,
          needs_human_review: false,
          open_blocker_count: 0,
          report_thread_id: "thread-123",
          autonomy_branch: "codex/autonomy",
          sprint_active: true,
          paused: false,
          pause_reason: null,
        },
        verification: { version: 1, goal_id: null, policy: "strong_template", axes: [] },
        results: {
          version: 1,
          planner: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, next_step_summary: null, continuation_decision: null, verification_pending_axes: null },
          worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, next_step_summary: null, continuation_decision: null, verification_pending_axes: null },
          review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, next_step_summary: null, continuation_decision: null, verification_pending_axes: null },
          commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, next_step_summary: null, continuation_decision: null, verification_pending_axes: null },
          reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null, next_step_summary: null, continuation_decision: null, verification_pending_axes: null },
          last_thread_summary_sent_at: null,
          last_inbox_run_at: null,
          last_summary_kind: null,
          last_summary_reason: null,
          latest_goal_transition: null,
        },
        active_goal_id: null,
        journal_entry: {
          timestamp: "2026-04-10T00:00:00Z",
          actor: "supervisor",
          taskId: "goal-next",
          result: "planned",
          summary: "pending",
          verify: "not run",
          blocker: "none",
        },
      },
    });

    const status = await runStatusCommand(workspace);
    const doctor = await runDoctor({ workspaceRoot: workspace });

    expect(status.ready_for_automation).toBe(false);
    expect(status.warnings?.some((warning) => warning.code === "pending_control_plane_operation")).toBe(true);
    expect(doctor.ok).toBe(false);
    expect(doctor.issues.some((issue) => issue.code === "pending_control_plane_operation")).toBe(true);
  });

  it("create-successor-goal recovers a pending operation without creating a duplicate goal", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await mkdir(join(workspace, "autonomy", "operations"), { recursive: true });
    process.env.CODEX_THREAD_ID = "thread-bound";
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));
    const completedGoal = {
      id: "goal-complete",
      title: "Completed Goal",
      objective: "Finish the previous slice",
      success_criteria: ["done"],
      constraints: [],
      out_of_scope: [],
      status: "completed",
      run_mode: "sprint",
      created_at: "2026-04-10T00:00:00Z",
      approved_at: "2026-04-10T00:05:00Z",
      completed_at: "2026-04-10T01:00:00Z",
    };
    const successorGoal = {
      id: "goal-next",
      title: "Program successor 1: verification",
      objective: "Continue the authorized charter.",
      success_criteria: ["verified"],
      constraints: ["bounded"],
      out_of_scope: ["Forbidden lane: deploy."],
      status: "active",
      run_mode: "sprint",
      created_at: "2026-04-10T01:01:00Z",
      approved_at: "2026-04-10T01:01:00Z",
      completed_at: null,
      source: "auto_successor",
      source_goal_id: "goal-complete",
    };
    await writeJson(join(workspace, "autonomy", "operations", "pending.json"), {
      version: 1,
      id: "op-recover",
      kind: "create_successor_goal",
      created_at: "2026-04-10T01:01:00Z",
      updated_at: "2026-04-10T01:01:00Z",
      command: "codex-autonomy create-successor-goal",
      auto_approved: true,
      goal_id: "goal-next",
      source_goal_id: "goal-complete",
      task_ids: ["task-next"],
      expected_paths: ["autonomy/goals.json", "autonomy/tasks.json"],
      payload: {
        goals: { version: 1, goals: [completedGoal, successorGoal] },
        proposals: {
          version: 1,
          proposals: [
            {
              goal_id: "goal-next",
              status: "approved",
              summary: "Recovered proposal",
              tasks: [
                {
                  id: "task-next",
                  title: "Recovered task",
                  priority: "P1",
                  depends_on: [],
                  acceptance: ["done"],
                  file_hints: ["README.md"],
                },
              ],
              created_at: "2026-04-10T01:01:00Z",
              approved_at: "2026-04-10T01:01:00Z",
            },
          ],
        },
        tasks: {
          version: 1,
          tasks: [
            {
              id: "task-next",
              goal_id: "goal-next",
              title: "Recovered task",
              status: "ready",
              priority: "P1",
              depends_on: [],
              acceptance: ["done"],
              file_hints: ["README.md"],
              retry_count: 0,
              last_error: null,
              updated_at: "2026-04-10T01:01:00Z",
              commit_hash: null,
              review_status: "not_reviewed",
              source: "proposal",
              source_task_id: null,
            },
          ],
        },
        state: {
          version: 1,
          current_goal_id: "goal-next",
          current_task_id: null,
          cycle_status: "idle",
          run_mode: "sprint",
          last_planner_run_at: "2026-04-10T01:01:00Z",
          last_worker_run_at: null,
          last_result: "planned",
          consecutive_worker_failures: 0,
          needs_human_review: false,
          open_blocker_count: 0,
          report_thread_id: "thread-bound",
          autonomy_branch: "codex/autonomy",
          sprint_active: true,
          paused: false,
          pause_reason: null,
        },
        verification: { version: 1, goal_id: "goal-next", policy: "strong_template", axes: [] },
        results: {
          ...resultsDoc,
          last_summary_kind: "goal_transition",
          last_summary_reason: "Recovered successor operation op-recover.",
        },
        active_goal_id: "goal-next",
        journal_entry: {
          timestamp: "2026-04-10T01:01:00Z",
          actor: "supervisor",
          taskId: "goal-next",
          result: "planned",
          summary: "Recovered successor goal",
          verify: "not run",
          blocker: "none",
        },
      },
    });

    const result = await runCreateSuccessorGoal({ autoApprove: true }, workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const journalText = await readFile(join(workspace, "autonomy", "journal.md"), "utf8");

    expect(result.message).toContain("Recovered pending");
    expect(goalsDoc.goals.filter((goal: { id: string }) => goal.id === "goal-next")).toHaveLength(1);
    expect(stateDoc.current_goal_id).toBe("goal-next");
    await expect(pathExists(join(workspace, "autonomy", "operations", "pending.json"))).resolves.toBe(false);
    expect(journalText).toContain("operation op-recover");
  });

  it("create-successor-goal refuses to recover stale pending operations after report_thread_id changes", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await mkdir(join(workspace, "autonomy", "operations"), { recursive: true });
    process.env.CODEX_THREAD_ID = "thread-new";
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));
    await writeJson(join(workspace, "autonomy", "state.json"), {
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
      report_thread_id: "thread-new",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
      paused: false,
      pause_reason: null,
    });
    await writeJson(join(workspace, "autonomy", "operations", "pending.json"), {
      version: 1,
      id: "op-stale",
      kind: "create_successor_goal",
      created_at: "2026-04-10T01:01:00Z",
      updated_at: "2026-04-10T01:01:00Z",
      command: "codex-autonomy create-successor-goal",
      auto_approved: true,
      goal_id: "goal-next",
      source_goal_id: "goal-complete",
      task_ids: ["task-next"],
      expected_paths: ["autonomy/state.json"],
      payload: {
        goals: { version: 1, goals: [] },
        proposals: { version: 1, proposals: [] },
        tasks: { version: 1, tasks: [] },
        state: {
          version: 1,
          current_goal_id: "goal-next",
          current_task_id: null,
          cycle_status: "idle",
          run_mode: "sprint",
          last_planner_run_at: "2026-04-10T01:01:00Z",
          last_worker_run_at: null,
          last_result: "planned",
          consecutive_worker_failures: 0,
          needs_human_review: false,
          open_blocker_count: 0,
          report_thread_id: "thread-old",
          autonomy_branch: "codex/autonomy",
          sprint_active: true,
          paused: false,
          pause_reason: null,
        },
        verification: { version: 1, goal_id: null, policy: "strong_template", axes: [] },
        results: resultsDoc,
        active_goal_id: "goal-next",
        journal_entry: {
          timestamp: "2026-04-10T01:01:00Z",
          actor: "supervisor",
          taskId: "goal-next",
          result: "planned",
          summary: "recover stale",
          verify: "not run",
          blocker: "none",
        },
      },
    });

    await expect(runCreateSuccessorGoal({ autoApprove: true }, workspace)).rejects.toThrow(/report_thread_id changed/i);
  });

  it("create-successor-goal chooses a safe verification lane over forbidden lanes", async () => {
    const workspace = await makeTempWorkspace();
    await prepareGitAutomationWorkspace(workspace);
    process.env.CODEX_THREAD_ID = "thread-123";
    await seedCompletedOnlySuccessorState(workspace, { allowedLanes: ["deploy", "verification"] });
    await writeJson(join(workspace, "autonomy", "verification.json"), {
      version: 1,
      goal_id: null,
      policy: "strong_template",
      axes: [
        {
          id: "manual-evidence",
          title: "Manual evidence",
          required: true,
          status: "pending",
          evidence: [],
          source_task_id: null,
          last_checked_at: null,
          reason: "Needs successor verification evidence",
        },
      ],
    });

    const result = await runCreateSuccessorGoal({ autoApprove: true }, workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const successorGoal = goalsDoc.goals.find((goal: { id: string }) => goal.id === result.goal_id);

    expect(successorGoal?.title).toContain("verification");
    expect(successorGoal?.title).not.toContain("deploy");
    expect(successorGoal?.objective).toContain("Lane rationale");
  });

  it("create-successor-goal rejects successor policy with no safe allowed lane", async () => {
    const workspace = await makeTempWorkspace();
    await prepareGitAutomationWorkspace(workspace);
    process.env.CODEX_THREAD_ID = "thread-123";
    await seedCompletedOnlySuccessorState(workspace, { allowedLanes: ["deploy", "release"] });

    await expect(runCreateSuccessorGoal({ autoApprove: true }, workspace)).rejects.toThrow(/at least one allowed lane/i);
  });

  it("approve-proposal records a goal transition when the previous active goal completes", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await writeJson(join(workspace, "autonomy", "tasks.json"), {
      version: 1,
      tasks: [
        {
          id: "task-alpha-done",
          goal_id: "goal-alpha",
          title: "Finish alpha",
          status: "done",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/alpha.ts"],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-04-10T00:00:00Z",
          commit_hash: null,
          review_status: "passed",
        },
      ],
    } satisfies TasksDocument);
    await writeJson(join(workspace, "autonomy", "goals.json"), {
      version: 1,
      goals: [
        {
          id: "goal-alpha",
          title: "Alpha Goal",
          objective: "Finish alpha work",
          success_criteria: ["alpha done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "cruise",
          created_at: "2026-04-09T00:00:00Z",
          approved_at: "2026-04-09T00:10:00Z",
          completed_at: null,
        },
        {
          id: "goal-beta",
          title: "Beta Goal",
          objective: "Start beta work",
          success_criteria: ["beta planned"],
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
          goal_id: "goal-beta",
          status: "awaiting_confirmation",
          summary: "Start beta with one task.",
          tasks: [
            {
              id: "task-beta-1",
              title: "Implement beta task",
              priority: "P1",
              depends_on: [],
              acceptance: ["done"],
              file_hints: ["src/beta.ts"],
            },
          ],
          created_at: "2026-04-10T00:10:00Z",
          approved_at: null,
        },
      ],
    });
    await writeJson(join(workspace, "autonomy", "state.json"), {
      version: 1,
      current_goal_id: "goal-alpha",
      current_task_id: null,
      cycle_status: "idle",
      run_mode: "cruise",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "noop",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: "thread-123",
      autonomy_branch: "codex/autonomy",
      sprint_active: false,
      paused: false,
      pause_reason: null,
      last_thread_summary_sent_at: null,
      last_inbox_run_at: null,
    });

    const result = await runApproveProposal("goal-beta", workspace);
    const goalsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8"));
    const stateDoc = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8"));
    const resultsDoc = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8"));

    expect(result.ok).toBe(true);
    expect(goalsDoc.goals.find((goal: { id: string }) => goal.id === "goal-alpha")?.status).toBe("completed");
    expect(goalsDoc.goals.find((goal: { id: string }) => goal.id === "goal-beta")?.status).toBe("active");
    expect(stateDoc.current_goal_id).toBe("goal-beta");
    expect(stateDoc.run_mode).toBe("sprint");
    expect(resultsDoc.last_summary_kind).toBe("goal_transition");
    expect(resultsDoc.last_summary_reason).toContain("next approved goal is active");
    expect(resultsDoc.latest_goal_transition).toEqual({
      from_goal_id: "goal-alpha",
      to_goal_id: "goal-beta",
      happened_at: expect.any(String),
    });
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
