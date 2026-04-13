import type {
  AutonomyResults,
  AutonomyState,
  ContinuationDecision,
  GoalTransitionSnapshot,
  ResultEntry,
  SummaryKind,
} from "../contracts/autonomy.js";

export interface SummarySnapshot {
  latestSummaryKind: SummaryKind | null;
  latestSummaryReason: string | null;
  lastThreadSummarySentAt: string | null;
  lastInboxRunAt: string | null;
  hasRecordedRun: boolean;
  latestGoalTransition: GoalTransitionSnapshot | null;
}

export interface ScopedResultsSummary {
  plannerSummary: string | null;
  workerResult: string | null;
  workerVerifySummary: string | null;
  reviewResult: string | null;
  commitHash: string | null;
  commitMessage: string | null;
  nextStepSummary: string | null;
  continuationDecision: ContinuationDecision | null;
  resultsScopeNote: string | null;
}

export function hasRecordedResultEntry(entry: ResultEntry): boolean {
  return (
    entry.status !== "not_run" ||
    entry.goal_id !== null ||
    (entry.task_id !== null && entry.task_id !== undefined) ||
    entry.summary !== null ||
    (entry.happened_at !== null && entry.happened_at !== undefined) ||
    (entry.sent_at !== null && entry.sent_at !== undefined) ||
    (entry.verify_summary !== null && entry.verify_summary !== undefined) ||
    (entry.hash !== null && entry.hash !== undefined) ||
    (entry.message !== null && entry.message !== undefined) ||
    (entry.review_status !== null && entry.review_status !== undefined) ||
    (entry.next_step_summary !== null && entry.next_step_summary !== undefined) ||
    (entry.continuation_decision !== null && entry.continuation_decision !== undefined)
  );
}

export function hasRecordedResults(
  results: AutonomyResults,
  legacyState?: Pick<AutonomyState, "last_thread_summary_sent_at" | "last_inbox_run_at">,
): boolean {
  return (
    Boolean(results.last_thread_summary_sent_at) ||
    Boolean(results.last_inbox_run_at) ||
    Boolean(results.last_summary_kind) ||
    Boolean(results.last_summary_reason) ||
    (results.latest_goal_transition !== null && results.latest_goal_transition !== undefined) ||
    hasRecordedResultEntry(results.worker) ||
    hasRecordedResultEntry(results.review) ||
    hasRecordedResultEntry(results.commit) ||
    hasRecordedResultEntry(results.reporter) ||
    Boolean(legacyState?.last_thread_summary_sent_at) ||
    Boolean(legacyState?.last_inbox_run_at)
  );
}

export function resolveSummarySnapshot(
  results: AutonomyResults,
  legacyState?: Pick<AutonomyState, "last_thread_summary_sent_at" | "last_inbox_run_at">,
): SummarySnapshot {
  const lastThreadSummarySentAt = results.last_thread_summary_sent_at ?? results.reporter.sent_at ?? legacyState?.last_thread_summary_sent_at ?? null;
  const lastInboxRunAt = results.last_inbox_run_at ?? results.reporter.happened_at ?? legacyState?.last_inbox_run_at ?? null;
  const hasRecordedRun = hasRecordedResults(results, legacyState);

  let latestSummaryKind: SummaryKind | null = results.last_summary_kind ?? null;
  if (!latestSummaryKind && hasRecordedRun) {
    if (results.worker.status === "failed" || results.review.status === "failed" || results.commit.status === "failed") {
      latestSummaryKind = "immediate_exception";
    } else if (lastThreadSummarySentAt) {
      latestSummaryKind = "thread_summary";
    } else {
      latestSummaryKind = "normal_success";
    }
  }

  let latestSummaryReason = results.last_summary_reason ?? null;
  if (!latestSummaryKind) {
    latestSummaryReason = "No recorded autonomy run yet.";
  } else if (!latestSummaryReason) {
    if (latestSummaryKind === "goal_transition") {
      latestSummaryReason = "The previous goal completed and the next approved goal is active.";
    } else if (latestSummaryKind === "thread_summary") {
      latestSummaryReason = "The latest successful run was summarized to the thread.";
    } else if (latestSummaryKind === "immediate_exception") {
      latestSummaryReason = "A worker, review, or commit step failed and needs immediate attention.";
    } else {
      latestSummaryReason = "The latest run completed successfully and is waiting for summary handling.";
    }
  }

  return {
    latestSummaryKind,
    latestSummaryReason,
    lastThreadSummarySentAt,
    lastInboxRunAt,
    hasRecordedRun,
    latestGoalTransition: results.latest_goal_transition ?? null,
  };
}

