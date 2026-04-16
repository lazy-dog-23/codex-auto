import { join } from "node:path";

import { Command } from "commander";

import type { AutonomyResults, CommandResult, TasksDocument } from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
  createAutonomyCommit,
  detectGitRepository,
  getCurrentGitBranch,
  inspectAutonomyCommitGate,
} from "../infra/git.js";
import { pathExists } from "../infra/json.js";
import { commandSucceeded, discoverPowerShellExecutable, runProcess } from "../infra/process.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { listPendingRequiredVerificationAxes, summarizeVerification } from "../domain/verification.js";
import { loadGoalsDocument, loadResultsDocument, loadStateDocument, loadTasksDocument, loadVerificationDocument } from "./control-plane.js";
import { runPrepareWorktree } from "./prepare-worktree.js";

export interface ReviewCommandIssue {
  code:
    | "not_a_git_repo"
    | "dirty_worktree"
    | "branch_drift"
    | "non_allowlisted_changes"
    | "review_script_missing"
    | "review_failed"
    | "commit_failed"
    | "prepare_worktree_failed";
  message: string;
}

export interface ReviewScriptRun {
  path: string;
  exists: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ReviewCloseoutCommit {
  attempted: boolean;
  committed: boolean;
  hash: string | null;
  message: string | null;
  result_message: string | null;
}

export interface ReviewBackgroundPrepare {
  attempted: boolean;
  ok: boolean;
  background_path: string | null;
  action: "created" | "aligned" | "validated" | null;
  message: string | null;
}

export interface ReviewCommandResult extends CommandResult {
  repoRoot: string;
  expectedBranch: string;
  currentBranch: string | null;
  head: string | null;
  dirty: boolean;
  hasDiff: boolean;
  commit_ready: boolean;
  commit_skipped_reason:
    | "no_diff"
    | "dirty_worktree"
    | "branch_drift"
    | "non_allowlisted_changes"
    | "review_failed"
    | "review_script_missing"
    | "commit_failed"
    | "prepare_worktree_failed"
    | null;
  review_script: ReviewScriptRun;
  closeout_commit: ReviewCloseoutCommit;
  background_prepare: ReviewBackgroundPrepare;
  closeout_policy: string | null;
  verification_required: number;
  verification_passed: number;
  verification_pending: number;
  verification_pending_axes: string[];
  completion_blocked_by_verification: boolean;
  next_step_summary: string | null;
  continuation_decision: "none" | "auto_continued" | "needs_confirmation";
  issues: ReviewCommandIssue[];
}

async function runReviewScript(repoRoot: string, scriptPath: string): Promise<ReviewScriptRun> {
  const powershell = discoverPowerShellExecutable();
  if (!powershell) {
    return {
      path: scriptPath,
      exists: true,
      exitCode: null,
      stdout: "",
      stderr: "PowerShell executable was not found.",
    };
  }

  const result = runProcess(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    cwd: repoRoot,
  });

  return {
    path: scriptPath,
    exists: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr || result.error || "",
  };
}

function createEmptyCloseoutCommit(): ReviewCloseoutCommit {
  return {
    attempted: false,
    committed: false,
    hash: null,
    message: null,
    result_message: null,
  };
}

function createEmptyBackgroundPrepare(): ReviewBackgroundPrepare {
  return {
    attempted: false,
    ok: false,
    background_path: null,
    action: null,
    message: null,
  };
}

function sanitizeCommitSubject(value: string | null | undefined): string {
  const normalized = value?.replace(/\s+/g, " ").trim().replace(/[.:]+$/g, "") ?? "";
  if (!normalized) {
    return "close review gate";
  }

  return normalized.length > 72 ? normalized.slice(0, 72).trimEnd() : normalized;
}

function pickLatestTaskIdForGoal(results: AutonomyResults, goalId: string | null): string | null {
  if (!goalId) {
    return null;
  }

  for (const entry of [results.review, results.worker, results.commit]) {
    if (entry.goal_id === goalId && entry.task_id) {
      return entry.task_id;
    }
  }

  return null;
}

function pickLatestSummaryForGoal(results: AutonomyResults, goalId: string | null): string | null {
  for (const entry of [results.review, results.worker, results.commit]) {
    if (goalId !== null && entry.goal_id !== goalId) {
      continue;
    }
    if (entry.summary) {
      return entry.summary;
    }
  }

  return null;
}

function buildAutonomyCommitMessage(options: {
  currentGoalId: string | null;
  currentTaskId: string | null;
  tasksDoc: TasksDocument;
  resultsDoc: AutonomyResults;
}): string {
  const goalId = options.currentGoalId ?? "goal";
  const taskId = options.currentTaskId
    ?? pickLatestTaskIdForGoal(options.resultsDoc, options.currentGoalId)
    ?? "task";
  const task = options.tasksDoc.tasks.find((candidate) => candidate.id === taskId);
  const subject = sanitizeCommitSubject(task?.title ?? pickLatestSummaryForGoal(options.resultsDoc, options.currentGoalId));
  return `autonomy(${goalId}/${taskId}): ${subject}`;
}

