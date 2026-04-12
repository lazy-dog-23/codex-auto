#!/usr/bin/env node

import { Command } from "commander";

import { registerBootstrapCommand } from "./commands/bootstrap.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEmitAutomationPromptsCommand } from "./commands/emit-automation-prompts.js";
import { registerPrepareWorktreeCommand } from "./commands/prepare-worktree.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUnblockCommand } from "./commands/unblock.js";
import { toCliError } from "./shared/errors.js";

async function main(): Promise<void> {
  const program = new Command();

  program.name("codex-supervisor").description("Repo-local helper CLI for Codex autonomy scaffolding and checks");

  registerBootstrapCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);
  registerPrepareWorktreeCommand(program);
  registerEmitAutomationPromptsCommand(program);
  registerUnblockCommand(program);

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const cliError = toCliError(error);
    console.error(cliError.message);
    process.exitCode = cliError.exitCode;
  }
}

void main();