export function scopeResultsSummary(results: AutonomyResults, currentGoalId: string | null): ScopedResultsSummary {
  const plannerEntry = pickPlannerEntryForGoal(results.planner, currentGoalId);
  const workerEntry = pickExecutionEntryForGoal(results.worker, currentGoalId);
  const reviewEntry = pickExecutionEntryForGoal(results.review, currentGoalId);
  const commitEntry = pickExecutionEntryForGoal(results.commit, currentGoalId);
  const reporterEntry = pickExecutionEntryForGoal(results.reporter, currentGoalId);

  return {
    plannerSummary: plannerEntry?.summary ?? null,
    workerResult: workerEntry?.summary ?? null,
    workerVerifySummary: workerEntry?.verify_summary ?? workerEntry?.summary ?? null,
    reviewResult: reviewEntry?.summary ?? reviewEntry?.review_status ?? null,
    commitHash: commitEntry?.hash ?? null,
    commitMessage: commitEntry?.message ?? commitEntry?.summary ?? null,
    nextStepSummary: reviewEntry?.next_step_summary
      ?? reporterEntry?.next_step_summary
      ?? workerEntry?.next_step_summary
      ?? plannerEntry?.next_step_summary
      ?? null,
    continuationDecision: reviewEntry?.continuation_decision
      ?? reporterEntry?.continuation_decision
      ?? workerEntry?.continuation_decision
      ?? plannerEntry?.continuation_decision
      ?? null,
    resultsScopeNote: buildResultsScopeNote(results, currentGoalId),
  };
}

function pickPlannerEntryForGoal(entry: ResultEntry, currentGoalId: string | null): ResultEntry | null {
  if (!hasRecordedResultEntry(entry)) {
    return null;
  }

  if (!currentGoalId) {
    return entry;
  }

  if (!entry.goal_id || entry.goal_id !== currentGoalId) {
    return null;
  }

  return entry;
}

function pickExecutionEntryForGoal(entry: ResultEntry, currentGoalId: string | null): ResultEntry | null {
  if (!hasRecordedResultEntry(entry)) {
    return null;
  }

  if (!currentGoalId) {
    return null;
  }

  if (!entry.goal_id || entry.goal_id !== currentGoalId) {
    return null;
  }

  return entry;
}

function buildResultsScopeNote(results: AutonomyResults, currentGoalId: string | null): string | null {
  const executionEntries = [results.worker, results.review, results.commit]
    .filter((entry) => hasRecordedResultEntry(entry));
  const foreignGoalIds = Array.from(new Set(
    executionEntries
      .map((entry) => entry.goal_id)
      .filter((goalId): goalId is string => Boolean(goalId) && goalId !== currentGoalId),
  ));

  if (!currentGoalId) {
    if (executionEntries.length === 0) {
      return null;
    }

    if (foreignGoalIds.length === 0) {
      return "Current goal is unresolved, so execution results are hidden until a single active goal is known.";
    }

    if (foreignGoalIds.length === 1) {
      return `Current goal is unresolved, so latest execution results for ${foreignGoalIds[0]} are hidden until a single active goal is known.`;
    }

    return `Current goal is unresolved, so execution results spanning multiple goals (${foreignGoalIds.join(", ")}) are hidden until a single active goal is known.`;
  }

  if (foreignGoalIds.length === 0) {
    return null;
  }

  if (foreignGoalIds.length === 1) {
    return `Latest execution results belong to ${foreignGoalIds[0]}, not current goal ${currentGoalId}.`;
  }

  return `Latest execution results span multiple goals (${foreignGoalIds.join(", ")}), not current goal ${currentGoalId}.`;
}
