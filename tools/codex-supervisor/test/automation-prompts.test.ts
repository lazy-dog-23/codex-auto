import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildAutomationPromptsResult,
  buildExternalRelaySchedulerPrompt,
  buildOfficialThreadAutomationPrompt,
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
    expect(prompt).toContain("autonomy/verification.json");
    expect(prompt).toContain("If `sprint_active=true`, do nothing for this run");
    expect(prompt).toContain("If a goal is still `awaiting_confirmation`");
    expect(prompt).toContain("Safe follow-ups within the approved goal must auto-continue");
    expect(prompt).toContain("required verification axis is still pending");
    expect(prompt).toContain("Respect run mode: sprint means immediate kickoff plus a budgeted multi-loop heartbeat runner, cruise means scheduled cadence.");
    expect(prompt).toContain("next-step suggestion");
  });

  it("includes the worker verify gate", () => {
    const prompt = buildWorkerAutomationPrompt();

    expect(prompt).toContain("Select one `ready` task only.");
    expect(prompt).toContain("leave execution to the sprint runner");
    expect(prompt).toContain("Run `scripts/verify.ps1` before you stop.");
    expect(prompt).toContain("run `codex-autonomy review` as the closeout gate");
    expect(prompt).toContain("autonomy/verification.json");
    expect(prompt).toContain("attempts the controlled autonomy closeout commit on `codex/autonomy`");
    expect(prompt).toContain("mark the task `verify_failed`");
  });

  it("includes reviewer, reporter, and sprint prompts", () => {
    expect(buildReviewerAutomationPrompt()).toContain("mark it `followup_required`");
    expect(buildReviewerAutomationPrompt()).toContain("Read `autonomy/verification.json`");
    expect(buildReviewerAutomationPrompt()).toContain("Run `codex-autonomy review` after the worker's verify gate has passed.");
    expect(buildReviewerAutomationPrompt()).toContain("pending verification axis ids");
    expect(buildReviewerAutomationPrompt()).toContain("next-step suggestion that the planner or sprint runner can auto-continue without thread confirmation");
    expect(buildReviewerAutomationPrompt()).toContain("leave review to the sprint runner");
    expect(buildReviewerAutomationPrompt()).toContain("Important failures, blockers, and `review_pending` states must be reported to the thread immediately.");
    expect(buildReporterAutomationPrompt()).toContain("sole operator-facing surface");
    expect(buildReporterAutomationPrompt()).toContain("pending verification axes");
    expect(buildReporterAutomationPrompt()).toContain("why the loop is idle or not ready");
    expect(buildReporterAutomationPrompt()).toContain("commit failures to the thread immediately");
    expect(buildReporterAutomationPrompt()).toContain("do not block execution on a thread reply");
    expect(buildReporterAutomationPrompt()).toContain("Send successful runs only as heartbeat summaries");
    expect(buildReporterAutomationPrompt()).toContain("Do not flood the thread with routine success updates");
    expect(buildSprintAutomationPrompt()).toContain("perform a status check, report, then stop");
    expect(buildSprintAutomationPrompt()).toContain("do not overlap with the cruise planner, worker, or reviewer");
    expect(buildSprintAutomationPrompt()).toContain("autonomy/verification.json");
    expect(buildSprintAutomationPrompt()).toContain("Keep the run budgeted: no more than 3 closed loops or 25 minutes, whichever comes first.");
    expect(buildSprintAutomationPrompt()).toContain("If the current goal is completed and a next approved goal exists, switch to that goal and kickoff immediately in the same run.");
    expect(buildSprintAutomationPrompt()).toContain("Even after a goal switch, continue only while the run budget remains and the next work still belongs to an approved goal.");
    expect(buildSprintAutomationPrompt()).toContain("auto-continue by feeding it into the next loop instead of waiting for thread confirmation");
    expect(buildSprintAutomationPrompt()).toContain("verification is the only remaining gap");
    expect(buildSprintAutomationPrompt()).toContain("successful cycles can be batched into heartbeat summaries and do not need to wait for a thread reply");
    expect(buildSprintAutomationPrompt()).toContain("suggested next step would change acceptance");
    expect(buildSprintAutomationPrompt()).toContain("commit failures must be reported immediately");
  });

  it("includes official thread automation and relay fallback prompts", () => {
    const officialPrompt = buildOfficialThreadAutomationPrompt();
    const relayPrompt = buildExternalRelaySchedulerPrompt();

    expect(officialPrompt).toContain("official Codex thread automation wake-up");
    expect(officialPrompt).toContain("thread_binding_state");
    expect(officialPrompt).toContain("bound_to_current");
    expect(officialPrompt).toContain("codex-autonomy status");
    expect(officialPrompt).toContain("Do not use relay as the main control path");
    expect(officialPrompt).toContain("in-app browser");

    expect(relayPrompt).toContain("external scheduler wake-up through the relay fallback path");
    expect(relayPrompt).toContain("scripts/verify.ps1");
    expect(relayPrompt).toContain("codex-autonomy review");
    expect(relayPrompt).toContain("thread_binding_state");
    expect(relayPrompt).toContain("bound_to_current");
    expect(relayPrompt).toContain("Treat official Codex thread automations as the preferred same-thread continuation surface.");
  });

  it("renders the golden output", () => {
    const expected = readFixture("automation-prompts.expected.txt");
    const actual = formatAutomationPromptsResult(buildAutomationPromptsResult()).trimEnd();

    expect(actual).toBe(expected);
  });

  it("returns the same prompt bundle from the command helper", async () => {
    const result = await runEmitAutomationPromptsCommand();

    expect(result.ok).toBe(true);
    expect(result.official_thread_automation.name).toBe("official-thread-automation");
    expect(result.external_relay_scheduler.name).toBe("external-relay-scheduler");
    expect(result.official_thread_automation.cadence).toBe("every 15 minutes while sprint is active");
    expect(result.planner.name).toBe("planner-cruise");
    expect(result.planner.cadence).toBe("every 6 hours");
    expect(result.worker.cadence).toBe("every 2 hours");
    expect(result.reviewer.name).toBe("reviewer-cruise");
    expect(result.reporter.name).toBe("reporter");
    expect(result.sprint.name).toBe("sprint");
    expect(formatAutomationPromptsResult(result).trimEnd()).toBe(readFixture("automation-prompts.expected.txt"));
  });
});
