import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GoalRecord } from "../src/contracts/autonomy.js";
import { buildRepoAwareFallbackProposal } from "../src/domain/proposal.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-proposal-"));
  tempRoots.push(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeGoal(overrides: Partial<GoalRecord>): GoalRecord {
  return {
    id: overrides.id ?? "goal-test",
    title: overrides.title ?? "Test goal",
    objective: overrides.objective ?? "Ship the requested change",
    success_criteria: overrides.success_criteria ?? ["it works"],
    constraints: overrides.constraints ?? [],
    out_of_scope: overrides.out_of_scope ?? [],
    status: overrides.status ?? "awaiting_confirmation",
    run_mode: overrides.run_mode ?? "sprint",
    created_at: overrides.created_at ?? "2026-04-12T00:00:00Z",
    approved_at: overrides.approved_at ?? null,
    completed_at: overrides.completed_at ?? null,
  };
}

describe("repo-aware fallback proposal generation", () => {
  it("uses an audit-style template and repo evidence for system audit goals", async () => {
    const repoRoot = await makeTempRepo();

    await writeFile(join(repoRoot, "AGENTS.md"), "# Control Surface\n\nRun verify first.\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "# Repo\n\nUse codex-autonomy here.\n", "utf8");
    await mkdir(join(repoRoot, ".codex", "environments"), { recursive: true });
    await writeFile(join(repoRoot, ".codex", "config.toml"), 'model = "gpt-5.4"\n', "utf8");
    await writeFile(join(repoRoot, ".codex", "environments", "environment.toml"), 'name = "verify"\n', "utf8");
    await mkdir(join(repoRoot, ".agents", "skills", "$autonomy-plan"), { recursive: true });
    await writeFile(
      join(repoRoot, ".agents", "skills", "$autonomy-plan", "SKILL.md"),
      "# autonomy-plan\n\nKeep the ready window bounded.\n",
      "utf8",
    );
    await writeJson(join(repoRoot, "package.json"), {
      name: "sample-repo",
      version: "1.0.0",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
        review: "pwsh -File scripts/review.ps1",
      },
    });
    await mkdir(join(repoRoot, "docs"), { recursive: true });
    await writeFile(join(repoRoot, "docs", "security-review.md"), "# Security review\n\nCheck the control surface.\n", "utf8");
    await mkdir(join(repoRoot, "src", "commands"), { recursive: true });
    await writeFile(join(repoRoot, "src", "commands", "doctor.ts"), "export const doctor = true;\n", "utf8");
    await mkdir(join(repoRoot, "src", "infra"), { recursive: true });
    await writeFile(join(repoRoot, "src", "infra", "git.ts"), "export const git = true;\n", "utf8");
    await mkdir(join(repoRoot, "scripts"), { recursive: true });
    await writeFile(join(repoRoot, "scripts", "verify.ps1"), "Write-Host verify\n", "utf8");
    await writeFile(join(repoRoot, "scripts", "review.ps1"), "Write-Host review\n", "utf8");

    const goal = makeGoal({
      id: "goal-audit",
      title: "System audit and hardening",
      objective: "检查当前项目的安全性、健壮性、可用性与上手难度、扩展性，形成问题清单并逐项修复高优先级问题。",
      success_criteria: [
        "按安全性、健壮性、可用性与上手难度、扩展性输出问题清单",
        "修复高优先级安全或数据一致性问题",
        "所有改动通过 scripts/verify.ps1",
      ],
    });

    const result = await buildRepoAwareFallbackProposal(goal, repoRoot);

    expect(result.signals.goal_style).toBe("system_audit");
    expect(result.tasks).toHaveLength(5);
    expect(result.summary.toLowerCase()).toContain("repo-aware");
    expect(result.summary).toContain("AGENTS.md");
    expect(result.summary).toContain("package scripts");
    expect(result.tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Audit"),
        expect.stringContaining("Reproduce"),
        expect.stringContaining("Repair"),
        expect.stringContaining("Verify"),
        expect.stringContaining("Summarize"),
      ]),
    );
    expect(result.tasks.every((task) => task.acceptance.length > 0)).toBe(true);
    expect(result.tasks[0]?.file_hints).toEqual(expect.arrayContaining(["AGENTS.md", "README.md"]));

    const allHints = result.tasks.flatMap((task) => task.file_hints);
    expect(allHints).toContain("package.json");
    expect(allHints).toContain("docs/security-review.md");
    expect(allHints).toContain(".codex/config.toml");
    expect(allHints).toContain(".codex/environments/environment.toml");
    expect(allHints).toContain(".agents/skills/$autonomy-plan/SKILL.md");
    expect(allHints).toContain("src/commands/doctor.ts");
    expect(allHints).toContain("scripts/verify.ps1");
    expect(allHints).toContain("scripts/review.ps1");
  });

  it("keeps a generic repo-aware template for non-audit goals", async () => {
    const repoRoot = await makeTempRepo();

    await writeFile(join(repoRoot, "AGENTS.md"), "# Control Surface\n\nKeep changes bounded.\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "# Repo\n\nDocument the change.\n", "utf8");
    await writeJson(join(repoRoot, "package.json"), {
      name: "sample-repo",
      version: "1.0.0",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run",
      },
    });
    await mkdir(join(repoRoot, "docs"), { recursive: true });
    await writeFile(join(repoRoot, "docs", "usage.md"), "# Usage\n\nExplain the flow.\n", "utf8");
    await mkdir(join(repoRoot, "src", "features"), { recursive: true });
    await writeFile(join(repoRoot, "src", "features", "feature.ts"), "export const feature = true;\n", "utf8");
    await mkdir(join(repoRoot, "test"), { recursive: true });
    await writeFile(join(repoRoot, "test", "feature.test.ts"), "export const test = true;\n", "utf8");
    await mkdir(join(repoRoot, "scripts"), { recursive: true });
    await writeFile(join(repoRoot, "scripts", "verify.ps1"), "Write-Host verify\n", "utf8");

    const goal = makeGoal({
      id: "goal-generic",
      title: "Improve onboarding",
      objective: "Add a clearer first-run message and keep the change small.",
      success_criteria: [
        "Users can see the new first-run message",
        "Relevant tests still pass",
      ],
    });

    const result = await buildRepoAwareFallbackProposal(goal, repoRoot);

    expect(result.signals.goal_style).toBe("generic");
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.tasks.length).toBeLessThanOrEqual(5);
    expect(result.summary.toLowerCase()).toContain("repo-aware");
    expect(result.tasks.every((task) => task.acceptance.length > 0)).toBe(true);
    expect(result.tasks[0]?.file_hints).toEqual(expect.arrayContaining(["AGENTS.md", "README.md"]));
    expect(result.tasks.some((task) => task.file_hints.includes("scripts/verify.ps1"))).toBe(true);
    expect(result.tasks.some((task) => task.file_hints.some((hint) => hint.includes("src/features/feature.ts")))).toBe(true);
    expect(result.tasks.some((task) => task.file_hints.some((hint) => hint.includes("test/feature.test.ts")))).toBe(true);
  });
});
