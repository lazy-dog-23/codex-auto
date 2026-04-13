import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { detectCodexProcess as detectCodexProcessProbe, discoverPowerShellExecutable } from "../infra/process.js";
import { isDirectory, loadJsonFile, pathExists, writeJsonAtomic, writeTextFileAtomic } from "../infra/fs.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths, resolveRepoRoot } from "../shared/paths.js";
import {
  blockersSchema,
  goalsSchema,
  proposalsSchema,
  resultsSchema,
  settingsSchema,
  stateSchema,
  tasksSchema,
} from "../schemas/index.js";
import {
  getAgentsMarkdown,
  getAutonomyIntakeSkillMarkdown,
  getAutonomyPlanSkillMarkdown,
  getAutonomyReportSkillMarkdown,
  getAutonomyReviewSkillMarkdown,
  getAutonomySprintSkillMarkdown,
  getAutonomyWorkSkillMarkdown,
  getConfigTomlTemplate,
  getEnvironmentTomlTemplate,
  getInstallGoalMarkdown,
  getInstallVerifyScriptTemplate,
  getReviewScriptTemplate,
  getSetupWindowsScriptTemplate,
  getSmokeScriptTemplate,
  getDefaultJournalMarkdown,
} from "../scaffold/templates.js";
import {
  createDefaultGoalsDocument,
  createDefaultProposalsDocument,
  createDefaultResultsDocument,
  createDefaultSettingsDocument,
  createDefaultState,
} from "./control-plane.js";
import type {
  AutonomyResults,
  AutonomySettings,
  AutonomyState,
  BlockersDocument,
  GoalsDocument,
  ProposalsDocument,
  RunMode,
  TasksDocument,
} from "../contracts/autonomy.js";

const execFileAsync = promisify(execFile);
const LEGACY_GOAL_ID = "goal-legacy";

const DEFAULT_TASKS: TasksDocument = {
  version: 1,
  tasks: [],
};

const DEFAULT_BLOCKERS: BlockersDocument = {
  version: 1,
  blockers: [],
};

interface InstallOptions {
  target?: string;
}

interface InstallSummary {
  target_path: string;
  is_git_repo: boolean;
  automation_ready: boolean;
  codex_process_detected: boolean;
  background_worktree_prereqs: boolean;
  control_surface_files_created: number;
  next_automations: Array<{
    name: string;
    purpose: string;
  }>;
  warning: string | null;
  private_automation_storage_untouched: boolean;
}

interface InstallResult {
  ok: boolean;
  message: string;
  summary: InstallSummary;
  warnings?: Array<{ code: string; message: string }>;
}

interface InstallDependencies {
  detectGitTopLevel?: (targetPath: string) => Promise<string | null>;
  detectCodexProcess?: () => Promise<boolean>;
}

