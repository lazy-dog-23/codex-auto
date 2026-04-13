import { Command } from "commander";

import type { CommandResult, GoalsDocument, ProposalsDocument, TasksDocument } from "../contracts/autonomy.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { appendJournalEntry } from "../infra/journal.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { completeCurrentGoalIfEligible, materializeProposal, rebalanceTaskWindow } from "../domain/autonomy.js";
import {
  getActiveGoal,
  getAwaitingProposalGoal,
  loadGoalsDocument,
  loadProposalsDocument,
  loadResultsDocument,
  loadStateDocument,
  loadTasksDocument,
  persistGoalMirror,
  writeGoalsDocument,
  writeProposalsDocument,
  writeResultsDocument,
  writeStateDocument,
  writeTasksDocument,
} from "./control-plane.js";

export async function runApproveProposal(goalId: string | undefined, repoRoot = process.cwd()): Promise<CommandResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy approve-proposal");

  try {
    const now = new Date().toISOString();
    const goalsDoc = await loadGoalsDocument(paths);
    const proposalsDoc = await loadProposalsDocument(paths);
    const tasksDoc = await loadTasksDocument(paths);
    const state = await loadStateDocument(paths);
    const resultsDoc = await loadResultsDocument(paths);

    const targetGoal =
      (goalId ? goalsDoc.goals.find((goal) => goal.id === goalId) : null)
      ?? getAwaitingProposalGoal(goalsDoc.goals, proposalsDoc.proposals);

    if (!targetGoal) {
      throw new CliError("No awaiting proposal was found to approve.", CLI_EXIT_CODES.usage);
    }

    const materialized = materializeProposal(
      goalsDoc.goals,
      proposalsDoc.proposals,
      tasksDoc.tasks,
      state,
      targetGoal.id,
      now,
    );

    const rebalanced = rebalanceTaskWindow(materialized.tasks, {
      currentGoalId: materialized.state.current_goal_id,
    });
    const goalCompletion = completeCurrentGoalIfEligible(
      materialized.goals,
      rebalanced.tasks,
      {
        ...materialized.state,
        cycle_status: "idle",
        last_planner_run_at: now,
        last_result: "planned",
      },
      now,
    );

    const updatedTasks: TasksDocument = {
      ...tasksDoc,
      tasks: rebalanced.tasks,
    };
    const updatedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: goalCompletion.goals,
    };
    const updatedProposals: ProposalsDocument = {
      ...proposalsDoc,
      proposals: materialized.proposals,
    };
    const updatedState = {
      ...goalCompletion.state,
      cycle_status: "idle" as const,
      last_planner_run_at: now,
      last_result: "planned" as const,
    };
    const updatedResults = {
      ...resultsDoc,
      last_summary_kind: goalCompletion.completedGoalId && goalCompletion.activatedGoalId
        ? "goal_transition" as const
        : "normal_success" as const,
      last_summary_reason: goalCompletion.completedGoalId && goalCompletion.activatedGoalId
        ? "The previous goal completed and the next approved goal is active."
        : `Approved proposal for ${targetGoal.id} without switching to a new goal.`,
      latest_goal_transition: goalCompletion.completedGoalId && goalCompletion.activatedGoalId
        ? {
            from_goal_id: goalCompletion.completedGoalId,
            to_goal_id: goalCompletion.activatedGoalId,
            happened_at: now,
          }
        : null,
      planner: {
        ...resultsDoc.planner,
        status: "planned" as const,
        goal_id: targetGoal.id,
        summary: `Approved proposal for ${targetGoal.id} and materialized ${materialized.tasks.filter((task) => task.goal_id === targetGoal.id).length} task(s).`,
        happened_at: now,
      },
    };

    await writeGoalsDocument(paths, updatedGoals);
    await writeProposalsDocument(paths, updatedProposals);
    await writeTasksDocument(paths, updatedTasks);
    await writeStateDocument(paths, updatedState);
    await writeResultsDocument(paths, updatedResults);
    await persistGoalMirror(paths, getActiveGoal(updatedGoals.goals, updatedState));
    await appendJournalEntry(paths.journalFile, {
      timestamp: now,
      actor: "supervisor",
      taskId: targetGoal.id,
      result: "planned",
      summary: `Approved proposal for ${targetGoal.id}; ready window now contains ${rebalanced.readyTaskIds.length} task(s).`,
      verify: "not run (codex-autonomy approve-proposal)",
      blocker: "none",
    });

    return {
      ok: true,
      message: `Approved proposal for ${targetGoal.id}.`,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerApproveProposalCommand(program: Command): void {
  program
    .command("approve-proposal")
    .option("--goal-id <goalId>", "Approve the proposal for a specific goal id")
    .description("Materialize the current proposal into tasks.json and activate or queue the goal")
    .action(async (options: { goalId?: string }) => {
      const result = await runApproveProposal(options.goalId);
      console.log(JSON.stringify(result, null, 2));
    });
}
