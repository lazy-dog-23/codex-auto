import { Command } from "commander";

import type { ExtendedAutomationPromptsResult } from "../templates/automation-prompts.js";
import { buildAutomationPromptsResult, formatAutomationPromptsResult } from "../templates/automation-prompts.js";

export async function runEmitAutomationPromptsCommand(): Promise<ExtendedAutomationPromptsResult> {
  return buildAutomationPromptsResult();
}

export function registerEmitAutomationPromptsCommand(program: Command): void {
  program
    .command("emit-automation-prompts")
    .description("Emit official thread automation, relay fallback, and role prompt templates")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await runEmitAutomationPromptsCommand();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(formatAutomationPromptsResult(result));
    });
}