export async function runInstallCommand(
  options: InstallOptions = {},
  dependencies: InstallDependencies = {},
): Promise<InstallResult> {
  const targetInput = options.target?.trim() || process.cwd();
  const targetPath = resolveRepoRoot(targetInput);

  if (!(await isDirectory(targetPath))) {
    throw new CliError(`Install target is not a directory: ${targetPath}`, CLI_EXIT_CODES.validation);
  }

  const repoRoot = (await (dependencies.detectGitTopLevel ?? resolveGitTopLevel)(targetPath)) ?? targetPath;
  const isGitRepo = repoRoot !== targetPath || (await pathExists(path.join(targetPath, ".git")));
  const paths = resolveRepoPaths(repoRoot);
  const created: string[] = [];

  for (const directory of [
    path.dirname(paths.agentsFile),
    path.dirname(paths.environmentFile),
    path.dirname(paths.configFile),
    paths.scriptsDir,
    path.dirname(paths.goalFile),
    paths.locksDir,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, {
    command: "codex-autonomy install",
  });

  try {
    const textFiles: Array<[string, string]> = [
      [paths.agentsFile, getAgentsMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-plan", "SKILL.md"), getAutonomyPlanSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-work", "SKILL.md"), getAutonomyWorkSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-intake", "SKILL.md"), getAutonomyIntakeSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-review", "SKILL.md"), getAutonomyReviewSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-report", "SKILL.md"), getAutonomyReportSkillMarkdown() + "\n"],
      [path.join(repoRoot, ".agents", "skills", "$autonomy-sprint", "SKILL.md"), getAutonomySprintSkillMarkdown() + "\n"],
      [paths.environmentFile, getEnvironmentTomlTemplate() + "\n"],
      [paths.configFile, getConfigTomlTemplate() + "\n"],
      [paths.setupScript, getSetupWindowsScriptTemplate()],
      [paths.verifyScript, getInstallVerifyScriptTemplate()],
      [paths.smokeScript, getSmokeScriptTemplate()],
      [path.join(paths.scriptsDir, "review.ps1"), getReviewScriptTemplate()],
      [paths.goalFile, getInstallGoalMarkdown() + "\n"],
      [paths.journalFile, getDefaultJournalMarkdown() + "\n"],
    ];

    for (const [filePath, content] of textFiles) {
      if (await ensureTextFile(filePath, content)) {
        created.push(filePath);
      }
    }

    const jsonFiles: Array<[string, unknown]> = [
      [paths.tasksFile, DEFAULT_TASKS],
      [paths.goalsFile, createDefaultGoalsDocument()],
      [paths.proposalsFile, createDefaultProposalsDocument()],
      [paths.stateFile, createDefaultState()],
      [paths.settingsFile, createDefaultSettingsDocument()],
      [paths.resultsFile, createDefaultResultsDocument()],
      [paths.blockersFile, DEFAULT_BLOCKERS],
      [path.join(paths.schemaDir, "tasks.schema.json"), tasksSchema],
      [path.join(paths.schemaDir, "goals.schema.json"), goalsSchema],
      [path.join(paths.schemaDir, "proposals.schema.json"), proposalsSchema],
      [path.join(paths.schemaDir, "state.schema.json"), stateSchema],
      [path.join(paths.schemaDir, "settings.schema.json"), settingsSchema],
      [path.join(paths.schemaDir, "results.schema.json"), resultsSchema],
      [path.join(paths.schemaDir, "blockers.schema.json"), blockersSchema],
    ];

    for (const [filePath, value] of jsonFiles) {
      if (await ensureJsonFile(filePath, value)) {
        created.push(filePath);
      }
    }

    const migratedFiles = await normalizeInstalledControlPlane(paths);

    const codexProcessDetected = await (dependencies.detectCodexProcess ?? detectCodexProcess)();
    const backgroundWorktreePrereqs = isGitRepo && (await hasBackgroundWorktreePrerequisites(paths));
    const automationReady = isGitRepo && backgroundWorktreePrereqs && codexProcessDetected;
    const warning = !isGitRepo
      ? `Target ${repoRoot} is not a Git repository; install completed as scaffolding only.`
      : automationReady
        ? "Environment checks passed. Bind report_thread_id from the original thread and create goal work before status can turn ready_for_automation."
        : codexProcessDetected
          ? "Background worktree prerequisites are not yet satisfied."
          : "Codex process was not detected, so automation is not ready yet.";

    const warnings = [
      !isGitRepo ? { code: "non_git_repo", message: `Target ${repoRoot} is not a Git repository.` } : null,
      !automationReady ? { code: "not_automation_ready", message: "Automation is not ready yet." } : null,
      !codexProcessDetected ? { code: "codex_process_not_detected", message: "Codex process was not detected." } : null,
      !backgroundWorktreePrereqs
        ? { code: "background_worktree_not_ready", message: "Background worktree prerequisites are not ready." }
        : null,
      migratedFiles > 0 ? { code: "control_plane_migrated", message: `Updated ${migratedFiles} existing control-plane document(s) to the latest contract.` } : null,
    ].filter((value): value is { code: string; message: string } => value !== null);

    return {
      ok: true,
      message: buildInstallMessage(repoRoot, isGitRepo, automationReady, created.length),
      summary: {
        target_path: repoRoot,
        is_git_repo: isGitRepo,
        automation_ready: automationReady,
        codex_process_detected: codexProcessDetected,
        background_worktree_prereqs: backgroundWorktreePrereqs,
        control_surface_files_created: created.length,
        next_automations: buildNextAutomationSuggestions(isGitRepo),
        warning,
        private_automation_storage_untouched: true,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };

  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .requiredOption("--target <path>", "Target repository root")
    .description("Install the codex-autonomy control surface into a target repository")
    .action(async (options: InstallOptions) => {
      const result = await runInstallCommand({ target: options.target });
      console.log(JSON.stringify(result, null, 2));
    });
}

async function ensureTextFile(filePath: string, content: string): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await writeTextFileAtomic(filePath, content);
  return true;
}

async function ensureJsonFile(filePath: string, value: unknown): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  await writeJsonAtomic(filePath, value);
  return true;
}

