import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitProjectCommand } from "../src/commands/init-project.js";

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

async function makeTempGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-autonomy-init-project-"));
  tempRoots.push(root);
  execFileSync("git", ["init", root], { stdio: "pipe" });
  return root;
}

function installDependenciesFor(workspace: string): Parameters<typeof runInitProjectCommand>[1] {
  return {
    installDependencies: {
      detectGitTopLevel: async () => workspace,
      detectCodexProcess: async () => true,
    },
    now: () => new Date("2026-04-18T00:00:00.000Z"),
  };
}

describe("init-project", () => {
  it("installs the control surface and creates target project baseline docs", async () => {
    const workspace = await makeTempGitRepo();
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Shop Bot\n\nCompetitive store patrol automation.\n", "utf8");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }, null, 2),
      "utf8",
    );
    await writeFile(join(workspace, "src", "main.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(workspace, "tests", "main.test.ts"), "export {};\n", "utf8");

    const result = await runInitProjectCommand(
      { target: workspace, mode: "existing" },
      installDependenciesFor(workspace),
    );

    expect(result.ok).toBe(true);
    expect(result.summary.install_ran).toBe(true);
    expect(result.summary.install_ok).toBe(true);
    expect(result.summary.created_paths).toContain(join(workspace, "TEAM_GUIDE.md"));
    expect(result.summary.created_paths).toContain(join(workspace, "AGENTS.override.md"));
    expect(await readFile(join(workspace, "autonomy", "install.json"), "utf8")).toContain("managed_paths");

    const teamGuide = await readFile(join(workspace, "TEAM_GUIDE.md"), "utf8");
    expect(teamGuide).toContain("Project title: Shop Bot.");
    expect(teamGuide).toContain("Current summary: Competitive store patrol automation.");
    expect(teamGuide).toContain("src/");
    expect(teamGuide).toContain("src/main.ts");
    expect(teamGuide).toContain("tests/main.test.ts");
    expect(teamGuide).toContain("npm run build");
    expect(teamGuide).toContain("npm run test");
    expect(teamGuide).toContain("scripts/verify.ps1");
    expect(teamGuide).toContain("doc-impact check");

    const agentsOverride = await readFile(join(workspace, "AGENTS.override.md"), "utf8");
    expect(agentsOverride).toContain("Read `TEAM_GUIDE.md`");
    expect(agentsOverride).toContain("specs/<goal-id>/");
  });

  it("preserves existing project docs unless refresh-docs is requested", async () => {
    const workspace = await makeTempGitRepo();
    await writeFile(join(workspace, "TEAM_GUIDE.md"), "# Existing Team Guide\n", "utf8");
    await writeFile(join(workspace, "AGENTS.override.md"), "# Existing Overlay\n", "utf8");

    const result = await runInitProjectCommand(
      { target: workspace, mode: "existing" },
      installDependenciesFor(workspace),
    );

    expect(result.ok).toBe(true);
    expect(result.summary.skipped_paths).toContain(join(workspace, "TEAM_GUIDE.md"));
    expect(result.summary.skipped_paths).toContain(join(workspace, "AGENTS.override.md"));
    expect(await readFile(join(workspace, "TEAM_GUIDE.md"), "utf8")).toBe("# Existing Team Guide\n");
    expect(await readFile(join(workspace, "AGENTS.override.md"), "utf8")).toBe("# Existing Overlay\n");

    const refreshed = await runInitProjectCommand(
      { target: workspace, mode: "new", refreshDocs: true, skipInstall: true },
      installDependenciesFor(workspace),
    );

    expect(refreshed.ok).toBe(true);
    expect(refreshed.summary.refreshed_paths).toContain(join(workspace, "TEAM_GUIDE.md"));
    expect(await readFile(join(workspace, "TEAM_GUIDE.md"), "utf8")).toContain("Baseline type: new project.");
  });

  it("does not use install-generated README content as the baseline for an empty repo", async () => {
    const workspace = await makeTempGitRepo();

    const result = await runInitProjectCommand(
      { target: workspace, mode: "new" },
      installDependenciesFor(workspace),
    );

    expect(result.ok).toBe(true);
    const teamGuide = await readFile(join(workspace, "TEAM_GUIDE.md"), "utf8");
    expect(teamGuide).toContain(`Project title: ${basename(workspace)}.`);
    expect(teamGuide).toContain("Current summary: TBD. Fill this in after the product goal is clear.");
    expect(teamGuide).toContain("No app directories detected yet.");
    expect(teamGuide).toContain("No top-level files detected yet.");
    expect(teamGuide).not.toContain("Project title: codex-autonomy.");
    expect(teamGuide).not.toContain("codex-autonomy install --target <repo>");
  });

  it("keeps a title-only README from adopting the managed README section as summary", async () => {
    const workspace = await makeTempGitRepo();
    await writeFile(join(workspace, "README.md"), "# Real Project\n", "utf8");

    const result = await runInitProjectCommand(
      { target: workspace, mode: "existing" },
      installDependenciesFor(workspace),
    );

    expect(result.ok).toBe(true);
    const teamGuide = await readFile(join(workspace, "TEAM_GUIDE.md"), "utf8");
    expect(teamGuide).toContain("Project title: Real Project.");
    expect(teamGuide).toContain("Current summary: TBD. Fill this in after the product goal is clear.");
    expect(teamGuide).not.toContain("codex-autonomy install --target <repo>");
  });

  it("rejects unknown init modes", async () => {
    const workspace = await makeTempGitRepo();

    await expect(runInitProjectCommand(
      { target: workspace, mode: "legacy" },
      installDependenciesFor(workspace),
    )).rejects.toThrow("init-project requires --mode existing|new.");
  });
});
