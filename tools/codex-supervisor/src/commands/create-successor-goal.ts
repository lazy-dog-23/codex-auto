import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Command } from "commander";

import type {
  AutonomyResults,
  AutonomyState,
  CommandResult,
  ControlPlanePendingOperation,
  DecisionPolicyDocument,
  GoalRecord,
  GoalsDocument,
  ProposalsDocument,
  RepoPaths,
  RunMode,
  StatusSummary,
  TasksDocument,
  VerificationDocument,
} from "../contracts/autonomy.js";
import { rebalanceTaskWindow, materializeProposal } from "../domain/autonomy.js";
import { buildRepoAwareFallbackProposal } from "../domain/proposal.js";
import { createEmptyVerificationDocument, ensureGoalVerificationDocument } from "../domain/verification.js";
import { pathExists, readTextFile } from "../infra/fs.js";
import { appendJournalEntry, type JournalEntryInput } from "../infra/journal.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { detectGitRepository } from "../infra/git.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { inspectThreadBindingContext } from "../shared/thread-context.js";
import {
  buildProposalFromTasks,
  clearPendingOperation,
  createGoalRecord,
  getActiveGoal,
  loadBlockersDocument,
  loadDecisionPolicyDocument,
  loadGoalsDocument,
  loadPendingOperation,
  loadProposalsDocument,
  loadResultsDocument,
  loadStateDocument,
  loadTasksDocument,
  loadVerificationDocument,
  persistGoalMirror,
  writeGoalsDocument,
  writeProposalsDocument,
  writeResultsDocument,
  writeStateDocument,
  writeTasksDocument,
  writeVerificationDocument,
  writePendingOperation,
} from "./control-plane.js";
import { runStatusCommand } from "./status.js";

interface CreateSuccessorGoalOptions {
  autoApprove?: boolean;
}

interface CreateSuccessorGoalResult extends CommandResult {
  goal_id: string;
  source_goal_id: string;
  proposal_created: boolean;
  auto_approved: boolean;
  task_count: number;
}