async function normalizeInstalledControlPlane(paths: ReturnType<typeof resolveRepoPaths>): Promise<number> {
  const now = new Date().toISOString();
  const rawState = await loadExistingJson(paths.stateFile, createDefaultState);
  let state = normalizeStateDocument(rawState);
  const rawSettings = await loadExistingJson(paths.settingsFile, createDefaultSettingsDocument);
  const settings = normalizeSettingsDocument(rawSettings);
  const rawResults = await loadExistingJson(paths.resultsFile, createDefaultResultsDocument);
  const results = normalizeResultsDocument(rawResults);
  const rawGoals = await loadExistingJson(paths.goalsFile, createDefaultGoalsDocument);
  let goals = normalizeGoalsDocument(rawGoals, {
    referencedGoalIds: state.current_goal_id ? [state.current_goal_id] : [],
    activeGoalId: state.current_goal_id,
    defaultRunMode: state.run_mode,
    now,
  });
  const fallbackGoalId = state.current_goal_id ?? goals.goals[0]?.id ?? LEGACY_GOAL_ID;
  const rawTasks = await loadExistingJson(paths.tasksFile, () => DEFAULT_TASKS);
  const tasks = normalizeTasksDocument(rawTasks, { fallbackGoalId, now });
  const rawProposals = await loadExistingJson(paths.proposalsFile, createDefaultProposalsDocument);
  const proposals = normalizeProposalsDocument(rawProposals, {
    fallbackGoalId: state.current_goal_id ?? tasks.tasks[0]?.goal_id ?? goals.goals[0]?.id ?? LEGACY_GOAL_ID,
    now,
  });
  goals = normalizeGoalsDocument(goals, {
    referencedGoalIds: [
      ...tasks.tasks.map((task) => task.goal_id),
      ...proposals.proposals.map((proposal) => proposal.goal_id),
      ...(state.current_goal_id ? [state.current_goal_id] : []),
    ],
    activeGoalId: state.current_goal_id,
    defaultRunMode: state.run_mode,
    now,
  });
  const rawBlockers = await loadExistingJson(paths.blockersFile, () => DEFAULT_BLOCKERS);
  const blockers = normalizeBlockersDocument(rawBlockers, { now });

  const activeGoal = goals.goals.find((goal) => goal.status === "active") ?? null;
  if (!state.current_goal_id && activeGoal) {
    state = {
      ...state,
      current_goal_id: activeGoal.id,
      run_mode: activeGoal.run_mode,
    };
  }

  const writes = await Promise.all([
    writeNormalizedJsonIfChanged(paths.stateFile, rawState, state),
    writeNormalizedJsonIfChanged(paths.settingsFile, rawSettings, settings),
    writeNormalizedJsonIfChanged(paths.resultsFile, rawResults, results),
    writeNormalizedJsonIfChanged(paths.goalsFile, rawGoals, goals),
    writeNormalizedJsonIfChanged(paths.tasksFile, rawTasks, tasks),
    writeNormalizedJsonIfChanged(paths.proposalsFile, rawProposals, proposals),
    writeNormalizedJsonIfChanged(paths.blockersFile, rawBlockers, blockers),
  ]);

  return writes.filter(Boolean).length;
}

async function loadExistingJson<T>(filePath: string, fallback: () => T): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return fallback();
  }

  return loadJsonFile<unknown>(filePath);
}

async function writeNormalizedJsonIfChanged(filePath: string, existing: unknown, normalized: unknown): Promise<boolean> {
  if (JSON.stringify(existing) === JSON.stringify(normalized)) {
    return false;
  }

  await writeJsonAtomic(filePath, normalized);
  return true;
}

