import { Command } from "commander";

import type { CommandResult, GoalsDocument, RunMode } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveReportThreadBinding } from "../shared/thread-context.js";
import {
  createGoalRecord,
  loadGoalsDocument,
  loadStateDocument,
  writeGoalsDocument,
  writeStateDocument,
} from "./control-plane.js";

interface IntakeGoalOptions {
  title?: string;
  objective?: string;
  successCriteria?: string[];
  constraint?: string[];
  outOfScope?: string[];
  runMode?: string;
  reportThreadId?: string;
}

export async function runIntakeGoal(options: IntakeGoalOptions, repoRoot = process.cwd()): Promise<CommandResult> {
  const title = options.title?.trim();
  const objective = options.objective?.trim();
  const successCriteria = normalizeList(options.successCriteria);
  const constraints = normalizeList(options.constraint);
  const outOfScope = normalizeList(options.outOfScope);
  const runMode = normalizeRunMode(options.runMode);

  if (!title || !objective || successCriteria.length === 0 || !runMode) {
    throw new CliError(
      "intake-goal requires --title, --objective, at least one --success-criteria, and --run-mode sprint|cruise.",
      CLI_EXIT_CODES.usage,
    );
  }

  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy intake-goal");

  try {
    const now = new Date().toISOString();
    const goalsDoc = await loadGoalsDocument(paths);
    const state = await loadStateDocument(paths);
    const resolvedBinding = resolveReportThreadBinding({
      explicitReportThreadId: options.reportThreadId,
      existingReportThreadId: state.report_thread_id,
    });
    const reportThreadId = resolvedBinding.reportThreadId;

    if (!reportThreadId) {
      throw new CliError(
        "Current thread identity is unavailable in this environment. Run codex-autonomy bind-thread --report-thread-id <id> before intake-goal.",
        CLI_EXIT_CODES.usage,
      );
    }

    if (!options.reportThreadId?.trim() && resolvedBinding.threadContext.bindingState === "bound_to_other") {
      throw new CliError(
        resolvedBinding.threadContext.bindingHint
        ?? "Current thread does not match the bound report_thread_id. Continue from the bound thread or rebind explicitly.",
        CLI_EXIT_CODES.blocked,
      );
    }

    const goal = createGoalRecord({
      title,
      objective,
      successCriteria,
      constraints,
      outOfScope,
      runMode,
      now,
    });

    const updatedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: [...goalsDoc.goals, goal],
    };
    const updatedState = {
      ...state,
      report_thread_id: reportThreadId,
      last_result: "planned" as const,
    };

    await writeGoalsDocument(paths, updatedGoals);
    await writeStateDocument(paths, updatedState);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: goal.id,
      result: "planned",
      summary: `Intake goal ${goal.id} (${goal.run_mode}) and wait for codex-autonomy generate-proposal or planner proposal generation.`,
      verify: "not run (codex-autonomy intake-goal)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Goal ${goal.id} recorded and is awaiting proposal generation. Run codex-autonomy generate-proposal for a local fallback, or let Planner create the proposal.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerIntakeGoalCommand(program: Command): void {
  program
    .command("intake-goal")
    .requiredOption("--title <title>", "Goal title")
    .requiredOption("--objective <objective>", "Goal objective")
    .requiredOption("--success-criteria <item...>", "Success criteria entries")
    .option("--constraint <item...>", "Constraint entries")
    .option("--out-of-scope <item...>", "Out-of-scope entries")
    .requiredOption("--run-mode <mode>", "Goal run mode: sprint or cruise")
    .option("--report-thread-id <id>", "Report back to this thread id")
    .description("Normalize a new goal into goals.json and wait for a proposal confirmation cycle")
    .action(async (options: IntakeGoalOptions) => {
      const result = await runIntakeGoal(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function normalizeList(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function normalizeRunMode(value: string | undefined): RunMode | null {
  if (value === "sprint" || value === "cruise") {
    return value;
  }

  return null;
}