export async function runCreateSuccessorGoal(
  options: CreateSuccessorGoalOptions = {},
  repoRoot = process.cwd(),
): Promise<CreateSuccessorGoalResult> {
  const gitRepo = await detectGitRepository(repoRoot, { allowFilesystemFallback: true });
  const controlRoot = gitRepo?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const pendingOperation = await loadPendingOperation(paths);

  if (pendingOperation) {
    if (pendingOperation.kind !== "create_successor_goal") {
      throw new CliError(`Unsupported pending control-plane operation ${pendingOperation.kind}.`, CLI_EXIT_CODES.blocked);
    }

    const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy create-successor-goal recovery");
    try {
      const state = await loadStateDocument(paths);
      assertBoundCurrentThreadForOperation(state, pendingOperation);
      return await recoverCreateSuccessorOperation(paths, pendingOperation);
    } finally {
      await releaseCycleLock(paths.cycleLockFile, lock);
    }
  }

  if (options.autoApprove) {
    const preflightStatus = await runStatusCommand(controlRoot);
    assertAutoApprovePreflight(preflightStatus);
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy create-successor-goal");

  try {
    const now = new Date().toISOString();
    const [
      goalsDoc,
      proposalsDoc,
      tasksDoc,
      state,
      blockersDoc,
      resultsDoc,
      verificationDoc,
      decisionPolicy,
    ] = await Promise.all([
      loadGoalsDocument(paths),
      loadProposalsDocument(paths),
      loadTasksDocument(paths),
      loadStateDocument(paths),
      loadBlockersDocument(paths),
      loadResultsDocument(paths),
      loadVerificationDocument(paths),
      loadDecisionPolicyDocument(paths),
    ]);

    validateSuccessorPreconditions({
      goalsDoc,
      proposalsDoc,
      state,
      openBlockerCount: blockersDoc.blockers.filter((blocker) => blocker.status === "open").length,
      unfinishedTaskCount: tasksDoc.tasks.filter((task) => task.status !== "done").length,
      decisionPolicy,
      autoApprove: Boolean(options.autoApprove),
      nowMs: Date.parse(now),
    });

    const previousGoal = latestCompletedGoal(goalsDoc.goals);
    if (!previousGoal) {
      throw new CliError("create-successor-goal requires at least one completed source goal.", CLI_EXIT_CODES.usage);
    }

    const laneSelection = await selectSuccessorLane({
      previousGoal,
      decisionPolicy,
      resultsDoc,
      verificationDoc,
      repoRoot: paths.repoRoot,
    });
    const successorGoal = buildSuccessorGoal({
      previousGoal,
      decisionPolicy,
      laneSelection,
      now,
      index: goalsDoc.goals.filter((goal) => goal.source === "auto_successor").length + 1,
    });
    const proposalPlan = await buildRepoAwareFallbackProposal(successorGoal, paths.repoRoot);
    const proposal = buildProposalFromTasks({
      goalId: successorGoal.id,
      summary: proposalPlan.summary,
      tasks: proposalPlan.tasks,
      now,
    });

    if (!options.autoApprove) {
      const updatedGoals: GoalsDocument = {
        ...goalsDoc,
        goals: [...goalsDoc.goals, successorGoal],
      };
      const updatedProposals: ProposalsDocument = {
        ...proposalsDoc,
        proposals: [...proposalsDoc.proposals, proposal],
      };
      const updatedState: AutonomyState = {
        ...state,
        last_planner_run_at: now,
        last_result: "planned",
      };
      const updatedResults = {
        ...resultsDoc,
        last_inbox_run_at: now,
        last_summary_kind: "normal_success" as const,
        last_summary_reason: `Drafted successor goal ${successorGoal.id} from completed goal ${previousGoal.id}.`,
        latest_goal_transition: null,
        planner: {
          ...resultsDoc.planner,
          status: "planned" as const,
          goal_id: successorGoal.id,
          task_id: null,
          summary: `Drafted successor goal ${successorGoal.id} with ${proposalPlan.tasks.length} proposed task(s).`,
          happened_at: now,
          sent_at: null,
          verify_summary: null,
          hash: null,
          message: null,
          review_status: null,
        },
      };

      const journalEntry: JournalEntryInput = {
        timestamp: now,
        actor: "supervisor",
        taskId: successorGoal.id,
        result: "planned",
        summary: `Drafted successor goal ${successorGoal.id} from completed goal ${previousGoal.id}; awaiting approval.`,
        verify: "not run (codex-autonomy create-successor-goal)",
        blocker: "none",
      };
      const operation = buildPendingCreateSuccessorOperation({
        id: randomUUID(),
        now,
        autoApproved: false,
        goalId: successorGoal.id,
        sourceGoalId: previousGoal.id,
        taskIds: [],
        expectedPaths: ["autonomy/goals.json", "autonomy/proposals.json", "autonomy/state.json", "autonomy/results.json", "autonomy/journal.md"],
        payload: {
          goals: updatedGoals,
          proposals: updatedProposals,
          tasks: null,
          state: updatedState,
          verification: null,
          results: updatedResults,
          active_goal_id: null,
          journal_entry: journalEntry,
        },
      });

      await writePendingOperation(paths, operation);
      await writeGoalsDocument(paths, updatedGoals);
      await writeProposalsDocument(paths, updatedProposals);
      await writeStateDocument(paths, updatedState);
      await writeResultsDocument(paths, updatedResults);
      await appendJournalEntry(paths.journalFile, withOperationId(journalEntry, operation.id));
      await clearPendingOperation(paths);

      return {
        ok: true,
        message: `Drafted successor goal ${successorGoal.id} with ${proposalPlan.tasks.length} proposed task(s).`,
        goal_id: successorGoal.id,
        source_goal_id: previousGoal.id,
        proposal_created: true,
        auto_approved: false,
        task_count: proposalPlan.tasks.length,
      };
    }

    const stagedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: [...goalsDoc.goals, successorGoal],
    };
    const stagedProposals: ProposalsDocument = {
      ...proposalsDoc,
      proposals: [...proposalsDoc.proposals, proposal],
    };
    const materialized = materializeProposal(
      stagedGoals.goals,
      stagedProposals.proposals,
      tasksDoc.tasks,
      state,
      successorGoal.id,
      now,
    );
    const rebalanced = rebalanceTaskWindow(materialized.tasks, {
      currentGoalId: materialized.state.current_goal_id,
    });
    const updatedTasks: TasksDocument = {
      ...tasksDoc,
      tasks: rebalanced.tasks,
    };
    const updatedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: materialized.goals,
    };
    const updatedProposals: ProposalsDocument = {
      ...proposalsDoc,
      proposals: materialized.proposals,
    };
    const updatedState: AutonomyState = {
      ...materialized.state,
      cycle_status: "idle",
      last_planner_run_at: now,
      last_result: "planned",
    };
    const activeGoal = getActiveGoal(updatedGoals.goals, updatedState);
    const updatedVerification = activeGoal
      ? await ensureGoalVerificationDocument(activeGoal, paths.repoRoot, verificationDoc)
      : createEmptyVerificationDocument();
    const operationId = randomUUID();
    const updatedResults = {
      ...resultsDoc,
      last_inbox_run_at: now,
      last_summary_kind: "goal_transition" as const,
      last_summary_reason: `Auto-created and approved successor goal ${successorGoal.id} from completed goal ${previousGoal.id}. Operation ${operationId}.`,
      latest_goal_transition: {
        from_goal_id: previousGoal.id,
        to_goal_id: successorGoal.id,
        happened_at: now,
      },
      planner: {
        ...resultsDoc.planner,
        status: "planned" as const,
        goal_id: successorGoal.id,
        task_id: null,
        summary: `Auto-created and approved successor goal ${successorGoal.id}; ready window now contains ${rebalanced.readyTaskIds.length} task(s). Operation ${operationId}.`,
        happened_at: now,
        sent_at: null,
        verify_summary: null,
        hash: null,
        message: null,
        review_status: null,
      },
    };

    const journalEntry: JournalEntryInput = {
      timestamp: now,
      actor: "supervisor",
      taskId: successorGoal.id,
      result: "planned",
      summary: `Auto-created and approved successor goal ${successorGoal.id} from completed goal ${previousGoal.id}; ready window contains ${rebalanced.readyTaskIds.length} task(s).`,
      verify: "not run (codex-autonomy create-successor-goal --auto-approve)",
      blocker: "none",
    };
    const operation = buildPendingCreateSuccessorOperation({
      id: operationId,
      now,
      autoApproved: true,
      goalId: successorGoal.id,
      sourceGoalId: previousGoal.id,
      taskIds: proposalPlan.tasks.map((task) => task.id),
      expectedPaths: [
        "autonomy/goals.json",
        "autonomy/proposals.json",
        "autonomy/tasks.json",
        "autonomy/state.json",
        "autonomy/verification.json",
        "autonomy/results.json",
        "autonomy/goal.md",
        "autonomy/journal.md",
      ],
      payload: {
        goals: updatedGoals,
        proposals: updatedProposals,
        tasks: updatedTasks,
        state: updatedState,
        verification: updatedVerification,
        results: updatedResults,
        active_goal_id: activeGoal?.id ?? null,
        journal_entry: journalEntry,
      },
    });

    await writePendingOperation(paths, operation);
    await writeGoalsDocument(paths, updatedGoals);
    await writeProposalsDocument(paths, updatedProposals);
    await writeTasksDocument(paths, updatedTasks);
    await writeStateDocument(paths, updatedState);
    await writeVerificationDocument(paths, updatedVerification);
    await writeResultsDocument(paths, updatedResults);
    await persistGoalMirror(paths, activeGoal);
    await appendJournalEntry(paths.journalFile, withOperationId(journalEntry, operation.id));
    await clearPendingOperation(paths);

    return {
      ok: true,
      message: `Auto-created and approved successor goal ${successorGoal.id} with ${proposalPlan.tasks.length} task(s).`,
      goal_id: successorGoal.id,
      source_goal_id: previousGoal.id,
      proposal_created: true,
      auto_approved: true,
      task_count: proposalPlan.tasks.length,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerCreateSuccessorGoalCommand(program: Command): void {
  program
    .command("create-successor-goal")
    .option("--auto-approve", "Create, approve, and activate the minimal successor goal when policy allows it")
    .description("Create the next minimal goal from the authorized long-running program charter")
    .action(async (options: CreateSuccessorGoalOptions) => {
      const result = await runCreateSuccessorGoal(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function assertAutoApprovePreflight(status: StatusSummary): void {
  const failures: string[] = [];
  if (status.thread_binding_state !== "bound_to_current") {
    failures.push(`thread_binding_state=${status.thread_binding_state}`);
  }
  if (!status.ready_for_automation) {
    failures.push(`ready_for_automation=${status.ready_for_automation}`);
  }
  if (status.next_automation_step !== "create_successor_goal") {
    failures.push(`next_automation_step=${status.next_automation_step}`);
  }
  if (status.decision_outcome !== "auto_continue") {
    failures.push(`decision_outcome=${status.decision_outcome}`);
  }
  if (status.decision_next_action !== "create_successor_goal") {
    failures.push(`decision_next_action=${status.decision_next_action}`);
  }
  if (!status.successor_goal_available) {
    failures.push(`successor_goal_available=${status.successor_goal_available}`);
  }
  if (!status.successor_goal_auto_approve) {
    failures.push(`successor_goal_auto_approve=${status.successor_goal_auto_approve}`);
  }

  if (failures.length > 0) {
    const warningEvidence = (status.warnings ?? []).map((warning) => `${warning.code}: ${warning.message}`).join("; ");
    throw new CliError(
      [
        "create-successor-goal --auto-approve blocked by status/decision preflight.",
        `Failed gates: ${failures.join(", ")}.`,
        status.next_automation_reason ? `Reason: ${status.next_automation_reason}.` : null,
        warningEvidence ? `Warnings: ${warningEvidence}` : null,
      ].filter(Boolean).join(" "),
      CLI_EXIT_CODES.blocked,
    );
  }
}

function assertBoundCurrentThreadForOperation(
  state: AutonomyState,
  operation: ControlPlanePendingOperation,
): void {
  const currentReportThreadId = state.report_thread_id?.trim() || null;
  const payloadReportThreadId = operation.payload.state.report_thread_id?.trim() || null;
  if (currentReportThreadId && payloadReportThreadId && currentReportThreadId !== payloadReportThreadId) {
    throw new CliError(
      `Cannot recover pending create-successor-goal operation ${operation.id} because report_thread_id changed from ${payloadReportThreadId} to ${currentReportThreadId}; resolve or clear the pending operation manually before rebinding.`,
      CLI_EXIT_CODES.blocked,
    );
  }

  const threadContext = inspectThreadBindingContext(currentReportThreadId ?? payloadReportThreadId);
  if (threadContext.bindingState !== "bound_to_current") {
    throw new CliError(
      `Cannot recover pending create-successor-goal operation ${operation.id} from ${threadContext.bindingState}; continue from the bound thread before recovering control-plane writes.`,
      CLI_EXIT_CODES.blocked,
    );
  }
}

function buildPendingCreateSuccessorOperation(input: {
  id: string;
  now: string;
  autoApproved: boolean;
  goalId: string;
  sourceGoalId: string;
  taskIds: string[];
  expectedPaths: string[];
  payload: ControlPlanePendingOperation["payload"];
}): ControlPlanePendingOperation {
  return {
    version: 1,
    id: input.id,
    kind: "create_successor_goal",
    created_at: input.now,
    updated_at: input.now,
    command: "codex-autonomy create-successor-goal",
    auto_approved: input.autoApproved,
    goal_id: input.goalId,
    source_goal_id: input.sourceGoalId,
    task_ids: input.taskIds,
    expected_paths: input.expectedPaths,
    payload: input.payload,
  };
}

async function recoverCreateSuccessorOperation(
  paths: RepoPaths,
  operation: ControlPlanePendingOperation,
): Promise<CreateSuccessorGoalResult> {
  await writeGoalsDocument(paths, operation.payload.goals);
  await writeProposalsDocument(paths, operation.payload.proposals);
  if (operation.payload.tasks) {
    await writeTasksDocument(paths, operation.payload.tasks);
  }
  await writeStateDocument(paths, operation.payload.state);
  if (operation.payload.verification) {
    await writeVerificationDocument(paths, operation.payload.verification);
  }
  await writeResultsDocument(paths, operation.payload.results);

  const activeGoal = operation.payload.active_goal_id
    ? operation.payload.goals.goals.find((goal) => goal.id === operation.payload.active_goal_id) ?? null
    : null;
  if (operation.auto_approved) {
    await persistGoalMirror(paths, activeGoal);
  }

  if (!(await journalContainsOperation(paths, operation.id))) {
    await appendJournalEntry(paths.journalFile, withOperationId(operation.payload.journal_entry, operation.id));
  }
  await clearPendingOperation(paths);

  return {
    ok: true,
    message: `Recovered pending create-successor-goal operation ${operation.id} for ${operation.goal_id}.`,
    goal_id: operation.goal_id,
    source_goal_id: operation.source_goal_id,
    proposal_created: true,
    auto_approved: operation.auto_approved,
    task_count: operation.task_ids.length,
  };
}

async function journalContainsOperation(paths: RepoPaths, operationId: string): Promise<boolean> {
  if (!(await pathExists(paths.journalFile))) {
    return false;
  }

  const content = await readTextFile(paths.journalFile);
  return content.includes(`operation ${operationId}`);
}

function withOperationId(entry: JournalEntryInput, operationId: string): JournalEntryInput {
  return {
    ...entry,
    summary: `${entry.summary} (operation ${operationId})`,
  };
}

function validateSuccessorPreconditions(options: {
  goalsDoc: GoalsDocument;
  proposalsDoc: ProposalsDocument;
  state: AutonomyState;
  openBlockerCount: number;
  unfinishedTaskCount: number;
  decisionPolicy: DecisionPolicyDocument;
  autoApprove: boolean;
  nowMs: number;
}): void {
  const policy = options.decisionPolicy.auto_continue.auto_successor_goal;
  if (!policy.enabled) {
    throw new CliError("Auto successor goal generation is disabled in autonomy/decision-policy.json.", CLI_EXIT_CODES.blocked);
  }

  if (!policy.objective?.trim()) {
    throw new CliError("Auto successor goal generation requires a non-empty charter objective.", CLI_EXIT_CODES.validation);
  }

  if (options.autoApprove && !policy.auto_approve_minimal_successor) {
    throw new CliError("Auto approval for successor goals is disabled in autonomy/decision-policy.json.", CLI_EXIT_CODES.blocked);
  }

  if (!options.state.report_thread_id) {
    throw new CliError("Auto successor goal generation requires a bound report_thread_id.", CLI_EXIT_CODES.blocked);
  }

  if (options.state.paused || options.state.needs_human_review || options.state.cycle_status !== "idle") {
    throw new CliError("Auto successor goal generation requires idle, unpaused state without pending human review.", CLI_EXIT_CODES.blocked);
  }

  if (options.openBlockerCount > 0) {
    throw new CliError("Auto successor goal generation is blocked while open blockers exist.", CLI_EXIT_CODES.blocked);
  }

  if (options.unfinishedTaskCount > 0) {
    throw new CliError(`Auto successor goal generation is blocked while ${options.unfinishedTaskCount} unfinished task(s) remain in tasks.json.`, CLI_EXIT_CODES.blocked);
  }

  if (options.goalsDoc.goals.some((goal) => goal.status === "active" || goal.status === "approved" || goal.status === "awaiting_confirmation")) {
    throw new CliError("Auto successor goal generation requires no active, approved, or awaiting-confirmation goals.", CLI_EXIT_CODES.blocked);
  }

  if (options.proposalsDoc.proposals.some((proposal) => proposal.status === "awaiting_confirmation")) {
    throw new CliError("Auto successor goal generation requires no awaiting proposal.", CLI_EXIT_CODES.blocked);
  }

  const completedGoals = latestCompletedGoals(options.goalsDoc.goals);
  if (completedGoals.length === 0) {
    throw new CliError("Auto successor goal generation requires at least one completed goal.", CLI_EXIT_CODES.usage);
  }

  const consecutiveAutoSuccessors = countConsecutiveAutoSuccessors(completedGoals);
  if (consecutiveAutoSuccessors >= policy.max_consecutive_auto_successors) {
    throw new CliError(`Auto successor goal generation reached max_consecutive_auto_successors=${policy.max_consecutive_auto_successors}.`, CLI_EXIT_CODES.blocked);
  }

  const createdLastDay = options.goalsDoc.goals.filter((goal) => {
    if (goal.source !== "auto_successor") {
      return false;
    }
    const createdAt = Date.parse(goal.created_at);
    return Number.isFinite(createdAt) && createdAt >= options.nowMs - 24 * 60 * 60 * 1000;
  }).length;
  if (createdLastDay >= policy.max_successor_goals_per_day) {
    throw new CliError(`Auto successor goal generation reached max_successor_goals_per_day=${policy.max_successor_goals_per_day}.`, CLI_EXIT_CODES.blocked);
  }
}

interface SuccessorLaneSelection {
  lane: string;
  reason: string;
}

async function selectSuccessorLane(options: {
  previousGoal: GoalRecord;
  decisionPolicy: DecisionPolicyDocument;
  resultsDoc: AutonomyResults;
  verificationDoc: VerificationDocument;
  repoRoot: string;
}): Promise<SuccessorLaneSelection> {
  const policy = options.decisionPolicy.auto_continue.auto_successor_goal;
  const allowedLanes = normalizeAllowedLanes(policy.allowed_lanes, policy.forbidden_lanes);
  if (allowedLanes.length === 0) {
    throw new CliError(
      "Auto successor goal generation requires at least one allowed lane after forbidden lane filtering.",
      CLI_EXIT_CODES.blocked,
    );
  }
  const defaultLane = allowedLanes[0]!;

  if (options.verificationDoc.axes.some((axis) => axis.status === "pending" || axis.status === "failed" || axis.status === "blocked")) {
    const lane = findPreferredLane(allowedLanes, ["verification", "manual", "checklist", "test", "qa"]) ?? defaultLane;
    return {
      lane,
      reason: "Selected because verification evidence still has unresolved or failed axes from the completed program context.",
    };
  }

  const followupText = [
    options.resultsDoc.planner.next_step_summary,
    options.resultsDoc.worker.next_step_summary,
    options.resultsDoc.review.next_step_summary,
    options.resultsDoc.last_summary_reason,
    options.previousGoal.title,
    options.previousGoal.objective,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
  const followupLane = scoreLaneFromText(allowedLanes, followupText);
  if (followupLane) {
    return {
      lane: followupLane,
      reason: "Selected from the latest bounded follow-up and completed-goal summary.",
    };
  }

  const roadmapText = await readSuccessorRoadmapText(options.repoRoot);
  const roadmapLane = scoreLaneFromText(allowedLanes, roadmapText);
  if (roadmapLane) {
    return {
      lane: roadmapLane,
      reason: "Selected from repo roadmap/final-report evidence describing the next safe slice.",
    };
  }

  return {
    lane: defaultLane,
    reason: "Selected from the decision-policy default allowed lane because no stronger repo evidence was found.",
  };
}

function buildSuccessorGoal(options: {
  previousGoal: GoalRecord;
  decisionPolicy: DecisionPolicyDocument;
  laneSelection: SuccessorLaneSelection;
  now: string;
  index: number;
}): GoalRecord {
  const policy = options.decisionPolicy.auto_continue.auto_successor_goal;
  const lane = options.laneSelection.lane;
  const title = `Program successor ${options.index}: ${lane}`;
  const objective = [
    `Advance the authorized long-running program objective: ${policy.objective?.trim()}.`,
    `Use completed goal ${options.previousGoal.id} and current repo state to choose the smallest safe, verifiable next slice.`,
    `Lane rationale: ${options.laneSelection.reason}`,
  ].join(" ");
  const successCriteria = dedupeNonEmpty([
    ...policy.success_criteria,
    "One minimal successor slice is completed or produces a clearly recorded blocker.",
    "The change remains inside the program charter and existing repository safety rules.",
    "Verification or review evidence is recorded before the goal is closed.",
  ]);
  const constraints = dedupeNonEmpty([
    ...policy.constraints,
    "Create only bounded, reversible changes.",
    "Do not expand scope beyond the long-running program charter.",
    `This successor remains authorized because it is a minimal ${lane} slice inside the configured long-running charter.`,
    `Allowed lanes: ${policy.allowed_lanes.join(", ") || "none"}.`,
  ]);
  const outOfScope = dedupeNonEmpty([
    ...policy.out_of_scope,
    ...policy.forbidden_lanes.map((laneName) => `Forbidden lane: ${laneName}.`),
  ]);
  const goal = createGoalRecord({
    title,
    objective,
    successCriteria,
    constraints,
    outOfScope,
    runMode: policy.default_run_mode as RunMode,
    now: options.now,
  });

  return {
    ...goal,
    source: "auto_successor",
    source_goal_id: options.previousGoal.id,
  };
}

function normalizeAllowedLanes(allowedLanes: readonly string[], forbiddenLanes: readonly string[]): string[] {
  const forbiddenTokens = new Set([
    ...forbiddenLanes.flatMap((lane) => tokenize(lane)),
    "deploy",
    "deployment",
    "release",
    "secret",
    "credential",
    "credentials",
    "external",
    "service",
  ]);
  const result: string[] = [];
  for (const lane of allowedLanes) {
    const normalized = lane.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!normalized) {
      continue;
    }
    const tokens = tokenize(normalized);
    if (tokens.some((token) => forbiddenTokens.has(token))) {
      continue;
    }
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function findPreferredLane(allowedLanes: readonly string[], preferredTokens: readonly string[]): string | null {
  return allowedLanes.find((lane) => preferredTokens.some((token) => tokenize(lane).includes(token))) ?? null;
}

function scoreLaneFromText(allowedLanes: readonly string[], text: string): string | null {
  const normalizedText = text.toLowerCase();
  if (!normalizedText.trim()) {
    return null;
  }

  let best: { lane: string; score: number } | null = null;
  for (const lane of allowedLanes) {
    const tokens = tokenize(lane);
    const score = tokens.reduce((sum, token) => sum + (normalizedText.includes(token) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { lane, score };
    }
  }
  return best?.lane ?? null;
}

async function readSuccessorRoadmapText(repoRoot: string): Promise<string> {
  const candidates = [
    "docs/optimization/program-roadmap.md",
    "docs/optimization/final-report.md",
    "TEAM_GUIDE.md",
    "README.md",
  ];
  const chunks: string[] = [];
  for (const candidate of candidates) {
    const target = join(repoRoot, candidate);
    if (!(await pathExists(target))) {
      continue;
    }
    try {
      chunks.push(await readTextFile(target));
    } catch {
      continue;
    }
  }
  return chunks.join("\n");
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function latestCompletedGoal(goals: readonly GoalRecord[]): GoalRecord | null {
  return latestCompletedGoals(goals)[0] ?? null;
}

function latestCompletedGoals(goals: readonly GoalRecord[]): GoalRecord[] {
  return [...goals]
    .filter((goal) => goal.status === "completed")
    .sort((left, right) => {
      const leftKey = left.completed_at ?? left.created_at;
      const rightKey = right.completed_at ?? right.created_at;
      const timeDiff = rightKey.localeCompare(leftKey);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return right.id.localeCompare(left.id);
    });
}

function countConsecutiveAutoSuccessors(completedGoalsNewestFirst: readonly GoalRecord[]): number {
  let count = 0;
  for (const goal of completedGoalsNewestFirst) {
    if (goal.source !== "auto_successor") {
      break;
    }
    count += 1;
  }
  return count;
}

function dedupeNonEmpty(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