function normalizeStateDocument(document: unknown): AutonomyState {
  const defaults = createDefaultState();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  return {
    version: 1,
    current_goal_id: readOptionalString(merged.current_goal_id),
    current_task_id: readOptionalString(merged.current_task_id),
    cycle_status: isOneOf(merged.cycle_status, ["idle", "planning", "working", "blocked", "review_pending"]) ? merged.cycle_status : defaults.cycle_status,
    run_mode: isOneOf(merged.run_mode, ["sprint", "cruise"]) ? merged.run_mode : null,
    last_planner_run_at: normalizeOptionalTimestamp(merged.last_planner_run_at),
    last_worker_run_at: normalizeOptionalTimestamp(merged.last_worker_run_at),
    last_result: isOneOf(merged.last_result, ["noop", "planned", "passed", "failed", "blocked"]) ? merged.last_result : defaults.last_result,
    consecutive_worker_failures: normalizeInteger(merged.consecutive_worker_failures, defaults.consecutive_worker_failures),
    needs_human_review: Boolean(merged.needs_human_review),
    open_blocker_count: normalizeInteger(merged.open_blocker_count, defaults.open_blocker_count),
    report_thread_id: readOptionalString(merged.report_thread_id),
    autonomy_branch: readNonEmptyString(merged.autonomy_branch, defaults.autonomy_branch),
    sprint_active: Boolean(merged.sprint_active),
    paused: Boolean(merged.paused),
    pause_reason: readOptionalString(merged.pause_reason),
    last_thread_summary_sent_at: normalizeOptionalTimestamp(merged.last_thread_summary_sent_at),
    last_inbox_run_at: normalizeOptionalTimestamp(merged.last_inbox_run_at),
  };
}

function normalizeSettingsDocument(document: unknown): AutonomySettings {
  const defaults = createDefaultSettingsDocument();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  const cadence = isPlainObject(merged.default_cruise_cadence) ? merged.default_cruise_cadence : defaults.default_cruise_cadence;
  return {
    version: 1,
    install_source: isOneOf(merged.install_source, ["local_package"]) ? merged.install_source : defaults.install_source,
    initial_confirmation_required: merged.initial_confirmation_required !== false,
    report_surface: isOneOf(merged.report_surface, ["thread_and_inbox"]) ? merged.report_surface : defaults.report_surface,
    auto_commit: isOneOf(merged.auto_commit, ["disabled", "autonomy_branch"]) ? merged.auto_commit : defaults.auto_commit,
    autonomy_branch: readNonEmptyString(merged.autonomy_branch, defaults.autonomy_branch),
    default_cruise_cadence: {
      planner_hours: normalizeInteger(cadence.planner_hours, defaults.default_cruise_cadence.planner_hours),
      worker_hours: normalizeInteger(cadence.worker_hours, defaults.default_cruise_cadence.worker_hours),
      reviewer_hours: normalizeInteger(cadence.reviewer_hours, defaults.default_cruise_cadence.reviewer_hours),
    },
    default_sprint_heartbeat_minutes: normalizeInteger(merged.default_sprint_heartbeat_minutes, defaults.default_sprint_heartbeat_minutes),
  };
}

function normalizeResultsDocument(document: unknown): AutonomyResults {
  const defaults = createDefaultResultsDocument();
  const merged = mergeMissingFields(document, defaults) as Record<string, unknown>;
  return {
    version: 1,
    last_thread_summary_sent_at: normalizeOptionalTimestamp(merged.last_thread_summary_sent_at),
    last_inbox_run_at: normalizeOptionalTimestamp(merged.last_inbox_run_at),
    last_summary_kind: isOneOf(merged.last_summary_kind, ["normal_success", "thread_summary", "immediate_exception", "goal_transition"])
      ? merged.last_summary_kind
      : null,
    last_summary_reason: readOptionalString(merged.last_summary_reason),
    planner: normalizeResultEntry(merged.planner),
    worker: normalizeResultEntry(merged.worker),
    review: normalizeResultEntry(merged.review),
    commit: normalizeResultEntry(merged.commit),
    reporter: normalizeResultEntry(merged.reporter),
  };
}

