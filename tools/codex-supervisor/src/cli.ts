#!/usr/bin/env node

import { Command } from "commander";

import { registerApproveProposalCommand } from "./commands/approve-proposal.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
import { registerBindThreadCommand } from "./commands/bind-thread.js";
import { registerCreateSuccessorGoalCommand } from "./commands/create-successor-goal.js";
import { registerDecideCommand } from "./commands/decide.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEmitAutomationPromptsCommand } from "./commands/emit-automation-prompts.js";
import { registerGenerateProposalCommand } from "./commands/generate-proposal.js";
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
import { registerRebaselineManagedCommand, registerUpgradeManagedCommand } from "./commands/upgrade-managed.js";
import { toCliError } from "./shared/errors.js";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./shared/product.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name(PRODUCT_NAME)
    .description("Repo-local helper CLI for Codex autonomy scaffolding and checks")
    .version(PRODUCT_VERSION);

  registerBootstrapCommand(program);
  registerInstallCommand(program);
  registerBindThreadCommand(program);
  registerDecideCommand(program);
  registerDoctorCommand(program);
  registerStatusCommand(program);
  registerIntakeGoalCommand(program);
  registerGenerateProposalCommand(program);
  registerApproveProposalCommand(program);
  registerCreateSuccessorGoalCommand(program);
  registerSetRunModeCommand(program);
  registerReviewCommand(program);
  registerReportCommand(program);
  registerPauseCommand(program);
  registerResumeCommand(program);
  registerMergeAutonomyBranchCommand(program);
  registerPrepareWorktreeCommand(program);
  registerUpgradeManagedCommand(program);
  registerRebaselineManagedCommand(program);
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
