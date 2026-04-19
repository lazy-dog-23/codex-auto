import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGraphifySnapshotCommand } from "../src/commands/graphify-snapshot.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-autonomy-graphify-snapshot-"));
  tempRoots.push(root);
  await mkdir(join(root, "backend"), { recursive: true });
  await writeFile(join(root, "backend", "main.py"), "def main():\n    return 'ok'\n", "utf8");
  return root;
}

function graphifyDependencies() {
  return {
    ensureTool: async () => ({
      pythonPath: "C:/tools/graphify/.venv/Scripts/python.exe",
      toolDir: "C:/tools/graphify",
      packageInstalled: false,
    }),
    runUpdate: async (options: { targetPath: string }) => {
      const outDir = join(options.targetPath, "graphify-out");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "graph.json"), "{\"nodes\":[],\"edges\":[]}\n", "utf8");
      await writeFile(join(outDir, "graph.html"), "<html></html>\n", "utf8");
      await writeFile(
        join(outDir, "GRAPH_REPORT.md"),
        [
          "# Graph Report",
          "",
          "## Corpus Check",
          "- 3 files · ~1,234 words",
          "",
          "## Summary",
          "- 12 nodes · 34 edges · 5 communities detected",
          "- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS",
          "",
          "## God Nodes (most connected - your core abstractions)",
          "1. `main()` - 8 edges",
          "2. `Client` - 5 edges",
          "",
          "## Communities",
        ].join("\n"),
        "utf8",
      );
      return { stdout: "updated", stderr: "" };
    },
  };
}

describe("graphify-snapshot", () => {
  it("creates a source-only Graphify snapshot without installing hooks", async () => {
    const workspace = await makeWorkspace();

    const result = await runGraphifySnapshotCommand(
      { target: workspace, profile: "source-only", toolDir: "C:/tools/graphify" },
      graphifyDependencies(),
    );

    expect(result.ok).toBe(true);
    expect(result.summary.profile).toBe("source-only");
    expect(result.summary.ignore_action).toBe("created");
    expect(result.summary.metrics.nodes).toBe(12);
    expect(result.summary.metrics.edges).toBe(34);
    expect(result.summary.metrics.communities).toBe(5);
    expect(result.summary.metrics.god_nodes).toEqual([
      "1. `main()` - 8 edges",
      "2. `Client` - 5 edges",
    ]);

    const ignore = await readFile(join(workspace, ".graphifyignore"), "utf8");
    expect(ignore).toContain("# BEGIN codex-autonomy graphify-snapshot");
    expect(ignore).toContain("profile: source-only");
    expect(ignore).toContain("tests/");
    expect(ignore).toContain(".agents/");
    await expect(readFile(join(workspace, ".codex", "hooks.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("preserves an existing managed ignore block unless refresh-ignore is requested", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      join(workspace, ".graphifyignore"),
      [
        "custom/",
        "",
        "# BEGIN codex-autonomy graphify-snapshot",
        "# profile: source-only",
        "old-pattern/",
        "# END codex-autonomy graphify-snapshot",
        "",
      ].join("\n"),
      "utf8",
    );

    const preserved = await runGraphifySnapshotCommand(
      { target: workspace, profile: "full", toolDir: "C:/tools/graphify" },
      graphifyDependencies(),
    );

    expect(preserved.summary.ignore_action).toBe("preserved");
    expect(await readFile(join(workspace, ".graphifyignore"), "utf8")).toContain("old-pattern/");

    const refreshed = await runGraphifySnapshotCommand(
      { target: workspace, profile: "full", refreshIgnore: true, toolDir: "C:/tools/graphify" },
      graphifyDependencies(),
    );

    const ignore = await readFile(join(workspace, ".graphifyignore"), "utf8");
    expect(refreshed.summary.ignore_action).toBe("updated");
    expect(ignore).toContain("custom/");
    expect(ignore).toContain("profile: full");
    expect(ignore).not.toContain("old-pattern/");
    expect(ignore).not.toContain("tests/");
  });

  it("does not write .graphifyignore when tool setup fails", async () => {
    const workspace = await makeWorkspace();

    await expect(runGraphifySnapshotCommand(
      { target: workspace, profile: "source-only", toolDir: "C:/tools/graphify", skipInstall: true },
      {
        ...graphifyDependencies(),
        ensureTool: async () => {
          throw new Error("missing helper");
        },
      },
    )).rejects.toThrow("missing helper");

    await expect(readFile(join(workspace, ".graphifyignore"), "utf8")).rejects.toThrow();
  });

  it("restores .graphifyignore when graphify update fails", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      join(workspace, ".graphifyignore"),
      [
        "custom/",
        "",
        "# BEGIN codex-autonomy graphify-snapshot",
        "# profile: source-only",
        "old-pattern/",
        "# END codex-autonomy graphify-snapshot",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(runGraphifySnapshotCommand(
      { target: workspace, profile: "full", refreshIgnore: true, toolDir: "C:/tools/graphify" },
      {
        ...graphifyDependencies(),
        runUpdate: async () => {
          throw new Error("graphify exploded");
        },
      },
    )).rejects.toThrow("graphify exploded");

    const ignore = await readFile(join(workspace, ".graphifyignore"), "utf8");
    expect(ignore).toContain("old-pattern/");
    expect(ignore).not.toContain("profile: full");
  });

  it("fails and rolls back when graphify omits required outputs", async () => {
    const workspace = await makeWorkspace();

    await expect(runGraphifySnapshotCommand(
      { target: workspace, profile: "source-only", toolDir: "C:/tools/graphify" },
      {
        ...graphifyDependencies(),
        runUpdate: async (options: { targetPath: string }) => {
          const outDir = join(options.targetPath, "graphify-out");
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, "graph.html"), "<html></html>\n", "utf8");
          return { stdout: "updated", stderr: "" };
        },
      },
    )).rejects.toThrow("required output is missing");

    await expect(readFile(join(workspace, ".graphifyignore"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "graphify-out", "graph.html"), "utf8")).rejects.toThrow();
  });

  it("rejects unknown profiles", async () => {
    const workspace = await makeWorkspace();

    await expect(runGraphifySnapshotCommand(
      { target: workspace, profile: "everything" },
      graphifyDependencies(),
    )).rejects.toThrow("graphify-snapshot requires --profile source-only|full.");
  });
});