function normalizeGoalsDocument(
  document: unknown,
  options: {
    referencedGoalIds: string[];
    activeGoalId: string | null;
    defaultRunMode: RunMode | null;
    now: string;
  },
): GoalsDocument {
  const input = isPlainObject(document) ? document : {};
  const goals = Array.isArray(input.goals) ? input.goals : [];
  const normalizedGoals = goals.map((goal, index) => normalizeGoalRecord(goal, {
    index,
    now: options.now,
    activeGoalId: options.activeGoalId,
    defaultRunMode: options.defaultRunMode ?? "cruise",
  }));
  const existingIds = new Set(normalizedGoals.map((goal) => goal.id));

  for (const goalId of options.referencedGoalIds) {
    if (!goalId || existingIds.has(goalId)) {
      continue;
    }

    normalizedGoals.push(createPlaceholderGoal(goalId, {
      now: options.now,
      active: goalId === options.activeGoalId,
      runMode: options.defaultRunMode ?? "cruise",
    }));
    existingIds.add(goalId);
  }

  return {
    version: 1,
    goals: normalizedGoals,
  };
}

function normalizeTasksDocument(
  document: unknown,
  options: {
    fallbackGoalId: string;
    now: string;
  },
): TasksDocument {
  const input = isPlainObject(document) ? document : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  return {
    version: 1,
    tasks: tasks.map((task, index) => normalizeTaskRecord(task, {
      index,
      fallbackGoalId: options.fallbackGoalId,
      now: options.now,
    })),
  };
}

function normalizeProposalsDocument(
  document: unknown,
  options: {
    fallbackGoalId: string;
    now: string;
  },
): ProposalsDocument {
  const input = isPlainObject(document) ? document : {};
  const proposals = Array.isArray(input.proposals) ? input.proposals : [];
  return {
    version: 1,
    proposals: proposals.map((proposal, index) => normalizeProposalRecord(proposal, {
      index,
      fallbackGoalId: options.fallbackGoalId,
      now: options.now,
    })),
  };
}

function normalizeBlockersDocument(document: unknown, options: { now: string }): BlockersDocument {
  const input = isPlainObject(document) ? document : {};
  const blockers = Array.isArray(input.blockers) ? input.blockers : [];
  return {
    version: 1,
    blockers: blockers.map((blocker, index) => normalizeBlockerRecord(blocker, { index, now: options.now })),
  };
}

function normalizeTaskRecord(
  task: unknown,
  options: {
    index: number;
    fallbackGoalId: string;
    now: string;
  },
): TasksDocument["tasks"][number] {
  const input = isPlainObject(task) ? task : {};
  return {
    id: readNonEmptyString(input.id, `legacy-task-${options.index + 1}`),
    goal_id: readNonEmptyString(input.goal_id, options.fallbackGoalId),
    title: readNonEmptyString(input.title, `Imported legacy task ${options.index + 1}`),
    status: isOneOf(input.status, ["queued", "ready", "in_progress", "verify_failed", "blocked", "done"]) ? input.status : "queued",
    priority: isOneOf(input.priority, ["P0", "P1", "P2", "P3"]) ? input.priority : "P1",
    depends_on: readStringArray(input.depends_on),
    acceptance: readStringArray(input.acceptance),
    file_hints: readStringArray(input.file_hints),
    retry_count: normalizeInteger(input.retry_count, 0),
    last_error: readOptionalString(input.last_error),
    updated_at: normalizeTimestamp(input.updated_at, options.now),
    commit_hash: readOptionalString(input.commit_hash),
    review_status: isOneOf(input.review_status, ["not_reviewed", "passed", "followup_required"]) ? input.review_status : "not_reviewed",
  };
}

