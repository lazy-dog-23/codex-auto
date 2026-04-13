import { Command } from "commander";

import type {
  CommandResult,
  GoalRecord,
  GoalsDocument,
  ProposalsDocument,
} from "../contracts/autonomy.js";
import { buildRepoAwareFallbackProposal } from "../domain/proposal.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import {
  buildProposalFromTasks,
  loadGoalsDocument,
  loadProposalsDocument,
  loadResultsDocument,
  writeProposalsDocument,
  writeResultsDocument,
} from "./control-plane.js";

interface GenerateProposalOptions {
  goalId?: string;
}

export async function runGenerateProposal(
  options: GenerateProposalOptions = {},
  repoRoot = process.cwd(),
): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy generate-proposal");

  try {
    const now = new Date().toISOString();
    const goalsDoc = await loadGoalsDocument(paths);
    const proposalsDoc = await loadProposalsDocument(paths);
    const resultsDoc = await loadResultsDocument(paths);

    const targetGoal = resolveTargetGoal(goalsDoc, proposalsDoc, options.goalId);
    if (!targetGoal) {
      throw new CliError("No awaiting_confirmation goal was found to generate a proposal for.", CLI_EXIT_CODES.usage);
    }

    if (proposalsDoc.proposals.some((proposal) => proposal.goal_id === targetGoal.id && proposal.status === "awaiting_confirmation")) {
      throw new CliError(
        `Goal ${targetGoal.id} already has an awaiting_confirmation proposal.`,
        CLI_EXIT_CODES.validation,
      );
    }

    const proposalPlan = await buildRepoAwareFallbackProposal(targetGoal, paths.repoRoot);
    const tasks = proposalPlan.tasks;
    const summary = proposalPlan.summary;
    const proposal = buildProposalFromTasks({
      goalId: targetGoal.id,
      summary,
      tasks,
      now,
    });

    const updatedProposals: ProposalsDocument = {
      ...proposalsDoc,
      proposals: [...proposalsDoc.proposals, proposal],
    };
    const updatedResults = {
      ...resultsDoc,
      last_inbox_run_at: now,
      last_summary_kind: "normal_success" as const,
      last_summary_reason: `Generated repo-aware fallback proposal for ${targetGoal.id} without materializing tasks.json. Validation focus: ${proposalPlan.signals.preferred_validation_action}.`,
      latest_goal_transition: null,
      planner: {
        ...resultsDoc.planner,
        status: "planned" as const,
        goal_id: targetGoal.id,
        task_id: null,
        summary: `Generated repo-aware fallback proposal for ${targetGoal.id} with ${tasks.length} task(s) and ${proposalPlan.signals.preferred_validation_action} validation focus.`,
        happened_at: now,
        sent_at: null,
        verify_summary: null,
        hash: null,
        message: null,
        review_status: null,
      },
    };

    await writeProposalsDocument(paths, updatedProposals);
    await writeResultsDocument(paths, updatedResults);
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: targetGoal.id,
      result: "planned",
      summary: `Generated repo-aware fallback proposal with ${tasks.length} task(s) and ${proposalPlan.signals.preferred_validation_action} validation focus: ${summary}.`,
      verify: "not run (codex-autonomy generate-proposal)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Generated repo-aware proposal for ${targetGoal.id} with ${tasks.length} task(s); validation focus: ${proposalPlan.signals.preferred_validation_action}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerGenerateProposalCommand(program: Command): void {
  program
    .command("generate-proposal")
    .option("--goal-id <goalId>", "Generate a proposal for a specific goal id")
    .description("Generate a conservative fallback proposal for an awaiting_confirmation goal")
    .action(async (options: GenerateProposalOptions) => {
      const result = await runGenerateProposal(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function resolveTargetGoal(
  goalsDoc: GoalsDocument,
  proposalsDoc: ProposalsDocument,
  goalId: string | undefined,
): GoalRecord | null {
  if (goalId?.trim()) {
    const target = goalsDoc.goals.find((goal) => goal.id === goalId.trim()) ?? null;
    if (!target) {
      throw new CliError(`Goal not found: ${goalId.trim()}`, CLI_EXIT_CODES.validation);
    }

    if (target.status !== "awaiting_confirmation") {
      throw new CliError(
        `Goal ${target.id} must be awaiting_confirmation before a proposal can be generated.`,
        CLI_EXIT_CODES.validation,
      );
    }

    if (proposalsDoc.proposals.some((proposal) => proposal.goal_id === target.id && proposal.status === "awaiting_confirmation")) {
      throw new CliError(
        `Goal ${target.id} already has an awaiting_confirmation proposal.`,
        CLI_EXIT_CODES.validation,
      );
    }

    return target;
  }

  const proposedGoalIds = new Set(
    proposalsDoc.proposals
      .filter((proposal) => proposal.status === "awaiting_confirmation")
      .map((proposal) => proposal.goal_id),
  );
  const target = [...goalsDoc.goals]
    .filter((goal) => goal.status === "awaiting_confirmation" && !proposedGoalIds.has(goal.id))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))[0] ?? null;
  if (!target) {
    return null;
  }

  return target;
}
