import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runPrepareWorktree } from "../src/commands/prepare-worktree.js";
import { runStatusCommand } from "../src/commands/status.js";
import { runUnblock } from "../src/commands/unblock.js";
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
    await expect(readFile(join(workspace, ".codex", "config.toml"), "utf8")).resolves.toContain(
      'sandbox_mode = "workspace-write"',
    );
    await expect(readFile(join(workspace, "autonomy", "schema", "tasks.schema.json"), "utf8")).resolves.toContain(
      '"queued"',
    );
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
          title: "Ready task",
          status: "ready",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/example.ts"],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-04-12T00:00:00Z",
        },
      ],
    } satisfies TasksDocument);

    const summary = await runStatusCommand(workspace);

    expect(summary.ready_for_automation).toBe(false);
    expect(summary.warnings?.some((warning) => warning.code === "not_a_git_repo")).toBe(true);
  });

  it("prepare-worktree refuses non-git workspaces", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a Git repository");
  });

  it("unblock resolves blockers and restores the task into ready when capacity allows", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);

    await writeJson(join(workspace, "autonomy", "tasks.json"), {
      version: 1,
      tasks: [
        {
          id: "task-blocked",
          title: "Blocked task",
          status: "blocked",
          priority: "P1",
          depends_on: [],
          acceptance: ["done"],
          file_hints: ["src/task.ts"],
          retry_count: 1,
          last_error: "needs input",
          updated_at: "2026-04-10T00:00:00Z",
        },
      ],
    } satisfies TasksDocument);
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

    const result = await runUnblock("task-blocked", workspace);
    const tasksDoc = JSON.parse(await readFile(join(workspace, "autonomy", "tasks.json"), "utf8")) as TasksDocument;
    const blockersDoc = JSON.parse(
      await readFile(join(workspace, "autonomy", "blockers.json"), "utf8"),
    ) as BlockersDocument;

    expect(result.ok).toBe(true);
    expect(result.message).toContain("task-blocked");
    expect(tasksDoc.tasks[0]?.status).toBe("ready");
    expect(tasksDoc.tasks[0]?.last_error).toBeNull();
    expect(blockersDoc.blockers[0]?.status).toBe("resolved");
    expect(blockersDoc.blockers[0]?.resolution).toContain("codex-supervisor unblock");
  });
});
