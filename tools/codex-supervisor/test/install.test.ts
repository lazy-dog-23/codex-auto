import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runInstallCommand } from "../src/commands/install.js";
import { getLegacyReviewScriptTemplates } from "../src/scaffold/templates.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

async function makeTempGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-autonomy-install-"));
  tempRoots.push(root);
  execFileSync("git", ["init", root], { stdio: "pipe" });
  return root;
}

describe("install scaffold", () => {
  it("exposes the codex-autonomy entrypoint with a codex-supervisor alias", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "tools", "codex-supervisor", "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };

    expect(packageJson.name).toBe("codex-autonomy");
    expect(packageJson.bin["codex-autonomy"]).toBe("dist/cli.js");
    expect(packageJson.bin["codex-supervisor"]).toBe("dist/cli.js");
  });

  it("installs the repo control surface into the target repository without overwriting existing files", async () => {
    const workspace = await makeTempGitRepo();
    const existingAgents = "# existing sentinel\n";
    await writeFile(join(workspace, "AGENTS.md"), existingAgents, "utf8");

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Environment prerequisites are ready");
    expect(result.summary.target_path).toBe(workspace);
    expect(result.summary.is_git_repo).toBe(true);
    expect(result.summary.automation_ready).toBe(true);
    expect(result.summary.codex_process_detected).toBe(true);
    expect(result.summary.background_worktree_prereqs).toBe(true);
    expect(result.summary.warning).toContain("Bind report_thread_id");
    expect(result.summary.control_surface_files_created).toBeGreaterThan(0);
    expect(result.summary.install_metadata_path).toBe(join(workspace, "autonomy", "install.json"));
    expect(result.summary.install_metadata_written).toBe(true);
    expect(result.summary.preflight.checked_paths).toBeGreaterThan(0);
    expect(result.summary.preflight.managed_diverged_paths).toContain(join(workspace, "AGENTS.md"));
    expect(result.summary.preflight.foreign_occupied_paths).toHaveLength(0);
    expect(result.summary.private_automation_storage_untouched).toBe(true);
    expect(result.summary.next_automations.map((item) => item.name)).toContain("planner-cruise");
    expect(result.summary.next_automations.map((item) => item.name)).toContain("worker-cruise");
    expect(result.summary.next_automations.map((item) => item.name)).toContain("reviewer-cruise");
    expect(result.summary.next_automations.map((item) => item.name)).toContain("reporter");
    expect(result.summary.next_automations.map((item) => item.name)).not.toContain("sprint-runner");
    expect(result.summary.next_automations.find((item) => item.name === "reporter")?.purpose).toContain("sprint heartbeat loop");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(existingAgents);
    expect(await readFile(join(workspace, ".codex", "environments", "environment.toml"), "utf8")).toContain(
      'name = "review"',
    );
    expect(await readFile(join(workspace, "scripts", "review.ps1"), "utf8")).toContain("Review checks passed.");
    expect(await readFile(join(workspace, "scripts", "review.ps1"), "utf8")).toContain("review.local.ps1");
    expect(await readFile(join(workspace, "scripts", "verify.ps1"), "utf8")).toContain("Install verify passed.");
    expect(await readFile(join(workspace, ".agents", "skills", "$autonomy-intake", "SKILL.md"), "utf8")).toContain(
      "autonomy-intake",
    );
    expect(await readFile(join(workspace, ".agents", "skills", "$autonomy-report", "SKILL.md"), "utf8")).toContain(
      "heartbeat summary",
    );
    expect(await readFile(join(workspace, ".agents", "skills", "$autonomy-sprint", "SKILL.md"), "utf8")).toContain(
      "wake-up interval",
    );
    expect(await readFile(join(workspace, "autonomy", "goal.md"), "utf8")).toContain("No active goal.");
    expect(await readFile(join(workspace, "autonomy", "journal.md"), "utf8")).toContain("Append one entry per run");
    expect(await readFile(join(workspace, "autonomy", "install.json"), "utf8")).toContain('"product_version": "0.1.0"');
    expect(await readFile(join(workspace, "autonomy", "install.json"), "utf8")).toContain('"source_repo": "."');
    expect(await readFile(join(workspace, "autonomy", "install.json"), "utf8")).toContain('"managed_paths"');
    expect(await readFile(join(workspace, "autonomy", "goals.json"), "utf8")).toContain('"goals"');
    expect(await readFile(join(workspace, "autonomy", "settings.json"), "utf8")).toContain('"autonomy_branch"');
    expect(await readFile(join(workspace, "autonomy", "schema", "results.schema.json"), "utf8")).toContain('"reporter"');
    expect(await readFile(join(workspace, ".codex", "config.toml"), "utf8")).toContain('service_tier = "fast"');
    expect(await readFile(join(workspace, ".codex", "config.toml"), "utf8")).toContain('model_reasoning_effort = "xhigh"');
    expect(await readFile(join(workspace, ".codex", "config.toml"), "utf8")).toContain('model = "gpt-5.4"');
  });

  it("marks a non-Git target as not ready while still installing the scaffold", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-autonomy-install-nongit-"));
    tempRoots.push(workspace);

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => null,
        detectCodexProcess: async () => false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary.target_path).toBe(workspace);
    expect(result.summary.is_git_repo).toBe(false);
    expect(result.summary.automation_ready).toBe(false);
    expect(result.summary.codex_process_detected).toBe(false);
    expect(result.summary.background_worktree_prereqs).toBe(false);
    expect(result.summary.warning).toContain("not a Git repository");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "non_git_repo" }),
        expect.objectContaining({ code: "not_automation_ready" }),
        expect.objectContaining({ code: "codex_process_not_detected" }),
        expect.objectContaining({ code: "background_worktree_not_ready" }),
      ]),
    );
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toContain("# Repo Control Surface");
    expect(await readFile(join(workspace, "autonomy", "goal.md"), "utf8")).toContain("No active goal.");
  });

  it("migrates legacy control-plane documents to the latest contract", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "autonomy"), { recursive: true });
    await writeFile(
      join(workspace, "autonomy", "tasks.json"),
      `${JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "legacy-task-1",
            title: "Imported task without goal metadata",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: ["still passes verify"],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "goals.json"),
      `${JSON.stringify({
        version: 1,
        goals: [
          {
            id: "goal-legacy",
            title: "Legacy goal",
            objective: "Keep legacy goal running",
            success_criteria: ["verify passes"],
            constraints: [],
            out_of_scope: [],
            status: "active",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "proposals.json"),
      `${JSON.stringify({
        version: 1,
        proposals: [
          {
            summary: "Legacy proposal",
            tasks: [
              {
                title: "Imported follow-up task",
              },
            ],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "state.json"),
      `${JSON.stringify({
        version: 1,
        current_goal_id: "goal-legacy",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "cruise",
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
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "settings.json"),
      `${JSON.stringify({
        version: 1,
        install_source: "local_package",
        initial_confirmation_required: true,
        report_surface: "thread_and_inbox",
        auto_commit: "autonomy_branch",
        autonomy_branch: "codex/autonomy",
        default_cruise_cadence: {
          planner_hours: 6,
          worker_hours: 2,
          reviewer_hours: 6,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "results.json"),
      `${JSON.stringify({
        version: 1,
        planner: { status: "not_run", goal_id: null, task_id: null, summary: null },
        worker: { status: "not_run", goal_id: null, task_id: null, summary: null },
        review: { status: "not_run", goal_id: null, task_id: null, summary: null },
        commit: { status: "not_run", goal_id: null, task_id: null, summary: null },
        reporter: { status: "not_run", goal_id: null, task_id: null, summary: null },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "blockers.json"),
      `${JSON.stringify({
        version: 1,
        blockers: [
          {
            id: "legacy-blocker-1",
            task_id: "legacy-task-1",
            question: "Legacy blocker",
            severity: "medium",
            status: "open",
            opened_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "control_plane_migrated" }),
      ]),
    );

    const state = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8")) as Record<string, unknown>;
    const settings = JSON.parse(await readFile(join(workspace, "autonomy", "settings.json"), "utf8")) as Record<string, unknown>;
    const results = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8")) as Record<string, unknown>;
    const tasks = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
    const goals = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8")) as { goals: Array<Record<string, unknown>> };
    const proposals = JSON.parse(await readFile(join(workspace, "autonomy", "proposals.json"), "utf8")) as { proposals: Array<Record<string, unknown>> };
    const blockers = JSON.parse(await readFile(join(workspace, "autonomy", "blockers.json"), "utf8")) as { blockers: Array<Record<string, unknown>> };

    expect(state.last_thread_summary_sent_at).toBeNull();
    expect(state.last_inbox_run_at).toBeNull();
    expect(settings.default_sprint_heartbeat_minutes).toBe(15);
    expect(results.last_thread_summary_sent_at).toBeNull();
    expect(results.last_inbox_run_at).toBeNull();
    expect(results.last_summary_kind).toBeNull();
    expect(results.last_summary_reason).toBeNull();
    expect((results.reporter as Record<string, unknown>).sent_at).toBeNull();
    expect((results.worker as Record<string, unknown>).verify_summary).toBeNull();
    expect(tasks.tasks[0]?.goal_id).toBe("goal-legacy");
    expect(tasks.tasks[0]?.commit_hash).toBeNull();
    expect(tasks.tasks[0]?.review_status).toBe("not_reviewed");
    expect(goals.goals[0]?.run_mode).toBe("cruise");
    expect(goals.goals[0]?.approved_at).toBe("2026-01-01T00:00:00Z");
    expect(goals.goals[0]?.completed_at).toBeNull();
    expect(await readFile(join(workspace, "autonomy", "goal.md"), "utf8")).toContain("Keep legacy goal running");
    expect(proposals.proposals[0]?.goal_id).toBe("goal-legacy");
    expect(proposals.proposals[0]?.status).toBe("awaiting_confirmation");
    expect(((proposals.proposals[0]?.tasks as Array<Record<string, unknown>>)[0])?.id).toBe("proposal-task-1");
    expect(blockers.blockers[0]?.resolution).toBeNull();
    expect(blockers.blockers[0]?.resolved_at).toBeNull();
  });

  it("blocks synthesized placeholder goals instead of treating them as approved work", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "autonomy"), { recursive: true });
    await writeFile(
      join(workspace, "autonomy", "tasks.json"),
      `${JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "legacy-task-missing-goal",
            goal_id: "goal-missing",
            title: "Imported task with missing goal",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: ["still passes verify"],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "goals.json"),
      `${JSON.stringify({
        version: 1,
        goals: [],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(workspace, "autonomy", "state.json"),
      `${JSON.stringify({
        version: 1,
        current_goal_id: "goal-missing",
        current_task_id: null,
        cycle_status: "idle",
        run_mode: "sprint",
        last_planner_run_at: null,
        last_worker_run_at: null,
        last_result: "noop",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
        report_thread_id: "thread-123",
        autonomy_branch: "codex/autonomy",
        sprint_active: true,
        paused: false,
        pause_reason: null,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    const goals = JSON.parse(await readFile(join(workspace, "autonomy", "goals.json"), "utf8")) as { goals: Array<Record<string, unknown>> };
    const state = JSON.parse(await readFile(join(workspace, "autonomy", "state.json"), "utf8")) as Record<string, unknown>;
    const tasks = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
    const blockers = JSON.parse(await readFile(join(workspace, "autonomy", "blockers.json"), "utf8")) as { blockers: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "placeholder_goals_blocked" }),
      ]),
    );
    expect(goals.goals[0]?.id).toBe("goal-missing");
    expect(goals.goals[0]?.status).toBe("blocked");
    expect(goals.goals[0]?.approved_at).toBeNull();
    expect(state.current_goal_id).toBeNull();
    expect(state.cycle_status).toBe("blocked");
    expect(state.last_result).toBe("blocked");
    expect(state.needs_human_review).toBe(true);
    expect(state.sprint_active).toBe(false);
    expect(state.open_blocker_count).toBeGreaterThan(0);
    expect(tasks.tasks[0]?.status).toBe("blocked");
    expect(tasks.tasks[0]?.last_error).toBe("Referenced goal goal-missing is missing from goals.json and requires human review.");
    expect(blockers.blockers[0]?.task_id).toBe("legacy-task-missing-goal");
    expect(blockers.blockers[0]?.question).toContain("goal-missing");
  });

  it("migrates the legacy generated review script without overwriting user-owned files", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "scripts"), { recursive: true });
    await writeFile(join(workspace, "scripts", "review.ps1"), getLegacyReviewScriptTemplates()[0], "utf8");
    await writeFile(join(workspace, "AGENTS.md"), "# user owned\n", "utf8");

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "control_plane_migrated" }),
      ]),
    );
    expect(await readFile(join(workspace, "scripts", "review.ps1"), "utf8")).toContain("Review checks passed.");
    expect(await readFile(join(workspace, "scripts", "review.ps1"), "utf8")).toContain("review.local.ps1");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("# user owned\n");
  });

  it("classifies a diverged install.json as managed_diverged and does not overwrite it", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "autonomy"), { recursive: true });
    const divergedInstallMetadata = {
      version: 1,
      product_version: "0.1.0",
      installed_at: "2026-01-01T00:00:00Z",
      source_repo: "custom/source",
      managed_paths: ["AGENTS.md"],
    };
    await writeFile(
      join(workspace, "autonomy", "install.json"),
      `${JSON.stringify(divergedInstallMetadata, null, 2)}\n`,
      "utf8",
    );

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.summary.preflight.managed_diverged_paths).toContain(join(workspace, "autonomy", "install.json"));
    expect(result.summary.install_metadata_written).toBe(false);
    expect(JSON.parse(await readFile(join(workspace, "autonomy", "install.json"), "utf8"))).toEqual(divergedInstallMetadata);
  });

  it("refreshes generated schema files when the installed contract changes", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "autonomy", "schema"), { recursive: true });
    await writeFile(
      join(workspace, "autonomy", "schema", "results.schema.json"),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://codex-auto.local/schema/results.schema.json",
        title: "AutonomyResultsFile",
        type: "object",
        additionalProperties: false,
        required: ["version", "planner", "worker", "review", "commit", "reporter"],
        properties: {
          version: {
            type: "integer",
            minimum: 1,
          },
          planner: {
            type: "object",
            additionalProperties: false,
            required: ["status", "goal_id", "summary"],
            properties: {
              status: {
                type: "string",
                enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
              },
              goal_id: {
                type: ["string", "null"],
                minLength: 1,
              },
              summary: {
                type: ["string", "null"],
              },
            },
          },
          worker: {
            type: "object",
            additionalProperties: false,
            required: ["status", "goal_id", "summary"],
            properties: {
              status: {
                type: "string",
                enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
              },
              goal_id: {
                type: ["string", "null"],
                minLength: 1,
              },
              summary: {
                type: ["string", "null"],
              },
            },
          },
          review: {
            type: "object",
            additionalProperties: false,
            required: ["status", "goal_id", "summary"],
            properties: {
              status: {
                type: "string",
                enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
              },
              goal_id: {
                type: ["string", "null"],
                minLength: 1,
              },
              summary: {
                type: ["string", "null"],
              },
            },
          },
          commit: {
            type: "object",
            additionalProperties: false,
            required: ["status", "goal_id", "summary"],
            properties: {
              status: {
                type: "string",
                enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
              },
              goal_id: {
                type: ["string", "null"],
                minLength: 1,
              },
              summary: {
                type: ["string", "null"],
              },
            },
          },
          reporter: {
            type: "object",
            additionalProperties: false,
            required: ["status", "goal_id", "summary"],
            properties: {
              status: {
                type: "string",
                enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
              },
              goal_id: {
                type: ["string", "null"],
                minLength: 1,
              },
              summary: {
                type: ["string", "null"],
              },
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "control_plane_migrated" }),
      ]),
    );
    expect(await readFile(join(workspace, "autonomy", "schema", "results.schema.json"), "utf8")).toContain(
      '"latest_goal_transition"',
    );
  });

  it("preserves user-managed schema customizations during install", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "autonomy", "schema"), { recursive: true });
    await writeFile(
      join(workspace, "autonomy", "schema", "results.schema.json"),
      `${JSON.stringify({
        ...JSON.parse(JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://codex-auto.local/schema/results.schema.json",
          title: "AutonomyResultsFile",
          type: "object",
          additionalProperties: false,
          required: ["version", "planner", "worker", "review", "commit", "reporter"],
          properties: {
            version: {
              type: "integer",
              minimum: 1,
            },
            planner: {
              type: "object",
              additionalProperties: false,
              required: ["status", "goal_id", "summary"],
              properties: {
                status: {
                  type: "string",
                  enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
                },
                goal_id: {
                  type: ["string", "null"],
                  minLength: 1,
                },
                summary: {
                  type: ["string", "null"],
                },
              },
            },
            worker: {
              type: "object",
              additionalProperties: false,
              required: ["status", "goal_id", "summary"],
              properties: {
                status: {
                  type: "string",
                  enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
                },
                goal_id: {
                  type: ["string", "null"],
                  minLength: 1,
                },
                summary: {
                  type: ["string", "null"],
                },
              },
            },
            review: {
              type: "object",
              additionalProperties: false,
              required: ["status", "goal_id", "summary"],
              properties: {
                status: {
                  type: "string",
                  enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
                },
                goal_id: {
                  type: ["string", "null"],
                  minLength: 1,
                },
                summary: {
                  type: ["string", "null"],
                },
              },
            },
            commit: {
              type: "object",
              additionalProperties: false,
              required: ["status", "goal_id", "summary"],
              properties: {
                status: {
                  type: "string",
                  enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
                },
                goal_id: {
                  type: ["string", "null"],
                  minLength: 1,
                },
                summary: {
                  type: ["string", "null"],
                },
              },
            },
            reporter: {
              type: "object",
              additionalProperties: false,
              required: ["status", "goal_id", "summary"],
              properties: {
                status: {
                  type: "string",
                  enum: ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"],
                },
                goal_id: {
                  type: ["string", "null"],
                  minLength: 1,
                },
                summary: {
                  type: ["string", "null"],
                },
              },
            },
          },
        })),
        x_user_managed: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "autonomy", "schema", "results.schema.json"), "utf8")).toContain(
      '"x_user_managed": true',
    );
    expect(await readFile(join(workspace, "autonomy", "schema", "results.schema.json"), "utf8")).not.toContain(
      '"latest_goal_transition"',
    );
  });
});
