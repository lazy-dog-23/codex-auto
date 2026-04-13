import { randomUUID } from "node:crypto";

import type {
  AutonomyResults,
  AutonomySettings,
  AutonomyState,
  BlockersDocument,
  GoalRecord,
  GoalsDocument,
  ProposedTask,
  ProposalsDocument,
  RepoPaths,
  ResultEntry,
  RunMode,
  TasksDocument,
} from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
} from "../contracts/autonomy.js";
import { loadJsonFile, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { createDefaultAutonomySettings } from "../shared/policy.js";

function emptyResultEntry(): ResultEntry {
  return {
    status: "not_run",
    goal_id: null,
    task_id: null,
    summary: null,
    happened_at: null,
    sent_at: null,
    verify_summary: null,
    hash: null,
    message: null,
    review_status: null,
  };
}

export function createDefaultGoalsDocument(): GoalsDocument {
  return {
    version: 1,
    goals: [],
  };
}

export function createDefaultProposalsDocument(): ProposalsDocument {
  return {
    version: 1,
    proposals: [],
  };
}

export function createDefaultSettingsDocument(): AutonomySettings {
  return createDefaultAutonomySettings();
}

export function createDefaultResultsDocument(): AutonomyResults {
  return {
    version: 1,
    last_thread_summary_sent_at: null,
    last_inbox_run_at: null,
    last_summary_kind: null,
    last_summary_reason: null,
    latest_goal_transition: null,
    planner: emptyResultEntry(),
    worker: emptyResultEntry(),
    review: emptyResultEntry(),
    commit: emptyResultEntry(),
    reporter: emptyResultEntry(),
  };
}

export function createDefaultState(): AutonomyState {
  return {
    version: 1,
    current_goal_id: null,
    current_task_id: null,
    cycle_status: "idle",
    run_mode: null,
    last_planner_run_at: null,
    last_worker_run_at: null,
    last_result: "noop",
    consecutive_worker_failures: 0,
    needs_human_review: false,
    open_blocker_count: 0,
    report_thread_id: null,
    autonomy_branch: DEFAULT_AUTONOMY_BRANCH,
    sprint_active: false,
    paused: false,
    pause_reason: null,
    last_thread_summary_sent_at: null,
    last_inbox_run_at: null,
  };
}

export function createGoalRecord(input: {
  title: string;
  objective: string;
  successCriteria: string[];
  constraints: string[];
  outOfScope: string[];
  runMode: RunMode;
  now: string;
}): GoalRecord {
  return {
    id: buildGoalId(input.title),
    title: input.title.trim(),
    objective: input.objective.trim(),
    success_criteria: input.successCriteria.map((item) => item.trim()).filter(Boolean),
    constraints: input.constraints.map((item) => item.trim()).filter(Boolean),
    out_of_scope: input.outOfScope.map((item) => item.trim()).filter(Boolean),
    status: "awaiting_confirmation",
    run_mode: input.runMode,
    created_at: input.now,
    approved_at: null,
    completed_at: null,
  };
}

export function formatGoalMarkdown(goal: GoalRecord | null): string {
  if (!goal) {
    return [
      "# Objective",
      "",
      "No active goal.",
      "",
      "## Success Criteria",
      "",
      "- None.",
      "",
      "## Constraints",
      "",
      "- None.",
      "",
      "## Out of Scope",
      "",
      "- None.",
      "",
    ].join("\n");
  }

  return [
    "# Objective",
    "",
    goal.objective,
    "",
    "## Success Criteria",
    "",
    ...toBulletLines(goal.success_criteria),
    "",
    "## Constraints",
    "",
    ...toBulletLines(goal.constraints),
    "",
    "## Out of Scope",
    "",
    ...toBulletLines(goal.out_of_scope),
    "",
  ].join("\n");
}

export function buildProposalFromTasks(input: {
  goalId: string;
  summary: string;
  tasks: ProposedTask[];
  now: string;
}): ProposalsDocument["proposals"][number] {
  return {
    goal_id: input.goalId,
    status: "awaiting_confirmation",
    summary: input.summary.trim(),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      depends_on: [...task.depends_on],
      acceptance: [...task.acceptance],
      file_hints: [...task.file_hints],
    })),
    created_at: input.now,
    approved_at: null,
  };
}

