import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compressMarkdownText, runCompressDocsCommand } from "../src/commands/compress-docs.js";

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
  const root = await mkdtemp(join(tmpdir(), "codex-compress-docs-"));
  tempRoots.push(root);
  return root;
}

describe("compress-docs", () => {
  it("previews safe markdown compression without writing by default", async () => {
    const workspace = await makeTempWorkspace();
    const teamGuidePath = join(workspace, "TEAM_GUIDE.md");
    const original = [
      "# TEAM_GUIDE",
      "",
      "",
      "## Run And Verification Commands",
      "",
      "- Use `codex-autonomy scan --target . --profile source-only`.",
      "- Use `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`.",
      "",
      "## Current Risks / Known Unknowns",
      "",
      "- Keep `C:\\repo\\TEAM_GUIDE.md` short and preserve [docs](https://example.com/docs).",
      "- Duplicate note.",
      "- Duplicate note.",
      "",
      "```powershell",
      "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1   ",
      "```",
      "",
      "",
    ].join("\n");
    await writeFile(teamGuidePath, original, "utf8");

    const result = await runCompressDocsCommand({ target: workspace });
    const after = await readFile(teamGuidePath, "utf8");

    expect(result.ok).toBe(true);
    expect(result.summary.mode).toBe("check");
    expect(result.summary.documents[0]?.action).toBe("checked");
    expect(result.summary.documents[0]?.bytes_saved).toBeGreaterThan(0);
    expect(result.summary.documents[0]?.code_fences_preserved).toBe(true);
    expect(result.summary.documents[0]?.risk_section_present).toBe(true);
    expect(result.summary.documents[0]?.warnings).toEqual([]);
    expect(after).toBe(original);
  });

  it("writes only allowed project context documents when requested", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "autonomy", "context"), { recursive: true });
    await writeFile(join(workspace, "TEAM_GUIDE.md"), "# TEAM_GUIDE\n\n\n## Current Risks\n\n- One risk.\n", "utf8");
    await writeFile(join(workspace, "AGENTS.override.md"), "# Rules\n\n\n- Keep commands.\n", "utf8");
    await writeFile(join(workspace, "autonomy", "context", "notes.md"), "# Notes\n\n\n- `npm run test`\n", "utf8");
    await writeFile(join(workspace, "README.md"), "# README\n\n\nShould stay verbose.\n", "utf8");
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");

    const result = await runCompressDocsCommand({ target: workspace, write: true });

    await expect(readFile(join(workspace, "TEAM_GUIDE.md"), "utf8")).resolves.toBe("# TEAM_GUIDE\n\n## Current Risks\n\n- One risk.\n");
    await expect(readFile(join(workspace, "AGENTS.override.md"), "utf8")).resolves.toBe("# Rules\n\n- Keep commands.\n");
    await expect(readFile(join(workspace, "autonomy", "context", "notes.md"), "utf8")).resolves.toBe("# Notes\n\n- `npm run test`\n");
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toContain("\n\n\nShould stay verbose");
    await expect(readFile(join(workspace, "src", "index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    expect(result.summary.mode).toBe("write");
    expect(result.summary.totals.documents_changed).toBe(3);
  });

  it("requires a single mode flag", async () => {
    await expect(runCompressDocsCommand({ check: true, write: true })).rejects.toThrow(/either --check or --write/i);
  });

  it("warns when TEAM_GUIDE remains over the recommended context budget", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(
      join(workspace, "TEAM_GUIDE.md"),
      `# TEAM_GUIDE\n\n## Current Risks\n\n${Array.from(
        { length: 600 },
        (_, index) => `- Keep this section visible for follow-up ${index}.`,
      ).join("\n")}\n`,
      "utf8",
    );

    const result = await runCompressDocsCommand({ target: workspace, check: true });

    expect(result.summary.documents[0]?.manual_review_recommended).toBe(true);
    expect(result.summary.documents[0]?.warnings.map((warning) => warning.code)).toContain(
      "compress_docs_team_guide_over_budget",
    );
  });

  it("preserves fenced content while trimming surrounding markdown", () => {
    const compressed = compressMarkdownText("# Doc\n\n\n```text\nvalue   stays\n```\n\n\nDone.\n");

    expect(compressed).toBe("# Doc\n\n```text\nvalue   stays\n```\n\nDone.\n");
  });

  it("preserves CRLF line endings when the source document uses CRLF", () => {
    const compressed = compressMarkdownText("# Doc\r\n\r\n\r\nDone.\r\n");

    expect(compressed).toBe("# Doc\r\n\r\nDone.\r\n");
  });

  it("does not propose a write when safe normalization would not reduce bytes", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, "AGENTS.override.md"), "# Rules\r\n\r\n- Keep this as-is.\r\n", "utf8");

    const result = await runCompressDocsCommand({ target: workspace, check: true });

    expect(result.summary.documents[0]?.action).toBe("unchanged");
    expect(result.summary.totals.documents_changed).toBe(0);
  });
});
