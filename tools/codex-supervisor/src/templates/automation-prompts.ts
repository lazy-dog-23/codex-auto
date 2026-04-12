import type { AutomationPromptSpec, AutomationPromptsResult } from "../contracts/autonomy.js";

const PLANNER_CADENCE = "every 12 hours (2 runs/day)";
const WORKER_CADENCE = "every 2 hours";

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

export function buildPlannerAutomationPrompt(): string {
  return joinLines([
    "You are the Planner for the Windows-native Codex autonomy repo.",
    "",
    "Inputs you may read:",
    "- `autonomy/goal.md`",
    "- `autonomy/tasks.json`",
    "- `autonomy/state.json`",
    "- `autonomy/blockers.json`",
    "",
    "Your job is only to maintain the `queued` / `ready` window.",
    "",
    "Rules:",
    "- Keep at most 5 tasks in `ready`.",
    "- Use task priority, dependency satisfaction, and `updated_at` to choose which eligible tasks enter `ready`.",
    "- Never work on more than one task at a time.",
    "- Never change business code.",
    "- If anything is missing, ambiguous, or conflicting, write a blocker and stop.",
    "- Update only autonomy state files and `autonomy/journal.md`.",
    "- Never commit, push, or deploy.",
    "- If the background worktree is dirty or the run must pause for human review, stop immediately.",
  ]);
}

export function buildWorkerAutomationPrompt(): string {
  return joinLines([
    "You are the Worker for the Windows-native Codex autonomy repo.",
    "",
    "Your job is to take exactly one `ready` task and make the smallest useful change.",
    "",
    "Rules:",
    "- Select one `ready` task only.",
    "- Do not take a second task in the same run.",
    "- Make the smallest change that satisfies the acceptance criteria.",
    "- Run `scripts/verify.ps1` before you stop.",
    "- If verify fails once, mark the task `verify_failed` and increment `retry_count`.",
    "- If verify fails again, or the task is genuinely ambiguous, create a blocker and mark the task `blocked`.",
    "- If the background worktree is dirty or the run must pause for human review, stop immediately.",
    "- Update only the task state, blockers, state summary, and `autonomy/journal.md`.",
    "- Never commit, push, or deploy.",
  ]);
}

export function buildPlannerAutomationPromptSpec(): AutomationPromptSpec {
  return {
    name: "planner",
    cadence: PLANNER_CADENCE,
    prompt: buildPlannerAutomationPrompt(),
  };
}

export function buildWorkerAutomationPromptSpec(): AutomationPromptSpec {
  return {
    name: "worker",
    cadence: WORKER_CADENCE,
    prompt: buildWorkerAutomationPrompt(),
  };
}

export function buildAutomationPromptsResult(): AutomationPromptsResult {
  return {
    ok: true,
    message: "Automation prompt templates generated.",
    planner: buildPlannerAutomationPromptSpec(),
    worker: buildWorkerAutomationPromptSpec(),
  };
}

export function formatAutomationPromptsResult(result: AutomationPromptsResult): string {
  return joinLines([
    "Planner prompt",
    "--------------",
    result.planner.prompt,
    "",
    `Planner cadence: ${result.planner.cadence}`,
    "",
    "Worker prompt",
    "-------------",
    result.worker.prompt,
    "",
    `Worker cadence: ${result.worker.cadence}`,
  ]);
}