export async function runReviewCommand(
  repoRoot = process.cwd(),
  options?: { expectedBranch?: string },
): Promise<ReviewCommandResult> {
  const expectedBranch = options?.expectedBranch ?? DEFAULT_AUTONOMY_BRANCH;
  const gitProbe = await detectGitRepository(repoRoot);
  const controlRoot = gitProbe?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [stateDoc, goalsDoc, tasksDoc, resultsDoc, verificationDoc] = await Promise.all([
    loadStateDocument(paths),
    loadGoalsDocument(paths),
    loadTasksDocument(paths),
    loadResultsDocument(paths),
    loadVerificationDocument(paths),
  ]);
  const currentGoalId = stateDoc.current_goal_id ?? goalsDoc.goals.find((goal) => goal.status === "active")?.id ?? null;
  const verificationSummary = summarizeVerification(verificationDoc, currentGoalId);
  const verificationPendingAxes = listPendingRequiredVerificationAxes(verificationDoc, currentGoalId);
  const nextStepSummary = verificationPendingAxes.length > 0
    ? `Verification closeout is still pending for: ${verificationPendingAxes.map((axis) => axis.id).join(", ")}.`
    : null;
  const continuationDecision = verificationPendingAxes.length > 0 ? "auto_continued" as const : "none" as const;
  const gitRepo = gitProbe;
  if (!gitRepo) {
    return {
      ok: false,
      message: `Repository at ${repoRoot} is not a Git repository.`,
      repoRoot,
      expectedBranch,
      currentBranch: null,
      head: null,
      dirty: false,
      hasDiff: false,
      commit_ready: false,
      commit_skipped_reason: null,
      review_script: {
        path: join(repoRoot, "scripts", "review.ps1"),
        exists: false,
        exitCode: null,
        stdout: "",
        stderr: "",
      },
      closeout_commit: createEmptyCloseoutCommit(),
      background_prepare: createEmptyBackgroundPrepare(),
      closeout_policy: verificationDoc.goal_id === currentGoalId ? verificationDoc.policy : null,
      verification_required: verificationSummary.required,
      verification_passed: verificationSummary.passed,
      verification_pending: verificationSummary.pending,
      verification_pending_axes: verificationPendingAxes.map((axis) => axis.id),
      completion_blocked_by_verification: verificationPendingAxes.length > 0,
      next_step_summary: nextStepSummary,
      continuation_decision: continuationDecision,
      issues: [
        {
          code: "not_a_git_repo",
          message: "Current workspace is not a Git repository.",
        },
      ],
    };
  }

  const currentBranch = await getCurrentGitBranch(gitRepo.path);
  const reviewScriptPath = join(gitRepo.path, "scripts", "review.ps1");
  const reviewScriptExists = await pathExists(reviewScriptPath);
  const gate = await inspectAutonomyCommitGate(gitRepo.path, expectedBranch);
  const issues: ReviewCommandIssue[] = [];

  if (gate.reason === "branch_drift") {
    issues.push({
      code: "branch_drift",
      message: `Current branch is ${gate.currentBranch ?? "detached HEAD"}, expected ${expectedBranch}.`,
    });
  }

  if (gate.blockedPaths.length > 0) {
    issues.push({
      code: "non_allowlisted_changes",
      message: `Commit scope includes paths that are not eligible for an autonomy closeout commit: ${gate.blockedPaths.join(", ")}.`,
    });
  }

  if (!reviewScriptExists) {
    issues.push({
      code: "review_script_missing",
      message: `Missing review script at ${reviewScriptPath}.`,
    });
  }

  let reviewScript: ReviewScriptRun = {
    path: reviewScriptPath,
    exists: reviewScriptExists,
    exitCode: null,
    stdout: "",
    stderr: "",
  };
  const closeoutCommit = createEmptyCloseoutCommit();
  const backgroundPrepare = createEmptyBackgroundPrepare();

  if (issues.some((issue) => issue.code === "branch_drift" || issue.code === "review_script_missing")) {
    const branchDriftReason = issues.find((issue) => issue.code === "branch_drift")
      ?.code as ReviewCommandResult["commit_skipped_reason"];
    const reviewScriptMissingReason = issues.find((issue) => issue.code === "review_script_missing")
      ?.code as ReviewCommandResult["commit_skipped_reason"];

    return {
      ok: false,
      message: issues.map((issue) => issue.message).join(" "),
      repoRoot: gitRepo.path,
      expectedBranch,
      currentBranch,
      head: gate.head,
      dirty: gate.dirty,
      hasDiff: gate.hasDiff,
      commit_ready: false,
      commit_skipped_reason: branchDriftReason ?? reviewScriptMissingReason ?? null,
      review_script: reviewScript,
      closeout_commit: closeoutCommit,
      background_prepare: backgroundPrepare,
      closeout_policy: verificationDoc.goal_id === currentGoalId ? verificationDoc.policy : null,
      verification_required: verificationSummary.required,
      verification_passed: verificationSummary.passed,
      verification_pending: verificationSummary.pending,
      verification_pending_axes: verificationPendingAxes.map((axis) => axis.id),
      completion_blocked_by_verification: verificationPendingAxes.length > 0,
      next_step_summary: nextStepSummary,
      continuation_decision: continuationDecision,
      issues,
    };
  }

  reviewScript = await runReviewScript(gitRepo.path, reviewScriptPath);
  if (!commandSucceeded({
    command: "pwsh",
    args: [],
    cwd: gitRepo.path,
    exitCode: reviewScript.exitCode,
    stdout: reviewScript.stdout,
    stderr: reviewScript.stderr,
  })) {
    issues.push({
      code: "review_failed",
      message: `Review script failed with exit code ${reviewScript.exitCode ?? "unknown"}.`,
    });
  }

  const commitReady = gate.commitReady && issues.length === 0;
  if (commitReady) {
    closeoutCommit.attempted = true;
    closeoutCommit.message = buildAutonomyCommitMessage({
      currentGoalId,
      currentTaskId: stateDoc.current_task_id,
      tasksDoc,
      resultsDoc,
    });

    const commitResult = await createAutonomyCommit(gitRepo.path, closeoutCommit.message, expectedBranch);
    closeoutCommit.committed = commitResult.committed;
    closeoutCommit.hash = commitResult.commitHash;
    closeoutCommit.result_message = commitResult.message;

    if (!commitResult.ok) {
      issues.push({
        code: "commit_failed",
        message: commitResult.message,
      });
    } else if (commitResult.committed) {
      backgroundPrepare.attempted = true;
      const prepareResult = await runPrepareWorktree({ workspaceRoot: gitRepo.path });
      backgroundPrepare.ok = prepareResult.ok;
      backgroundPrepare.background_path = prepareResult.backgroundPath;
      backgroundPrepare.action = prepareResult.action ?? null;
      backgroundPrepare.message = prepareResult.message;

      if (!prepareResult.ok) {
        issues.push({
          code: "prepare_worktree_failed",
          message: prepareResult.message,
        });
      }
    }
  }

  const blockedPathsReason = issues.find((issue) => issue.code === "non_allowlisted_changes")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const reviewFailedReason = issues.find((issue) => issue.code === "review_failed")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const commitFailedReason = issues.find((issue) => issue.code === "commit_failed")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const prepareFailedReason = issues.find((issue) => issue.code === "prepare_worktree_failed")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const skipReason = blockedPathsReason
    ?? reviewFailedReason
    ?? commitFailedReason
    ?? prepareFailedReason
    ?? (gate.reason === "no_diff" ? "no_diff" : null);

  return {
    ok: issues.length === 0,
    message:
      issues.length === 0
        ? closeoutCommit.committed
          ? "Review passed, the autonomy closeout commit was created, and the background worktree is aligned."
          : gate.hasDiff
            ? "Review passed and the repository is ready for a controlled commit."
            : "Review passed, but there is no diff to commit."
        : issues.map((issue) => issue.message).join(" "),
    repoRoot: gitRepo.path,
    expectedBranch,
    currentBranch,
    head: gate.head,
    dirty: gate.dirty,
    hasDiff: gate.hasDiff,
    commit_ready: commitReady,
    commit_skipped_reason: issues.length === 0 ? (gate.reason === "no_diff" ? "no_diff" : null) : skipReason,
    review_script: reviewScript,
    closeout_commit: closeoutCommit,
    background_prepare: backgroundPrepare,
    closeout_policy: verificationDoc.goal_id === currentGoalId ? verificationDoc.policy : null,
    verification_required: verificationSummary.required,
    verification_passed: verificationSummary.passed,
    verification_pending: verificationSummary.pending,
    verification_pending_axes: verificationPendingAxes.map((axis) => axis.id),
    completion_blocked_by_verification: verificationPendingAxes.length > 0,
    next_step_summary: nextStepSummary,
    continuation_decision: continuationDecision,
    issues,
  };
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Run review gating, attempt a controlled autonomy closeout commit, and align the background worktree when eligible")
    .action(async () => {
      const result = await runReviewCommand();
      console.log(JSON.stringify(result, null, 2));
    });
}
