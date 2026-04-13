import { Command } from "commander";

import type {
  CommandResult,
  GoalRecord,
  GoalsDocument,
  ProposedTask,
  ProposalsDocument,
} from "../contracts/autonomy.js";
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

    const tasks = buildFallbackProposalTasks(targetGoal);
    const summary = buildFallbackSummary(targetGoal, tasks.length);
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
      last_summary_reason: `Generated fallback proposal for ${targetGoal.id} without materializing tasks.json.`,
      latest_goal_transition: null,
      planner: {
        ...resultsDoc.planner,
        status: "planned" as const,
        goal_id: targetGoal.id,
        task_id: null,
        summary: `Generated fallback proposal for ${targetGoal.id} with ${tasks.length} task(s).`,
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
      summary: `Generated fallback proposal with ${tasks.length} task(s): ${summary}.`,
      verify: "not run (codex-autonomy generate-proposal)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Generated proposal for ${targetGoal.id} with ${tasks.length} task(s).`,
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

function buildFallbackProposalTasks(goal: GoalRecord): ProposedTask[] {
  const tasks: ProposedTask[] = [];

  addTask(tasks, goal, "objective", "Clarify and scope the goal objective", [
    `Objective: ${goal.objective}`,
  ]);

  if (goal.success_criteria.length > 0) {
    addTask(tasks, goal, "criteria", "Implement the recorded success criteria", goal.success_criteria.map((item) => `Success criterion: ${item}`));
  }

  if (goal.constraints.length > 0) {
    addTask(tasks, goal, "constraints", "Respect the recorded constraints", goal.constraints.map((item) => `Constraint: ${item}`));
  }

  if (goal.out_of_scope.length > 0) {
    addTask(tasks, goal, "scope", "Keep out-of-scope work out of the plan", goal.out_of_scope.map((item) => `Out of scope: ${item}`));
  }

  addTask(tasks, goal, "verify", "Verify the proposal before task materialization", [
    "The proposal can be reviewed without writing tasks.json.",
  ]);

  return tasks.slice(0, 5);
}

function addTask(
  tasks: ProposedTask[],
  goal: GoalRecord,
  key: string,
  title: string,
  acceptance: string[],
): void {
  const previousTaskId = tasks.at(-1)?.id ?? null;
  tasks.push({
    id: buildProposalTaskId(goal.id, key),
    title,
    priority: tasks.length === 0 ? "P0" : "P1",
    depends_on: previousTaskId ? [previousTaskId] : [],
    acceptance: dedupeNonEmptyStrings(acceptance),
    file_hints: [],
  });
}

function buildProposalTaskId(goalId: string, key: string): string {
  return `proposal-${slugify(goalId)}-${key}`;
}

function buildFallbackSummary(goal: GoalRecord, taskCount: number): string {
  const sections = ["objective"];
  if (goal.success_criteria.length > 0) {
    sections.push("success criteria");
  }
  if (goal.constraints.length > 0) {
    sections.push("constraints");
  }
  if (goal.out_of_scope.length > 0) {
    sections.push("out-of-scope notes");
  }

  return `Fallback proposal derived from ${joinSections(sections)} and expanded into ${taskCount} task(s).`;
}

function joinSections(sections: string[]): string {
  if (sections.length === 1) {
    return sections[0] ?? "the recorded goal";
  }

  const head = sections.slice(0, -1);
  const tail = sections.at(-1);
  return `${head.join(", ")} and ${tail}`;
}

function dedupeNonEmptyStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : "goal";
}