function normalizeGoalRecord(
  goal: unknown,
  options: {
    index: number;
    now: string;
    activeGoalId: string | null;
    defaultRunMode: RunMode;
  },
): GoalsDocument["goals"][number] {
  const input = isPlainObject(goal) ? goal : {};
  const id = readNonEmptyString(input.id, options.activeGoalId ?? `${LEGACY_GOAL_ID}-${options.index + 1}`);
  const fallbackStatus = id === options.activeGoalId ? "active" : "approved";
  const status = isOneOf(input.status, ["draft", "awaiting_confirmation", "approved", "active", "completed", "blocked", "cancelled"])
    ? input.status
    : fallbackStatus;
  const createdAt = normalizeTimestamp(input.created_at, options.now);
  const completedAt = normalizeOptionalTimestamp(input.completed_at);
  return {
    id,
    title: readNonEmptyString(input.title, `Imported legacy goal ${options.index + 1}`),
    objective: readNonEmptyString(input.objective, "Migrate a legacy autonomy goal into the current control plane."),
    success_criteria: defaultIfEmpty(readStringArray(input.success_criteria), ["Review and refine the imported legacy goal."]),
    constraints: readStringArray(input.constraints),
    out_of_scope: readStringArray(input.out_of_scope),
    status,
    run_mode: isOneOf(input.run_mode, ["sprint", "cruise"]) ? input.run_mode : options.defaultRunMode,
    created_at: createdAt,
    approved_at: normalizeOptionalTimestamp(input.approved_at) ?? (status === "draft" || status === "awaiting_confirmation" ? null : createdAt),
    completed_at: status === "completed" ? completedAt ?? createdAt : completedAt,
  };
}

function normalizeProposalRecord(
  proposal: unknown,
  options: {
    index: number;
    fallbackGoalId: string;
    now: string;
  },
): ProposalsDocument["proposals"][number] {
  const input = isPlainObject(proposal) ? proposal : {};
  return {
    goal_id: readNonEmptyString(input.goal_id, options.fallbackGoalId),
    status: isOneOf(input.status, ["awaiting_confirmation", "approved", "superseded", "cancelled"]) ? input.status : "awaiting_confirmation",
    summary: readNonEmptyString(input.summary, `Imported legacy proposal ${options.index + 1}.`),
    tasks: Array.isArray(input.tasks)
      ? input.tasks.map((task, taskIndex) => normalizeProposedTask(task, taskIndex))
      : [],
    created_at: normalizeTimestamp(input.created_at, options.now),
    approved_at: normalizeOptionalTimestamp(input.approved_at),
  };
}

function normalizeProposedTask(task: unknown, index: number): ProposalsDocument["proposals"][number]["tasks"][number] {
  const input = isPlainObject(task) ? task : {};
  const title = readNonEmptyString(input.title, `Imported proposed task ${index + 1}`);
  return {
    id: readNonEmptyString(input.id, `proposal-task-${index + 1}`),
    title,
    priority: isOneOf(input.priority, ["P0", "P1", "P2", "P3"]) ? input.priority : "P1",
    depends_on: readStringArray(input.depends_on),
    acceptance: defaultIfEmpty(readStringArray(input.acceptance), [title]),
    file_hints: readStringArray(input.file_hints),
  };
}

function normalizeBlockerRecord(
  blocker: unknown,
  options: {
    index: number;
    now: string;
  },
): BlockersDocument["blockers"][number] {
  const input = isPlainObject(blocker) ? blocker : {};
  return {
    id: readNonEmptyString(input.id, `legacy-blocker-${options.index + 1}`),
    task_id: readNonEmptyString(input.task_id, `legacy-task-${options.index + 1}`),
    question: readNonEmptyString(input.question, "Clarify the imported legacy blocker."),
    severity: isOneOf(input.severity, ["low", "medium", "high"]) ? input.severity : "medium",
    status: isOneOf(input.status, ["open", "resolved"]) ? input.status : "open",
    resolution: readOptionalString(input.resolution),
    opened_at: normalizeTimestamp(input.opened_at, options.now),
    resolved_at: normalizeOptionalTimestamp(input.resolved_at),
  };
}

