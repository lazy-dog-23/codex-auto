import { Command } from "commander";

import type { AutonomyResults, GoalRecord, TaskRecord } from "../domain/types.js";
import { countOpenBlockers } from "../domain/autonomy.js";
import { detectGitRepository } from "../infra/git.js";
import { resolveRepoPaths } from "../shared/paths.js";
import {
  getActiveGoal,
  loadBlockersDocument,
  loadGoalsDocument,
  loadResultsDocument,
  loadStateDocument,
  loadTasksDocument,
} from "./control-plane.js";

export interface ReportResult {
  ok: boolean;
  message: string;
  current_goal: GoalRecord | null;
  current_task: TaskRecord | null;
  paused: boolean;
  pause_reason: string | null;
  run_mode: string | null;
  report_thread_id: string | null;
  blockers_open: number;
  latest_results: AutonomyResults;
}

export async function runReport(repoRoot = process.cwd()): Promise<ReportResult> {
  const gitRepo = await detectGitRepository(repoRoot);
  const paths = resolveRepoPaths(gitRepo?.path ?? repoRoot);
  const [goalsDoc, tasksDoc, state, blockersDoc, resultsDoc] = await Promise.all([
    loadGoalsDocument(paths),
    loadTasksDocument(paths),
    loadStateDocument(paths),
    loadBlockersDocument(paths),
    loadResultsDocument(paths),
  ]);

  const currentGoal = getActiveGoal(goalsDoc.goals, state);
  const currentTask = state.current_task_id
    ? tasksDoc.tasks.find((task) => task.id === state.current_task_id) ?? null
    : tasksDoc.tasks.find((task) => task.goal_id === state.current_goal_id && task.status === "ready") ?? null;
  const blockersOpen = countOpenBlockers(blockersDoc.blockers);
  const message = buildReportMessage(currentGoal, currentTask, state.paused, blockersOpen, resultsDoc);

  return {
    ok: true,
    message,
    current_goal: currentGoal,
    current_task: currentTask,
    paused: state.paused,
    pause_reason: state.pause_reason,
    run_mode: state.run_mode,
    report_thread_id: state.report_thread_id,
    blockers_open: blockersOpen,
    latest_results: resultsDoc,
  };
}

export function registerReportCommand(program: Command): void {
  program
    .command("report")
    .description("Summarize the current goal, task, results, and blocker state")
    .action(async () => {
      const result = await runReport();
      console.log(JSON.stringify(result, null, 2));
    });
}

function buildReportMessage(
  goal: GoalRecord | null,
  task: TaskRecord | null,
  paused: boolean,
  blockersOpen: number,
  results: AutonomyResults,
): string {
  const goalPart = goal ? `goal=${goal.id}` : "goal=none";
  const taskPart = task ? `task=${task.id}` : "task=none";
  const pausePart = paused ? "paused=yes" : "paused=no";
  const commitPart = results.commit.hash ? `commit=${results.commit.hash}` : "commit=none";
  return [goalPart, taskPart, pausePart, `open_blockers=${blockersOpen}`, commitPart].join(" ");
}
