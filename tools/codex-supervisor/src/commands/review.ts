import { join } from "node:path";

import { Command } from "commander";

import type { CommandResult } from "../contracts/autonomy.js";
import {
  DEFAULT_AUTONOMY_BRANCH,
  detectGitRepository,
  getCurrentGitBranch,
  inspectAutonomyCommitGate,
} from "../infra/git.js";
import { pathExists } from "../infra/json.js";
import { commandSucceeded, discoverPowerShellExecutable, runProcess } from "../infra/process.js";
import { resolveRepoPaths } from "../shared/paths.js";
import { listPendingRequiredVerificationAxes, summarizeVerification } from "../domain/verification.js";
import { loadGoalsDocument, loadStateDocument, loadVerificationDocument } from "./control-plane.js";

export interface ReviewCommandIssue {
  code: "not_a_git_repo" | "dirty_worktree" | "branch_drift" | "non_allowlisted_changes" | "review_script_missing" | "review_failed";
  message: string;
}

export interface ReviewScriptRun {
  path: string;
  exists: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ReviewCommandResult extends CommandResult {
  repoRoot: string;
  expectedBranch: string;
  currentBranch: string | null;
  head: string | null;
  dirty: boolean;
  hasDiff: boolean;
  commit_ready: boolean;
  commit_skipped_reason: "no_diff" | "dirty_worktree" | "branch_drift" | "non_allowlisted_changes" | "review_failed" | "review_script_missing" | null;
  review_script: ReviewScriptRun;
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

export async function runReviewCommand(
  repoRoot = process.cwd(),
  options?: { expectedBranch?: string },
): Promise<ReviewCommandResult> {
  const expectedBranch = options?.expectedBranch ?? DEFAULT_AUTONOMY_BRANCH;
  const gitProbe = await detectGitRepository(repoRoot);
  const controlRoot = gitProbe?.path ?? repoRoot;
  const paths = resolveRepoPaths(controlRoot);
  const [stateDoc, goalsDoc, verificationDoc] = await Promise.all([
    loadStateDocument(paths),
    loadGoalsDocument(paths),
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
      message: `Commit scope includes non-allowlisted paths: ${gate.blockedPaths.join(", ")}.`,
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
  const blockedPathsReason = issues.find((issue) => issue.code === "non_allowlisted_changes")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const reviewFailedReason = issues.find((issue) => issue.code === "review_failed")
    ?.code as ReviewCommandResult["commit_skipped_reason"];
  const skipReason = blockedPathsReason ?? reviewFailedReason ?? (gate.reason === "no_diff" ? "no_diff" : null);

  return {
    ok: issues.length === 0,
    message:
      issues.length === 0
        ? gate.hasDiff
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
    commit_skipped_reason: commitReady ? null : skipReason,
    review_script: reviewScript,
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
    .description("Run review gating and execute scripts/review.ps1 when the repository is eligible")
    .action(async () => {
      const result = await runReviewCommand();
      console.log(JSON.stringify(result, null, 2));
    });
}
