import { randomUUID } from "node:crypto";

import { Command } from "commander";

import type {
  AutonomyTask,
  AutonomyState,
  CommandResult,
  ControlPlanePendingOperation,
  GoalRecord,
  GoalsDocument,
  ProposalsDocument,
  QuickPendingOperation,
  RepoPaths,
  SlicesDocument,
  TasksDocument,
  VerificationDocument,
} from "../contracts/autonomy.js";
import { ensureGoalVerificationDocument } from "../domain/verification.js";
import { detectGitRepository } from "../infra/git.js";
import { pathExists, readTextFile } from "../infra/fs.js";
import { appendJournalEntry, type JournalEntryInput } from "../infra/journal.js";
import { acquireCycleLock, releaseCycleLock } from "../infra/lock.js";
import { CliError, CLI_EXIT_CODES } from "../shared/errors.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { inspectThreadBindingContext, resolveReportThreadBinding, type ThreadBindingContext } from "../shared/thread-context.js";
import {
  clearPendingOperation,
  createGoalRecord,
  getActiveGoal,
  loadGoalsDocument,
  loadPendingOperation,
  loadProposalsDocument,
  loadResultsDocument,
  loadSlicesDocument,
  loadStateDocument,
  loadTasksDocument,
  loadVerificationDocument,
  persistGoalMirror,
  writeGoalsDocument,
  writePendingOperation,
  writeProposalsDocument,
  writeResultsDocument,
  writeSlicesDocument,
  writeStateDocument,
  writeTasksDocument,
  writeVerificationDocument,
} from "./control-plane.js";

interface QuickOptions {
  target?: string;
  request?: string;
  validate?: boolean;
  track?: boolean;
}

interface QuickResult extends CommandResult {
  tracked: boolean;
  goal_id: string;
  slice_id: string;
  task_id: string;
  request: string;
}

