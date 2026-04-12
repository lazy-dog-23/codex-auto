import { Command } from "commander";

import type { AutomationPromptsResult } from "../contracts/autonomy.js";
import { buildAutomationPromptsResult, formatAutomationPromptsResult } from "../templates/automation-prompts.js";

export async function runEmitAutomationPromptsCommand(): Promise<AutomationPromptsResult> {
  return buildAutomationPromptsResult();
}

export function registerEmitAutomationPromptsCommand(program: Command): void {
  program
    .command("emit-automation-prompts")
    .description("Emit planner and worker automation prompt templates")
    .action(async () => {
      const result = await runEmitAutomationPromptsCommand();
      console.log(formatAutomationPromptsResult(result));
    });
}
