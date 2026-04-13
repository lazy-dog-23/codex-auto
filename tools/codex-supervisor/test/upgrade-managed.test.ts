import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runInstallCommand } from "../src/commands/install.js";
import { runUpgradeManagedCommand } from "../src/commands/upgrade-managed.js";
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
      managed_files: Array<{ path: string; template_id: string; installed_hash: string; last_reconciled_product_version: string }>;
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
      managed_files: Array<{ path: string; template_id: string; installed_hash: string; last_reconciled_product_version: string }>;
    };

    expect(updatedReview).toContain("Review checks passed.");
    expect(updatedSettings.custom_note).toBe("keep me");
    expect(updatedSettings.auto_continue_within_goal).toBe(true);
    expect(updatedSettings.block_on_major_decision).toBe(true);
    expect(updatedState.cycle_status).toBe("blocked");
    expect(updatedInstall.product_version).toBe("0.1.0");
    expect(updatedInstall.managed_files.find((item) => item.path === "scripts/review.ps1")?.last_reconciled_product_version).toBe("0.1.0");
    expect(updatedInstall.managed_files.find((item) => item.path === "autonomy/settings.json")?.last_reconciled_product_version).toBe("0.1.0");
  });
});
