import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type {
  InstallDocument,
  AutonomyResults,
  AutonomySettings,
  AutonomyState,
  BlockersDocument,
  ControlPlanePendingOperation,
  DecisionPolicyDocument,
  GoalRecord,
  GoalsDocument,
  ProposedTask,
  ProposalsDocument,
  RepoPaths,
  ResultEntry,
  RunMode,
  SlicesDocument,
  TasksDocument,
  VerificationDocument,
} from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
} from "../contracts/autonomy.js";
import { loadJsonFile, pathExists, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { createDefaultAutonomySettings, createDefaultDecisionPolicyDocument } from "../shared/policy.js";
import { PRODUCT_VERSION } from "../shared/product.js";

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
    next_step_summary: null,
    continuation_decision: null,
    verification_pending_axes: null,
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

export function createDefaultSlicesDocument(): SlicesDocument {
  return {
    version: 1,
    slices: [],
  };
}

export function createDefaultSettingsDocument(): AutonomySettings {
  return createDefaultAutonomySettings();
}

export function createDefaultInstallDocument(now: string, sourceRepo: string): InstallDocument {
  return {
    version: 1,
    product_version: PRODUCT_VERSION,
    installed_at: now,
    managed_paths: [],
    managed_files: [],
    source_repo: sourceRepo,
  };
}

export function createDefaultVerificationDocument(): VerificationDocument {
  return {
    version: 1,
    goal_id: null,
    policy: "strong_template",
    axes: [],
  };
}

export function createDefaultDecisionPolicy(): DecisionPolicyDocument {
  return createDefaultDecisionPolicyDocument();
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
  slices?: ProposalsDocument["proposals"][number]["slices"];
  now: string;
}): ProposalsDocument["proposals"][number] {
  return {
    goal_id: input.goalId,
    status: "awaiting_confirmation",
    summary: input.summary.trim(),
    slices: input.slices?.map((slice) => ({
      id: slice.id,
      title: slice.title,
      objective: slice.objective,
      acceptance: [...slice.acceptance],
      file_hints: [...slice.file_hints],
    })),
    tasks: input.tasks.map((task) => ({
      id: task.id,
      slice_id: task.slice_id ?? null,
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

export async function loadSlicesDocument(paths: RepoPaths): Promise<SlicesDocument> {
  return loadOptionalJson(paths.slicesFile, createDefaultSlicesDocument);
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

export async function loadVerificationDocument(paths: RepoPaths): Promise<VerificationDocument> {
  return loadOptionalJson(paths.verificationFile, createDefaultVerificationDocument);
}

export async function loadDecisionPolicyDocument(paths: RepoPaths): Promise<DecisionPolicyDocument> {
  return loadOptionalJson(paths.decisionPolicyFile, createDefaultDecisionPolicy);
}

export async function loadPendingOperation(paths: RepoPaths): Promise<ControlPlanePendingOperation | null> {
  if (!(await pathExists(paths.pendingOperationFile))) {
    return null;
  }

  return validatePendingOperation(await loadJsonFile<unknown>(paths.pendingOperationFile));
}

export async function writePendingOperation(paths: RepoPaths, operation: ControlPlanePendingOperation): Promise<void> {
  await writeJsonAtomic(paths.pendingOperationFile, operation);
}

export async function clearPendingOperation(paths: RepoPaths): Promise<void> {
  await rm(paths.pendingOperationFile, { force: true });
}

function validatePendingOperation(value: unknown): ControlPlanePendingOperation {
  const operation = requireRecord(value, "pending control-plane operation");
  if (operation.version !== 1) {
    throw new Error("Invalid pending control-plane operation: version must be 1.");
  }
  if (operation.kind !== "create_successor_goal" && operation.kind !== "quick") {
    throw new Error("Invalid pending control-plane operation: kind must be create_successor_goal or quick.");
  }

  for (const key of ["id", "created_at", "updated_at", "command", "goal_id"] as const) {
    requireString(operation[key], `pending control-plane operation ${key}`);
  }
  if (operation.kind === "create_successor_goal") {
    requireString(operation.source_goal_id, "pending control-plane operation source_goal_id");
    if (operation.command !== "codex-autonomy create-successor-goal") {
      throw new Error("Invalid pending control-plane operation: command must be codex-autonomy create-successor-goal.");
    }
  } else {
    if (operation.source_goal_id !== null) {
      throw new Error("Invalid pending control-plane operation: quick source_goal_id must be null.");
    }
    if (operation.command !== "codex-autonomy quick") {
      throw new Error("Invalid pending control-plane operation: command must be codex-autonomy quick.");
    }
    if (operation.auto_approved !== true) {
      throw new Error("Invalid pending control-plane operation: quick auto_approved must be true.");
    }
  }
  if (typeof operation.auto_approved !== "boolean") {
    throw new Error("Invalid pending control-plane operation: auto_approved must be a boolean.");
  }
  requireStringArray(operation.task_ids, "pending control-plane operation task_ids");
  requireStringArray(operation.expected_paths, "pending control-plane operation expected_paths");

  const payload = requireRecord(operation.payload, "pending control-plane operation payload");
  for (const key of ["goals", "proposals", "state", "results", "journal_entry"] as const) {
    requireRecord(payload[key], `pending control-plane operation payload.${key}`);
  }
  if (operation.kind === "quick" || operation.auto_approved) {
    requireRecord(payload.tasks, "pending control-plane operation payload.tasks");
    requireRecord(payload.verification, "pending control-plane operation payload.verification");
  }
  if (operation.kind === "quick") {
    requireRecord(payload.slices, "pending control-plane operation payload.slices");
  }
  if (payload.slices !== null && payload.slices !== undefined) {
    requireRecord(payload.slices, "pending control-plane operation payload.slices");
  }
  if (payload.active_goal_id !== null && typeof payload.active_goal_id !== "string") {
    throw new Error("Invalid pending control-plane operation: payload.active_goal_id must be a string or null.");
  }

  return operation as unknown as ControlPlanePendingOperation;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string.`);
  }
}

function requireStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid ${label}: expected string array.`);
  }
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

export async function writeSlicesDocument(paths: RepoPaths, document: SlicesDocument): Promise<void> {
  await writeJsonAtomic(paths.slicesFile, document);
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

export async function writeVerificationDocument(paths: RepoPaths, document: VerificationDocument): Promise<void> {
  await writeJsonAtomic(paths.verificationFile, document);
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