export async function runQuickCommand(
  options: QuickOptions = {},
  repoRoot = process.cwd(),
): Promise<QuickResult> {
  const request = options.request?.trim();
  if (!request) {
    throw new CliError("quick requires --request <text>.", CLI_EXIT_CODES.usage);
  }

  const targetRoot = options.target?.trim() || repoRoot;
  const gitRepo = await detectGitRepository(targetRoot, { allowFilesystemFallback: true });
  const paths = resolveRepoPaths(gitRepo?.path ?? targetRoot);
  const now = new Date().toISOString();

  if (!options.track) {
    const quickPlan = buildQuickPlan(request, now, Boolean(options.validate));
    return {
      ok: true,
      message: `Prepared quick task ${quickPlan.task.id}. Re-run with --track to write it into autonomy state.`,
      tracked: false,
      goal_id: quickPlan.goal.id,
      slice_id: quickPlan.slice.id,
      task_id: quickPlan.task.id,
      request,
    };
  }

  const lock = await acquireCycleLock(paths.cycleLockFile, "codex-autonomy quick");
  try {
    const [
      pendingOperation,
      goalsDoc,
      proposalsDoc,
      slicesDoc,
      tasksDoc,
      state,
      resultsDoc,
      verificationDoc,
    ] = await Promise.all([
      loadPendingOperation(paths),
      loadGoalsDocument(paths),
      loadProposalsDocument(paths),
      loadSlicesDocument(paths),
      loadTasksDocument(paths),
      loadStateDocument(paths),
      loadResultsDocument(paths),
      loadVerificationDocument(paths),
    ]);

    if (pendingOperation) {
      if (pendingOperation.kind === "quick") {
        assertBoundCurrentThreadForQuickOperation(state, pendingOperation);
        return await recoverQuickOperation(paths, pendingOperation, request);
      }

      throw new CliError(
        `quick --track refuses to write while pending control-plane operation ${pendingOperation.id} exists; rerun ${pendingOperation.command} or clear the operation first.`,
        CLI_EXIT_CODES.blocked,
      );
    }

    assertQuickTrackPreconditions(goalsDoc, state);
    const binding = resolveReportThreadBinding({ existingReportThreadId: state.report_thread_id });
    assertQuickThreadBinding(binding.threadContext);
    if (!binding.reportThreadId) {
      throw new CliError("quick --track requires a bound operator thread or current CODEX_THREAD_ID.", CLI_EXIT_CODES.blocked);
    }

    const quickPlan = buildQuickPlan(request, now, Boolean(options.validate));

    const updatedGoals: GoalsDocument = {
      ...goalsDoc,
      goals: [...goalsDoc.goals, quickPlan.goal],
    };
    const updatedSlices: SlicesDocument = {
      ...slicesDoc,
      slices: [...slicesDoc.slices, quickPlan.slice],
    };
    const updatedTasks: TasksDocument = {
      ...tasksDoc,
      tasks: [...tasksDoc.tasks, quickPlan.task],
    };
    const updatedState: AutonomyState = {
      ...state,
      current_goal_id: quickPlan.goal.id,
      current_task_id: null,
      cycle_status: "idle" as const,
      run_mode: "sprint" as const,
      last_planner_run_at: now,
      last_result: "planned" as const,
      report_thread_id: binding.reportThreadId,
      sprint_active: true,
      paused: false,
      pause_reason: null,
    };
    const baseVerification = await ensureGoalVerificationDocument(quickPlan.goal, paths.repoRoot, verificationDoc);
    const updatedVerification = applyQuickValidationAxis(baseVerification, quickPlan.task.id, Boolean(options.validate));
    const updatedResults = {
      ...resultsDoc,
      last_inbox_run_at: now,
      last_summary_kind: "normal_success" as const,
      last_summary_reason: `Tracked quick request as ${quickPlan.task.id}.`,
      latest_goal_transition: null,
      planner: {
        ...resultsDoc.planner,
        status: "planned" as const,
        goal_id: quickPlan.goal.id,
        task_id: quickPlan.task.id,
        summary: `Tracked quick request as one active goal, one slice, and one ready task: ${request}`,
        happened_at: now,
        sent_at: null,
        verify_summary: options.validate ? "pending quick validation axis quick_verify" : null,
        hash: null,
        message: null,
        review_status: null,
      },
    };
    const operationId = randomUUID();
    const journalEntry: JournalEntryInput = {
      timestamp: now,
      actor: "supervisor",
      taskId: quickPlan.task.id,
      result: "planned",
      summary: `Tracked quick request as ${quickPlan.goal.id}/${quickPlan.slice.id}/${quickPlan.task.id}.`,
      verify: options.validate
        ? "pending (quick_verify required verification axis)"
        : "not run (codex-autonomy quick)",
      blocker: "none",
    };
    const operation = buildPendingQuickOperation({
      id: operationId,
      now,
      goalId: quickPlan.goal.id,
      taskIds: [quickPlan.task.id],
      expectedPaths: [
        "autonomy/goals.json",
        "autonomy/slices.json",
        "autonomy/tasks.json",
        "autonomy/state.json",
        "autonomy/verification.json",
        "autonomy/results.json",
        "autonomy/goal.md",
        "autonomy/journal.md",
      ],
      payload: {
        goals: updatedGoals,
        proposals: proposalsDoc,
        slices: updatedSlices,
        tasks: updatedTasks,
        state: updatedState,
        verification: updatedVerification,
        results: updatedResults,
        active_goal_id: quickPlan.goal.id,
        journal_entry: journalEntry,
      },
    });

    await writePendingOperation(paths, operation);
    await writeGoalsDocument(paths, updatedGoals);
    await writeSlicesDocument(paths, updatedSlices);
    await writeTasksDocument(paths, updatedTasks);
    await writeStateDocument(paths, updatedState);
    await writeVerificationDocument(paths, updatedVerification);
    await writeResultsDocument(paths, updatedResults);
    await persistGoalMirror(paths, getActiveGoal(updatedGoals.goals, updatedState));
    await appendJournalEntry(paths.journalFile, withOperationId(journalEntry, operation.id));
    await clearPendingOperation(paths);

    return {
      ok: true,
      message: `Tracked quick request as ready task ${quickPlan.task.id}.`,
      tracked: true,
      goal_id: quickPlan.goal.id,
      slice_id: quickPlan.slice.id,
      task_id: quickPlan.task.id,
      request,
    };
  } finally {
    await releaseCycleLock(paths.cycleLockFile, lock);
  }
}

