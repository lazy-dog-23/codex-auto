import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { getReviewScriptTemplate } from "../src/scaffold/templates.js";
import { parseToml, lookupTomlValue, readSimpleTomlFile } from "../src/infra/toml.js";

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
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-toml-"));
  tempRoots.push(root);
  return root;
}

describe("TOML compatibility and review contract", () => {
  it("parses real TOML structures including nested tables, arrays, inline tables, and array tables", async () => {
    const document = parseToml([
      "# leading comment",
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
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
      '[[plugins]]',
      'name = "beta"',
      'enabled = false',
      '',
    ].join("\n"));

    const secondPlugin = lookupTomlValue(document, ["plugins"]) as Array<Record<string, unknown>>;

    expect(document.approval_policy).toBe("on-request");
    expect(document.sandbox_mode).toBe("workspace-write");
    expect((document.sandbox_workspace_write as Record<string, unknown>).network_access).toBe(true);
    expect((document.sandbox_workspace_write as Record<string, unknown>).allowed_hosts).toEqual([
      "localhost",
      "127.0.0.1",
    ]);
    expect((document.sandbox_workspace_write as Record<string, unknown>).limits).toEqual({
      retries: 3,
      nested: { enabled: true },
    });
    expect((document.extra as Record<string, unknown>).section).toEqual({ enabled: true });
    expect(Array.isArray(secondPlugin)).toBe(true);
    expect(secondPlugin).toHaveLength(2);
    expect(secondPlugin[0]?.name).toBe("alpha");
    expect(secondPlugin[1]?.name).toBe("beta");
  });

  it("preserves the legacy readSimpleTomlFile entry point", async () => {
    const workspace = await makeTempWorkspace();
    const tomlPath = join(workspace, "config.toml");

    await writeFile(
      tomlPath,
      [
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
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

    const document = await readSimpleTomlFile(tomlPath);

    expect(document.approval_policy).toBe("on-request");
    expect((document.windows as Record<string, unknown>).sandbox).toBe("unelevated");
  });

  it("allows doctor to accept a config.toml with extra sections and complex structures", async () => {
    const workspace = await makeTempWorkspace();
    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, ".codex", "config.toml"),
      [
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

  it("keeps the review script focused on required actions and paths", () => {
    const reviewScript = getReviewScriptTemplate();

    expect(reviewScript).toContain("environment.toml");
    expect(reviewScript).toContain("scripts/setup.windows.ps1");
    expect(reviewScript).toContain("scripts/verify.ps1");
    expect(reviewScript).toContain("scripts/smoke.ps1");
    expect(reviewScript).toContain("scripts/review.ps1");
    expect(reviewScript).not.toContain("Read-Toml");
    expect(reviewScript).not.toContain("Read-SimpleTomlMap");
  });

  it("rejects malformed bare numeric and datetime tokens instead of accepting them loosely", () => {
    expect(() => parseToml("leading_zero = 01\n")).toThrow();
    expect(() => parseToml("bad_datetime = 2026-13-99T25:61:61Z\n")).toThrow();
  });
});
