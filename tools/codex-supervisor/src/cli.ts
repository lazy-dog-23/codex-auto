#!/usr/bin/env node

import { Command } from "commander";

import { registerApproveProposalCommand } from "./commands/approve-proposal.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEmitAutomationPromptsCommand } from "./commands/emit-automation-prompts.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerIntakeGoalCommand } from "./commands/intake-goal.js";
import { registerMergeAutonomyBranchCommand } from "./commands/merge-autonomy-branch.js";
import { registerPauseCommand } from "./commands/pause.js";
import { registerPrepareWorktreeCommand } from "./commands/prepare-worktree.js";
import { registerReportCommand } from "./commands/report.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSetRunModeCommand } from "./commands/set-run-mode.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUnblockCommand } from "./commands/unblock.js";
import { toCliError } from "./shared/errors.js";

async function main(): Promise<void> {
  const program = new Command();

  program.name("codex-autonomy").description("Repo-local helper CLI for Codex autonomy scaffolding and checks");

  registerBootstrapCommand(program);
  registerInstallCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);
  registerIntakeGoalCommand(program);
  registerApproveProposalCommand(program);
  registerSetRunModeCommand(program);
  registerReviewCommand(program);
  registerReportCommand(program);
  registerPauseCommand(program);
  registerResumeCommand(program);
  registerMergeAutonomyBranchCommand(program);
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