export function registerQuickCommand(program: Command): void {
  program
    .command("quick")
    .option("--target <path>", "Target repository root")
    .requiredOption("--request <text>", "Small bug fix or focused change request")
    .option("--validate", "Add the repository verification gate to the task acceptance contract")
    .option("--track", "Write the quick goal/slice/task into autonomy state")
    .description("Create a lightweight one-task autonomy entry for a small request")
    .action(async (options: QuickOptions) => {
      const result = await runQuickCommand(options);
      console.log(JSON.stringify(result, null, 2));
    });
}

function buildQuickPlan(request: string, now: string, validate: boolean): {
  goal: GoalRecord;
  slice: SlicesDocument["slices"][number];
  task: AutonomyTask;
} {
  const title = `Quick: ${shorten(request, 72)}`;
  const goal = {
    ...createGoalRecord({
      title,
      objective: request,
      successCriteria: [
        "The requested small change is implemented in the narrowest safe scope.",
        "The result is verified with the narrowest meaningful repo check.",
      ],
      constraints: [
        "Do not expand this quick lane into a broader proposal or unrelated refactor.",
        "Escalate to a blocker if the request crosses a major decision boundary.",
      ],
      outOfScope: [
        "Large rewrites, deployment, credential changes, and unrelated product scope.",
      ],
      runMode: "sprint",
      now,
    }),
    status: "active" as const,
    approved_at: now,
  };
  const suffix = randomUUID().slice(0, 8);
  const sliceId = `slice-${slugify(goal.id)}-quick-${suffix}`;
  const taskId = `quick-${slugify(request)}-${suffix}`;
  const fileHints = extractFileHints(request);
  const acceptance = [
    "Implement only the requested small change.",
    "Keep unrelated behavior and files unchanged.",
    validate
      ? "Run pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1, or record why that gate is unavailable."
      : "Run the narrowest meaningful check before closeout.",
  ];

  const slice: SlicesDocument["slices"][number] = {
    id: sliceId,
    goal_id: goal.id,
    title: "Quick implementation slice",
    objective: request,
    status: "active",
    acceptance,
    file_hints: fileHints,
    task_ids: [taskId],
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  const task: AutonomyTask = {
    id: taskId,
    goal_id: goal.id,
    slice_id: sliceId,
    title: request,
    status: "ready",
    priority: "P1",
    depends_on: [],
    acceptance,
    file_hints: fileHints,
    retry_count: 0,
    last_error: null,
    updated_at: now,
    commit_hash: null,
    review_status: "not_reviewed",
    source: "quick",
    source_task_id: null,
  };

  return { goal, slice, task };
}

function assertQuickTrackPreconditions(goalsDoc: GoalsDocument, state: Awaited<ReturnType<typeof loadStateDocument>>): void {
  if (state.current_task_id || state.cycle_status !== "idle") {
    throw new CliError(
      `quick --track requires an idle control plane; current cycle_status=${state.cycle_status}, current_task_id=${state.current_task_id ?? "none"}.`,
      CLI_EXIT_CODES.blocked,
    );
  }

  const activeWork = goalsDoc.goals.filter((goal) => ["awaiting_confirmation", "approved", "active"].includes(goal.status));
  if (activeWork.length > 0) {
    throw new CliError(
      `quick --track refuses to create a parallel quick goal while active or pending goal(s) exist: ${activeWork.map((goal) => goal.id).join(", ")}.`,
      CLI_EXIT_CODES.blocked,
    );
  }
}

function assertQuickThreadBinding(threadContext: ThreadBindingContext): void {
  if (threadContext.bindingState === "bound_to_current" || threadContext.bindingState === "unbound_current_available") {
    return;
  }

  throw new CliError(
    [
      `quick --track requires the current operator thread to be bound before creating active quick work; thread_binding_state=${threadContext.bindingState}.`,
      threadContext.bindingHint,
    ].filter(Boolean).join(" "),
    CLI_EXIT_CODES.blocked,
  );
}

function assertBoundCurrentThreadForQuickOperation(
  state: AutonomyState,
  operation: QuickPendingOperation,
): void {
  const currentReportThreadId = state.report_thread_id?.trim() || null;
  const payloadReportThreadId = operation.payload.state.report_thread_id?.trim() || null;
  if (currentReportThreadId && payloadReportThreadId && currentReportThreadId !== payloadReportThreadId) {
    throw new CliError(
      `Cannot recover pending quick operation ${operation.id} because report_thread_id changed from ${payloadReportThreadId} to ${currentReportThreadId}; resolve or clear the pending operation manually before rebinding.`,
      CLI_EXIT_CODES.blocked,
    );
  }

  const threadContext = inspectThreadBindingContext(currentReportThreadId ?? payloadReportThreadId);
  if (threadContext.bindingState !== "bound_to_current") {
    throw new CliError(
      `Cannot recover pending quick operation ${operation.id} from ${threadContext.bindingState}; continue from the bound thread before recovering control-plane writes.`,
      CLI_EXIT_CODES.blocked,
    );
  }
}

function applyQuickValidationAxis(
  document: VerificationDocument,
  taskId: string,
  validate: boolean,
): VerificationDocument {
  if (!validate) {
    return document;
  }

  const quickAxis = {
    id: "quick_verify",
    title: "Run repository verification for the quick task",
    required: true,
    status: "pending" as const,
    evidence: [
      "Run pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1, or record why that gate is unavailable.",
    ],
    source_task_id: taskId,
    last_checked_at: null,
    reason: "codex-autonomy quick --validate requested the repository verification gate.",
  };

  return {
    ...document,
    axes: [
      ...document.axes.filter((axis) => axis.id !== quickAxis.id),
      quickAxis,
    ],
  };
}

function buildPendingQuickOperation(input: {
  id: string;
  now: string;
  goalId: string;
  taskIds: string[];
  expectedPaths: string[];
  payload: {
    goals: GoalsDocument;
    proposals: ProposalsDocument;
    slices: SlicesDocument;
    tasks: TasksDocument;
    state: AutonomyState;
    verification: VerificationDocument;
    results: ControlPlanePendingOperation["payload"]["results"];
    active_goal_id: string;
    journal_entry: JournalEntryInput;
  };
}): QuickPendingOperation {
  return {
    version: 1,
    id: input.id,
    kind: "quick",
    created_at: input.now,
    updated_at: input.now,
    command: "codex-autonomy quick",
    auto_approved: true,
    goal_id: input.goalId,
    source_goal_id: null,
    task_ids: input.taskIds,
    expected_paths: input.expectedPaths,
    payload: input.payload,
  };
}

async function recoverQuickOperation(
  paths: RepoPaths,
  operation: QuickPendingOperation,
  request: string,
): Promise<QuickResult> {
  await writeGoalsDocument(paths, operation.payload.goals);
  await writeProposalsDocument(paths, operation.payload.proposals);
  if (!operation.payload.slices || !operation.payload.tasks || !operation.payload.verification) {
    throw new CliError(`Cannot recover pending quick operation ${operation.id}; operation payload is incomplete.`, CLI_EXIT_CODES.validation);
  }
  await writeSlicesDocument(paths, operation.payload.slices);
  await writeTasksDocument(paths, operation.payload.tasks);
  await writeStateDocument(paths, operation.payload.state);
  await writeVerificationDocument(paths, operation.payload.verification);
  await writeResultsDocument(paths, operation.payload.results);

  const activeGoal = operation.payload.active_goal_id
    ? operation.payload.goals.goals.find((goal) => goal.id === operation.payload.active_goal_id) ?? null
    : null;
  await persistGoalMirror(paths, activeGoal);

  if (!(await journalContainsOperation(paths, operation.id))) {
    await appendJournalEntry(paths.journalFile, withOperationId(operation.payload.journal_entry, operation.id));
  }
  await clearPendingOperation(paths);

  const task = operation.payload.tasks.tasks.find((item) => operation.task_ids.includes(item.id));
  const sliceId = task?.slice_id ?? operation.payload.slices.slices.find((slice) => slice.goal_id === operation.goal_id)?.id ?? "";

  return {
    ok: true,
    message: `Recovered pending quick operation ${operation.id} for ready task ${task?.id ?? operation.task_ids[0] ?? "unknown"}.`,
    tracked: true,
    goal_id: operation.goal_id,
    slice_id: sliceId,
    task_id: task?.id ?? operation.task_ids[0] ?? "",
    request,
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

function extractFileHints(request: string): string[] {
  const matches = request.match(/[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]+/g) ?? [];
  const hints = [...new Set(matches.map((item) => item.replace(/\\/g, "/")))].slice(0, 6);
  return hints.length > 0 ? hints : ["."];
}

function shorten(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "quick";
}
