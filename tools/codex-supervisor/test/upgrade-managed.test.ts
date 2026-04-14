import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInstallCommand } from "../src/commands/install.js";
import {
  inspectManagedUpgradeState,
  runRebaselineManagedCommand,
  runUpgradeManagedCommand,
} from "../src/commands/upgrade-managed.js";
import { getLegacyReviewScriptTemplates } from "../src/scaffold/templates.js";

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
  const root = await mkdtemp(join(tmpdir(), "codex-autonomy-upgrade-"));
  tempRoots.push(root);
  execFileSync("git", ["init", root], { stdio: "pipe" });
  return root;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeLegacySettings(): Record<string, unknown> {
  return {
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
  };
}

describe("upgrade-managed", () => {
  it("builds a guided plan and applies only safe_replace and auto_merge entries", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const installMetadataPath = join(workspace, "autonomy", "install.json");
    const installMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      product_version: string;
      managed_files: Array<{ path: string; template_id: string; installed_hash: string; last_reconciled_product_version: string; management_class: string }>;
    };

    const reviewPath = join(workspace, "scripts", "review.ps1");
    const legacyReview = getLegacyReviewScriptTemplates()[0];
    await writeFile(reviewPath, legacyReview, "utf8");

    const settingsPath = join(workspace, "autonomy", "settings.json");
    const legacySettings = makeLegacySettings();
    const currentSettings = {
      ...legacySettings,
      custom_note: "keep me",
    };
    await writeFile(settingsPath, `${JSON.stringify(currentSettings, null, 2)}\n`, "utf8");

    const statePath = join(workspace, "autonomy", "state.json");
    const currentState = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    currentState.cycle_status = "blocked";
    await writeFile(statePath, `${JSON.stringify(currentState, null, 2)}\n`, "utf8");

    const blockedSchemaPath = join(workspace, "autonomy", "schema", "blockers.schema.json");
    await rm(blockedSchemaPath, { force: true });
    await mkdir(blockedSchemaPath, { recursive: true });

    const reviewRecord = installMetadata.managed_files.find((item) => item.path === "scripts/review.ps1");
    const settingsRecord = installMetadata.managed_files.find((item) => item.path === "autonomy/settings.json");
    const stateRecord = installMetadata.managed_files.find((item) => item.path === "autonomy/state.json");
    expect(reviewRecord).toBeDefined();
    expect(settingsRecord).toBeDefined();
    expect(stateRecord).toBeDefined();

    if (reviewRecord) {
      reviewRecord.installed_hash = hashText(legacyReview);
      reviewRecord.last_reconciled_product_version = "0.0.9";
    }
    if (settingsRecord) {
      settingsRecord.installed_hash = hashText(`${JSON.stringify(legacySettings, null, 2)}\n`);
      settingsRecord.last_reconciled_product_version = "0.0.9";
    }
    if (stateRecord) {
      stateRecord.installed_hash = hashText(`${JSON.stringify({ ...currentState, cycle_status: "idle" }, null, 2)}\n`);
      stateRecord.last_reconciled_product_version = "0.0.9";
    }

    installMetadata.product_version = "0.0.9";
    await writeFile(installMetadataPath, `${JSON.stringify(installMetadata, null, 2)}\n`, "utf8");

    const originalReview = await readFile(reviewPath, "utf8");
    const originalSettings = await readFile(settingsPath, "utf8");
    const originalState = await readFile(statePath, "utf8");

    const planResult = await runUpgradeManagedCommand({ target: workspace });
    expect(planResult.ok).toBe(true);
    expect(planResult.plan.find((entry) => entry.relative_path === "README.md")).toBeDefined();
    expect(planResult.summary.safe_replace).toBeGreaterThan(0);
    expect(planResult.summary.auto_merge).toBeGreaterThan(0);
    expect(planResult.summary.manual_conflict).toBeGreaterThan(0);
    expect(planResult.summary.foreign_occupied).toBeGreaterThan(0);
    expect(planResult.plan.find((entry) => entry.relative_path === "scripts/review.ps1")?.status).toBe("safe_replace");
    expect(planResult.plan.find((entry) => entry.relative_path === "autonomy/settings.json")?.status).toBe("auto_merge");
    expect(planResult.plan.find((entry) => entry.relative_path === "autonomy/state.json")?.status).toBe("manual_conflict");
    expect(planResult.plan.find((entry) => entry.relative_path === "autonomy/schema/blockers.schema.json")?.status).toBe("foreign_occupied");
    expect(await readFile(reviewPath, "utf8")).toBe(originalReview);
    expect(await readFile(settingsPath, "utf8")).toBe(originalSettings);
    expect(await readFile(statePath, "utf8")).toBe(originalState);

    const applyResult = await runUpgradeManagedCommand({ target: workspace, apply: true });
    expect(applyResult.ok).toBe(true);
    expect(applyResult.summary.applied_paths).toEqual(expect.arrayContaining(["scripts/review.ps1", "autonomy/settings.json"]));
    expect(applyResult.summary.pending_paths).toEqual(expect.arrayContaining(["autonomy/state.json", "autonomy/schema/blockers.schema.json"]));

    const updatedReview = await readFile(reviewPath, "utf8");
    const updatedSettings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const updatedState = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const updatedInstall = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      product_version: string;
      managed_files: Array<{ path: string; template_id: string; installed_hash: string; last_reconciled_product_version: string; management_class: string }>;
    };

    expect(updatedReview).toContain("Review checks passed.");
    expect(updatedSettings.custom_note).toBe("keep me");
    expect(updatedSettings.auto_continue_within_goal).toBe(true);
    expect(updatedSettings.block_on_major_decision).toBe(true);
    expect(updatedState.cycle_status).toBe("blocked");
    expect(updatedInstall.product_version).toBe("0.1.0");
    expect(updatedInstall.managed_files.find((item) => item.path === "scripts/review.ps1")?.last_reconciled_product_version).toBe("0.1.0");
    expect(updatedInstall.managed_files.find((item) => item.path === "autonomy/settings.json")?.last_reconciled_product_version).toBe("0.1.0");
    expect(updatedInstall.managed_files.find((item) => item.path === "autonomy/settings.json")?.management_class).toBe("repo_customized");
  });

  it("treats repo-customized and runtime-state drift as advisory when static templates still match", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    await writeFile(join(workspace, "AGENTS.md"), "# repo specific rules\n", "utf8");

    const currentResults = JSON.parse(await readFile(join(workspace, "autonomy", "results.json"), "utf8")) as Record<string, unknown>;
    currentResults.last_summary_reason = "runtime drift is expected";
    await writeFile(join(workspace, "autonomy", "results.json"), `${JSON.stringify(currentResults, null, 2)}\n`, "utf8");

    const state = await inspectManagedUpgradeState(workspace);
    expect(state.state).toBe("managed_advisory_drift");
    expect(state.summary?.blocking_drift).toBe(0);
    expect(state.summary?.advisory_drift).toBeGreaterThanOrEqual(2);

    const plan = await runUpgradeManagedCommand({ target: workspace });
    expect(plan.plan.find((entry) => entry.relative_path === "AGENTS.md")?.management_class).toBe("repo_customized");
    expect(plan.plan.find((entry) => entry.relative_path === "AGENTS.md")?.upgrade_blocking).toBe(false);
    expect(plan.plan.find((entry) => entry.relative_path === "autonomy/results.json")?.management_class).toBe("runtime_state");
    expect(plan.plan.find((entry) => entry.relative_path === "autonomy/results.json")?.upgrade_blocking).toBe(false);
  });

  it("rebaselines advisory drift without overwriting repo-customized or runtime-state files", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const agentsPath = join(workspace, "AGENTS.md");
    const journalPath = join(workspace, "autonomy", "journal.md");
    const installMetadataPath = join(workspace, "autonomy", "install.json");

    await writeFile(agentsPath, "# repo specific rules\n", "utf8");
    await writeFile(journalPath, "## journal\n\ncustom runtime note\n", "utf8");

    const beforeAgents = await readFile(agentsPath, "utf8");
    const beforeJournal = await readFile(journalPath, "utf8");

    const advisoryState = await inspectManagedUpgradeState(workspace);
    expect(advisoryState.state).toBe("managed_advisory_drift");

    const result = await runRebaselineManagedCommand({ target: workspace });
    expect(result.ok).toBe(true);
    expect(result.summary.rebaselined_paths).toEqual(expect.arrayContaining(["AGENTS.md", "autonomy/journal.md"]));
    expect(result.summary.blocking_paths).toHaveLength(0);

    expect(await readFile(agentsPath, "utf8")).toBe(beforeAgents);
    expect(await readFile(journalPath, "utf8")).toBe(beforeJournal);

    const installMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      product_version: string;
      managed_files: Array<{ path: string; installed_hash: string; last_reconciled_product_version: string }>;
    };
    expect(installMetadata.product_version).toBe("0.1.0");
    expect(installMetadata.managed_files.find((item) => item.path === "AGENTS.md")?.installed_hash).toBe(hashText(beforeAgents));
    expect(installMetadata.managed_files.find((item) => item.path === "autonomy/journal.md")?.installed_hash).toBe(hashText(beforeJournal));
    expect(installMetadata.managed_files.find((item) => item.path === "AGENTS.md")?.last_reconciled_product_version).toBe("0.1.0");
    expect(installMetadata.managed_files.find((item) => item.path === "AGENTS.md")?.baseline_origin).toBe("repo_specific");

    const afterState = await inspectManagedUpgradeState(workspace);
    expect(afterState.state).toBe("managed_match");
  });

  it("surfaces operator-thread guidance in upgrade and rebaseline summaries", async () => {
    const workspace = await makeTempGitRepo();
    process.env.CODEX_THREAD_ID = "thread-upgrade-123";

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const planResult = await runUpgradeManagedCommand({ target: workspace });
    expect(planResult.summary.current_thread_id).toBe("thread-upgrade-123");
    expect(planResult.summary.thread_binding_state).toBe("unbound_current_available");
    expect(planResult.summary.next_operator_action).toBe("bind_current_thread");
    expect(planResult.summary.next_operator_command).toBe("codex-autonomy bind-thread");
    expect(planResult.message).toContain("Next operator command: codex-autonomy bind-thread.");

    const rebaselineResult = await runRebaselineManagedCommand({ target: workspace });
    expect(rebaselineResult.summary.current_thread_id).toBe("thread-upgrade-123");
    expect(rebaselineResult.summary.thread_binding_state).toBe("unbound_current_available");
    expect(rebaselineResult.summary.next_operator_action).toBe("bind_current_thread");
    expect(rebaselineResult.summary.next_operator_command).toBe("codex-autonomy bind-thread");
  });

  it("treats untouched repo-customized files as safe_replace when local templates changed without a version bump", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const installMetadataPath = join(workspace, "autonomy", "install.json");
    const installMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      product_version: string;
      managed_files: Array<{ path: string; installed_hash: string; last_reconciled_product_version: string; baseline_origin?: string }>;
    };

    const reviewPath = join(workspace, "scripts", "review.ps1");
    const legacyReview = getLegacyReviewScriptTemplates()[0];
    await writeFile(reviewPath, legacyReview, "utf8");

    const reviewRecord = installMetadata.managed_files.find((item) => item.path === "scripts/review.ps1");
    expect(reviewRecord).toBeDefined();
    if (!reviewRecord) {
      throw new Error("Expected scripts/review.ps1 metadata record.");
    }

    reviewRecord.installed_hash = hashText(legacyReview);
    reviewRecord.last_reconciled_product_version = "0.1.0";
    delete reviewRecord.baseline_origin;
    installMetadata.product_version = "0.1.0";
    await writeFile(installMetadataPath, `${JSON.stringify(installMetadata, null, 2)}\n`, "utf8");

    const plan = await runUpgradeManagedCommand({ target: workspace });
    expect(plan.plan.find((entry) => entry.relative_path === "scripts/review.ps1")?.status).toBe("safe_replace");

    const apply = await runUpgradeManagedCommand({ target: workspace, apply: true });
    expect(apply.summary.applied_paths).toContain("scripts/review.ps1");

    const updatedInstallMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      managed_files: Array<{ path: string; baseline_origin?: string }>;
    };
    expect(updatedInstallMetadata.managed_files.find((item) => item.path === "scripts/review.ps1")?.baseline_origin).toBe("template");
  });

  it("adopts a manageable README without an existing metadata record during upgrade", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const readmePath = join(workspace, "README.md");
    const installMetadataPath = join(workspace, "autonomy", "install.json");
    await writeFile(readmePath, "# Target Repo\n\nExisting README body.\n", "utf8");

    const installMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      managed_paths: string[];
      managed_files: Array<{ path: string }>;
    };
    installMetadata.managed_paths = installMetadata.managed_paths.filter((item) => item !== "README.md");
    installMetadata.managed_files = installMetadata.managed_files.filter((item) => item.path !== "README.md");
    await writeFile(installMetadataPath, `${JSON.stringify(installMetadata, null, 2)}\n`, "utf8");

    const plan = await runUpgradeManagedCommand({ target: workspace });
    expect(plan.plan.find((entry) => entry.relative_path === "README.md")?.status).toBe("safe_replace");

    const apply = await runUpgradeManagedCommand({ target: workspace, apply: true });
    expect(apply.summary.applied_paths).toContain("README.md");

    const readme = await readFile(readmePath, "utf8");
    expect(readme).toContain("# Target Repo");
    expect(readme).toContain("Existing README body.");
    expect(readme).toContain("<!-- codex-autonomy:managed:start -->");

    const updatedMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      managed_paths: string[];
      managed_files: Array<{ path: string; template_id: string; content_mode?: string }>;
    };
    expect(updatedMetadata.managed_paths).toContain("README.md");
    expect(updatedMetadata.managed_files.find((item) => item.path === "README.md")?.template_id).toBe("readme_markdown_section");
    expect(updatedMetadata.managed_files.find((item) => item.path === "README.md")?.content_mode).toBe("markdown_section");
  });

  it("updates only the managed README section during upgrade", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const readmePath = join(workspace, "README.md");
    const currentReadme = await readFile(readmePath, "utf8");
    const customizedReadme = currentReadme
      .replace("# codex-autonomy", "# Repo Title")
      .replace(
        "## codex-autonomy",
        "## codex-autonomy\n\nLegacy section note that should be replaced.",
      );
    await writeFile(readmePath, customizedReadme, "utf8");

    const apply = await runUpgradeManagedCommand({ target: workspace, apply: true });
    expect(apply.summary.applied_paths).toContain("README.md");

    const upgradedReadme = await readFile(readmePath, "utf8");
    expect(upgradedReadme).toContain("# Repo Title");
    expect(upgradedReadme).not.toContain("Legacy section note that should be replaced.");
    expect(upgradedReadme).toContain("<!-- codex-autonomy:managed:start -->");
    expect(upgradedReadme).toContain("relay completion event");
  });

  it("does not rebaseline README files that are outside the managed section policy", async () => {
    const workspace = await makeTempGitRepo();

    const installResult = await runInstallCommand(
      { target: workspace },
      {
        detectGitTopLevel: async () => workspace,
        detectCodexProcess: async () => true,
      },
    );
    expect(installResult.ok).toBe(true);

    const readmePath = join(workspace, "README.md");
    const installMetadataPath = join(workspace, "autonomy", "install.json");
    const oversizedReadme = `# Target Repo\n\n${"x".repeat(25 * 1024)}`;
    await writeFile(readmePath, oversizedReadme, "utf8");

    const beforeMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      managed_files: Array<{ path: string; installed_hash: string }>;
    };
    const beforeReadmeHash = beforeMetadata.managed_files.find((item) => item.path === "README.md")?.installed_hash;
    expect(beforeReadmeHash).toBeDefined();

    const plan = await runUpgradeManagedCommand({ target: workspace });
    const readmeEntry = plan.plan.find((entry) => entry.relative_path === "README.md");
    expect(readmeEntry?.status).toBe("manual_conflict");
    expect(readmeEntry?.current_hash).toBeNull();

    const rebaseline = await runRebaselineManagedCommand({ target: workspace });
    expect(rebaseline.ok).toBe(true);
    expect(rebaseline.summary.rebaselined_paths).not.toContain("README.md");

    const afterMetadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as {
      managed_files: Array<{ path: string; installed_hash: string }>;
    };
    expect(afterMetadata.managed_files.find((item) => item.path === "README.md")?.installed_hash).toBe(beforeReadmeHash);
  });
});