function normalizeResultEntry(entry: unknown): AutonomyResults["planner"] {
  const defaults = createDefaultResultsDocument().planner;
  const input = mergeMissingFields(entry, defaults) as Record<string, unknown>;
  return {
    status: isOneOf(input.status, ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"])
      ? input.status
      : defaults.status,
    goal_id: readOptionalString(input.goal_id),
    task_id: readOptionalString(input.task_id),
    summary: readOptionalString(input.summary),
    happened_at: normalizeOptionalTimestamp(input.happened_at),
    sent_at: normalizeOptionalTimestamp(input.sent_at),
    verify_summary: readOptionalString(input.verify_summary),
    hash: readOptionalString(input.hash),
    message: readOptionalString(input.message),
    review_status: isOneOf(input.review_status, ["not_reviewed", "passed", "followup_required"]) ? input.review_status : null,
  };
}

function createPlaceholderGoal(goalId: string, options: { now: string; active: boolean; runMode: RunMode }): GoalsDocument["goals"][number] {
  return {
    id: goalId,
    title: `Imported legacy goal (${goalId})`,
    objective: "Migrate a legacy autonomy goal into the current control plane.",
    success_criteria: ["Review and refine the imported legacy goal."],
    constraints: [],
    out_of_scope: [],
    status: options.active ? "active" : "approved",
    run_mode: options.runMode,
    created_at: options.now,
    approved_at: options.now,
    completed_at: null,
  };
}

function mergeMissingFields(existing: unknown, defaults: unknown): unknown {
  if (Array.isArray(existing) || Array.isArray(defaults)) {
    return existing ?? defaults;
  }

  if (!isPlainObject(existing) || !isPlainObject(defaults)) {
    return existing ?? defaults;
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in existing)) {
      merged[key] = defaultValue;
      continue;
    }

    merged[key] = mergeMissingFields(existing[key], defaultValue);
  }

  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function defaultIfEmpty<T>(value: T[], fallback: T[]): T[] {
  return value.length > 0 ? value : fallback;
}

async function resolveGitTopLevel(targetPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function detectCodexProcess(): Promise<boolean> {
  const shell = discoverPowerShellExecutable();
  if (!shell) {
    return false;
  }

  return detectCodexProcessProbe(shell).running;
}

async function hasBackgroundWorktreePrerequisites(paths: ReturnType<typeof resolveRepoPaths>): Promise<boolean> {
  const requiredPaths = [
    paths.agentsFile,
    paths.environmentFile,
    paths.configFile,
    paths.setupScript,
    paths.verifyScript,
    paths.smokeScript,
    paths.reviewScript,
    paths.goalFile,
    paths.journalFile,
    paths.tasksFile,
    paths.goalsFile,
    paths.proposalsFile,
    paths.stateFile,
    paths.settingsFile,
    paths.resultsFile,
    paths.blockersFile,
    path.join(paths.schemaDir, "tasks.schema.json"),
    path.join(paths.schemaDir, "goals.schema.json"),
    path.join(paths.schemaDir, "proposals.schema.json"),
    path.join(paths.schemaDir, "state.schema.json"),
    path.join(paths.schemaDir, "settings.schema.json"),
    path.join(paths.schemaDir, "results.schema.json"),
    path.join(paths.schemaDir, "blockers.schema.json"),
  ];

  for (const filePath of requiredPaths) {
    if (!(await pathExists(filePath))) {
      return false;
    }
  }

  return true;
}

function buildInstallMessage(repoRoot: string, isGitRepo: boolean, automationReady: boolean, createdCount: number): string {
  const base = createdCount > 0 ? `Installed codex-autonomy into ${repoRoot}.` : `codex-autonomy was already present in ${repoRoot}.`;

  if (!isGitRepo) {
    return `${base} Warning: target is not a Git repository, so install is not automation-ready.`;
  }

  if (!automationReady) {
    return `${base} Warning: install completed, but automation is not ready yet. Use codex-autonomy inside the target repo after worktree and Codex runtime prerequisites are satisfied.`;
  }

  return `${base} Environment prerequisites are ready. Bind report_thread_id and create goal work before status can become ready_for_automation.`;
}

function buildNextAutomationSuggestions(isGitRepo: boolean): Array<{ name: string; purpose: string }> {
  const suggestions = [
    {
      name: "planner-cruise",
      purpose: "Maintain the ready window and proposal state for the active goal.",
    },
    {
      name: "worker-cruise",
      purpose: "Take one ready task at a time and run verify and review gates.",
    },
    {
      name: "reviewer-cruise",
      purpose: "Review worker output and record follow-up needs.",
    },
    {
      name: "reporter",
      purpose: isGitRepo
        ? "Send thread summaries, keep detailed run records in Inbox, and carry the sprint heartbeat loop when sprint mode is active."
        : "Send thread summaries and keep detailed run records in Inbox after the repo becomes automation-ready.",
    },
  ];

  return suggestions;
}
