import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildAutomationPromptsResult,
  buildPlannerAutomationPrompt,
  buildReporterAutomationPrompt,
  buildReviewerAutomationPrompt,
  buildSprintAutomationPrompt,
  buildWorkerAutomationPrompt,
  formatAutomationPromptsResult,
} from "../src/templates/automation-prompts.js";
import { runEmitAutomationPromptsCommand } from "../src/commands/emit-automation-prompts.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8").replace(/\r\n/g, "\n").trimEnd();
}

describe("automation prompts", () => {
  it("includes the planner constraints", () => {
    const prompt = buildPlannerAutomationPrompt();

    expect(prompt).toContain("maintain the proposal and task window");
    expect(prompt).toContain("autonomy/goals.json");
    expect(prompt).toContain("If a goal is still `awaiting_confirmation`");
    expect(prompt).toContain("Respect run mode: sprint means immediate kickoff plus a short heartbeat runner, cruise means scheduled cadence.");
  });

  it("includes the worker verify gate", () => {
    const prompt = buildWorkerAutomationPrompt();

    expect(prompt).toContain("Select one `ready` task only.");
    expect(prompt).toContain("Run `scripts/verify.ps1` before you stop.");
    expect(prompt).toContain("Run `scripts/review.ps1` after verify passes");
    expect(prompt).toContain("commit only to `codex/autonomy`");
    expect(prompt).toContain("mark the task `verify_failed`");
  });

  it("includes reviewer, reporter, and sprint prompts", () => {
    expect(buildReviewerAutomationPrompt()).toContain("mark it `followup_required`");
    expect(buildReviewerAutomationPrompt()).toContain("Important failures, blockers, and `review_pending` states must be reported to the thread immediately.");
    expect(buildReporterAutomationPrompt()).toContain("Keep detailed command traces, diffs, and run records in Inbox.");
    expect(buildSprintAutomationPrompt()).toContain("On each heartbeat, do one closed loop only: plan or rebalance, work one task, review, then report.");
  });

  it("renders the golden output", () => {
    const expected = readFixture("automation-prompts.expected.txt");
    const actual = formatAutomationPromptsResult(buildAutomationPromptsResult()).trimEnd();

    expect(actual).toBe(expected);
  });

  it("returns the same prompt bundle from the command helper", async () => {
    const result = await runEmitAutomationPromptsCommand();

    expect(result.ok).toBe(true);
    expect(result.planner.name).toBe("planner-cruise");
    expect(result.planner.cadence).toBe("every 6 hours");
    expect(result.worker.cadence).toBe("every 2 hours");
    expect(result.reviewer.name).toBe("reviewer-cruise");
    expect(result.reporter.name).toBe("reporter");
    expect(result.sprint.name).toBe("sprint");
    expect(formatAutomationPromptsResult(result).trimEnd()).toBe(readFixture("automation-prompts.expected.txt"));
  });
});
