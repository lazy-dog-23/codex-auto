import { Command } from "commander";

import type { ExtendedAutomationPromptsResult } from "../templates/automation-prompts.js";
import { buildAutomationPromptsResult, formatAutomationPromptsResult } from "../templates/automation-prompts.js";

export async function runEmitAutomationPromptsCommand(): Promise<ExtendedAutomationPromptsResult> {
  return buildAutomationPromptsResult();
}

export function registerEmitAutomationPromptsCommand(program: Command): void {
  program
    .command("emit-automation-prompts")
    .description("Emit planner, worker, reviewer, reporter, and sprint automation prompt templates")
    .action(async () => {
      const result = await runEmitAutomationPromptsCommand();
      console.log(formatAutomationPromptsResult(result));
    });
}
