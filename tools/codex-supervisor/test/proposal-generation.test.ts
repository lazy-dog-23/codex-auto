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
  it("produces a fixed five-step audit plan and a full_e2e verification path when Playwright exists", async () => {
    const repoRoot = await makeTempRepo();

    await writeFile(join(repoRoot, "AGENTS.md"), "# Control Surface\n\nRun verify first.\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "# Repo\n\nUse codex-autonomy here.\n", "utf8");
    await mkdir(join(repoRoot, "docs"), { recursive: true });
    await writeFile(join(repoRoot, "docs", "security-review.md"), "# Security review\n\nCheck the control surface.\n", "utf8");
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
        "test:e2e": "playwright test",
        review: "pwsh -File scripts/review.ps1",
      },
    });
    await writeFile(join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - app\n", "utf8");
    await writeJson(join(repoRoot, "turbo.json"), {
      pipeline: {
        build: {},
        test: {},
      },
    });
    await writeJson(join(repoRoot, "tsconfig.json"), {
      compilerOptions: {
        strict: true,
      },
    });
    await writeFile(join(repoRoot, "playwright.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(repoRoot, "vitest.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(repoRoot, "jest.config.ts"), "module.exports = {};\n", "utf8");
    await writeFile(join(repoRoot, "capacitor.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(repoRoot, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts = \"-q\"\n", "utf8");
    await writeFile(join(repoRoot, "requirements-dev.txt"), "pytest>=8.0.0\nplaywright\n", "utf8");
    await writeFile(join(repoRoot, "pytest.ini"), "[pytest]\naddopts = -q\n", "utf8");
    await mkdir(join(repoRoot, "src", "features"), { recursive: true });
    await writeFile(join(repoRoot, "src", "app.ts"), "export const app = true;\n", "utf8");
    await writeFile(join(repoRoot, "src", "features", "onboarding.ts"), "export const onboarding = true;\n", "utf8");
    await mkdir(join(repoRoot, "test"), { recursive: true });
    await writeFile(join(repoRoot, "test", "app.test.ts"), "export const test = true;\n", "utf8");
    await mkdir(join(repoRoot, "tests", "e2e"), { recursive: true });
    await writeFile(join(repoRoot, "tests", "e2e", "home.spec.ts"), "export const e2e = true;\n", "utf8");
    await mkdir(join(repoRoot, "e2e"), { recursive: true });
    await writeFile(join(repoRoot, "e2e", "flow.spec.ts"), "export const flow = true;\n", "utf8");
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
    expect(result.signals.package_manifest_paths).toEqual(expect.arrayContaining(["package.json"]));
    expect(result.signals.python_manifest_paths).toEqual(expect.arrayContaining(["pyproject.toml", "requirements-dev.txt", "pytest.ini"]));
    expect(result.signals.tooling_config_paths).toEqual(
      expect.arrayContaining([
        "playwright.config.ts",
        "vitest.config.ts",
        "jest.config.ts",
        "capacitor.config.ts",
        "tsconfig.json",
        "pnpm-workspace.yaml",
        "turbo.json",
      ]),
    );
    expect(result.signals.candidate_source_paths).toEqual(expect.arrayContaining(["src/app.ts", "src/features/onboarding.ts"]));
    expect(result.signals.candidate_test_paths).toEqual(
      expect.arrayContaining(["test/app.test.ts", "tests/e2e/home.spec.ts", "e2e/flow.spec.ts"]),
    );
    expect(result.signals.e2e_frameworks).toContain("playwright");
    expect(result.signals.preferred_validation_action).toBe("full_e2e");
    expect(result.tasks).toHaveLength(5);
    expect(result.summary.toLowerCase()).toContain("repo-aware");
    expect(result.summary).toContain("full_e2e");
    expect(result.tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Audit"),
        expect.stringContaining("Reproduce and measure"),
        expect.stringContaining("Repair"),
        expect.stringContaining("Verify the fix with full_e2e validation"),
        expect.stringContaining("Summarize"),
      ]),
    );
    expect(result.tasks.every((task) => task.acceptance.length > 0)).toBe(true);
    expect(result.tasks[0]?.file_hints).toEqual(expect.arrayContaining(["AGENTS.md", "README.md", "docs/security-review.md"]));
    expect(result.tasks[3]?.acceptance.join(" ")).toContain("full_e2e");
    expect(result.tasks[3]?.file_hints).toEqual(expect.arrayContaining(["tests/e2e/home.spec.ts", "scripts/verify.ps1"]));
    expect(result.tasks[4]?.acceptance.join(" ")).toContain("safe next follow-up");
  });

  it("uses an equivalent e2e verification path when browser-style validation exists without Playwright", async () => {
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
    await writeFile(join(repoRoot, "capacitor.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(repoRoot, "tsconfig.json"), "export default {};\n", "utf8");
    await mkdir(join(repoRoot, "src", "ui"), { recursive: true });
    await writeFile(join(repoRoot, "src", "ui", "onboarding.ts"), "export const onboarding = true;\n", "utf8");
    await mkdir(join(repoRoot, "tests"), { recursive: true });
    await writeFile(join(repoRoot, "tests", "onboarding.test.ts"), "export const test = true;\n", "utf8");
    await mkdir(join(repoRoot, "e2e"), { recursive: true });
    await writeFile(join(repoRoot, "e2e", "login.spec.ts"), "export const spec = true;\n", "utf8");
    await mkdir(join(repoRoot, "scripts"), { recursive: true });
    await writeFile(join(repoRoot, "scripts", "verify.ps1"), "Write-Host verify\n", "utf8");
    await writeFile(join(repoRoot, "scripts", "review.ps1"), "Write-Host review\n", "utf8");

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
    expect(result.signals.preferred_validation_action).toBe("equivalent_e2e");
    expect(result.signals.e2e_frameworks).toContain("capacitor");
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.tasks.length).toBeLessThanOrEqual(5);
    expect(result.summary.toLowerCase()).toContain("repo-aware");
    expect(result.summary).toContain("equivalent_e2e");
    expect(result.tasks.every((task) => task.acceptance.length > 0)).toBe(true);
    expect(result.tasks[0]?.file_hints).toEqual(expect.arrayContaining(["AGENTS.md", "README.md"]));
    expect(result.tasks.some((task) => task.title.includes("equivalent e2e validation"))).toBe(true);
    expect(result.tasks.some((task) => task.acceptance.join(" ").includes("equivalent e2e validation path"))).toBe(true);
    expect(result.tasks.some((task) => task.file_hints.includes("e2e/login.spec.ts"))).toBe(true);
    expect(result.tasks.some((task) => task.file_hints.includes("capacitor.config.ts"))).toBe(true);
  });
});
