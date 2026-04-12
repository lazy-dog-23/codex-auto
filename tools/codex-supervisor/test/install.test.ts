import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runInstallCommand } from "../src/commands/install.js";

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
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
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

    const result = await runInstallCommand({ target: workspace });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("codex-autonomy");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(existingAgents);
    expect(await readFile(join(workspace, ".codex", "environments", "environment.toml"), "utf8")).toContain(
      'name = "review"',
    );
    expect(await readFile(join(workspace, "scripts", "review.ps1"), "utf8")).toContain("Review precheck passed.");
    expect(await readFile(join(workspace, "scripts", "verify.ps1"), "utf8")).toContain("Install verify passed.");
    expect(await readFile(join(workspace, ".agents", "skills", "$autonomy-intake", "SKILL.md"), "utf8")).toContain(
      "autonomy-intake",
    );
    expect(await readFile(join(workspace, "autonomy", "goal.md"), "utf8")).toContain("codex-autonomy");
    expect(await readFile(join(workspace, "autonomy", "journal.md"), "utf8")).toContain("Append one entry per run");
    expect(await readFile(join(workspace, "autonomy", "goals.json"), "utf8")).toContain('"goals"');
    expect(await readFile(join(workspace, "autonomy", "settings.json"), "utf8")).toContain('"autonomy_branch"');
    expect(await readFile(join(workspace, "autonomy", "schema", "results.schema.json"), "utf8")).toContain('"reporter"');
  });
});