export async function loadGoalsDocument(paths: RepoPaths): Promise<GoalsDocument> {
  return loadOptionalJson(paths.goalsFile, createDefaultGoalsDocument);
}

export async function loadProposalsDocument(paths: RepoPaths): Promise<ProposalsDocument> {
  return loadOptionalJson(paths.proposalsFile, createDefaultProposalsDocument);
}

export async function loadTasksDocument(paths: RepoPaths): Promise<TasksDocument> {
  return loadJsonFile<TasksDocument>(paths.tasksFile);
}

export async function loadStateDocument(paths: RepoPaths): Promise<AutonomyState> {
  return loadOptionalJson(paths.stateFile, createDefaultState);
}

export async function loadBlockersDocument(paths: RepoPaths): Promise<BlockersDocument> {
  return loadJsonFile<BlockersDocument>(paths.blockersFile);
}

export async function loadSettingsDocument(paths: RepoPaths): Promise<AutonomySettings> {
  return loadOptionalJson(paths.settingsFile, createDefaultSettingsDocument);
}

export async function loadResultsDocument(paths: RepoPaths): Promise<AutonomyResults> {
  return loadOptionalJson(paths.resultsFile, createDefaultResultsDocument);
}

export async function persistGoalMirror(paths: RepoPaths, goal: GoalRecord | null): Promise<void> {
  await writeTextFileAtomic(paths.goalFile, formatGoalMarkdown(goal));
}

export async function writeGoalsDocument(paths: RepoPaths, document: GoalsDocument): Promise<void> {
  await writeJsonAtomic(paths.goalsFile, document);
}

export async function writeProposalsDocument(paths: RepoPaths, document: ProposalsDocument): Promise<void> {
  await writeJsonAtomic(paths.proposalsFile, document);
}

export async function writeStateDocument(paths: RepoPaths, document: AutonomyState): Promise<void> {
  await writeJsonAtomic(paths.stateFile, document);
}

export async function writeResultsDocument(paths: RepoPaths, document: AutonomyResults): Promise<void> {
  await writeJsonAtomic(paths.resultsFile, document);
}

export async function writeTasksDocument(paths: RepoPaths, document: TasksDocument): Promise<void> {
  await writeJsonAtomic(paths.tasksFile, document);
}

export function getActiveGoal(goals: readonly GoalRecord[], state: AutonomyState): GoalRecord | null {
  if (state.current_goal_id) {
    return goals.find((goal) => goal.id === state.current_goal_id) ?? null;
  }

  return goals.find((goal) => goal.status === "active") ?? null;
}

export function getGoalById(goals: readonly GoalRecord[], goalId: string): GoalRecord | null {
  return goals.find((goal) => goal.id === goalId) ?? null;
}

export function getAwaitingConfirmationGoal(goals: readonly GoalRecord[]): GoalRecord | null {
  return [...goals]
    .filter((goal) => goal.status === "awaiting_confirmation")
    .sort((left, right) => left.created_at.localeCompare(right.created_at))[0] ?? null;
}

export function getAwaitingProposalGoal(goals: readonly GoalRecord[], proposals: readonly ProposalsDocument["proposals"][number][]): GoalRecord | null {
  const proposalGoalIds = new Set(
    proposals
      .filter((proposal) => proposal.status === "awaiting_confirmation")
      .map((proposal) => proposal.goal_id),
  );

  return [...goals]
    .filter((goal) => goal.status === "awaiting_confirmation" && proposalGoalIds.has(goal.id))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))[0] ?? null;
}

async function loadOptionalJson<T>(filePath: string, factory: () => T): Promise<T> {
  try {
    return await loadJsonFile<T>(filePath);
  } catch (error) {
    if (error instanceof Error && /ENOENT/i.test(error.message)) {
      return factory();
    }
    throw error;
  }
}

function toBulletLines(items: readonly string[]): string[] {
  if (items.length === 0) {
    return ["- None."];
  }

  return items.map((item) => `- ${item}`);
}

function buildGoalId(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = randomUUID().slice(0, 8);
  return slug ? `goal-${slug}-${suffix}` : `goal-${suffix}`;
}
