import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBootstrapCommand } from "../src/commands/bootstrap.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runReviewCommand } from "../src/commands/review.js";
import { runPrepareWorktree } from "../src/commands/prepare-worktree.js";
import { runStatusCommand } from "../src/commands/status.js";
import { DEFAULT_BACKGROUND_WORKTREE_BRANCH, getBackgroundWorktreePath } from "../src/infra/git.js";
import { createAutonomyCommit, DEFAULT_AUTONOMY_BRANCH, inspectAutonomyCommitGate, getCurrentGitBranch } from "../src/infra/git.js";

const runtimeMocks = vi.hoisted(() => ({
  inspectCycleLockMock: vi.fn(),
  discoverPowerShellExecutableMock: vi.fn(),
  detectCodexProcessMock: vi.fn(),
}));

vi.mock("../src/infra/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/lock.js")>();
  return {
    ...actual,
    inspectCycleLock: runtimeMocks.inspectCycleLockMock,
  };
});

vi.mock("../src/infra/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/process.js")>();
  return {
    ...actual,
    discoverPowerShellExecutable: runtimeMocks.discoverPowerShellExecutableMock,
    detectCodexProcess: runtimeMocks.detectCodexProcessMock,
  };
});

const tempRoots: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(async () => {
  restoreEnv("GIT_CONFIG_GLOBAL", originalGitConfigGlobal);
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) {
      await rm(target, { recursive: true, force: true });
    }
  }
});

beforeEach(() => {
  runtimeMocks.inspectCycleLockMock.mockReset();
  runtimeMocks.discoverPowerShellExecutableMock.mockReset();
  runtimeMocks.detectCodexProcessMock.mockReset();
  runtimeMocks.inspectCycleLockMock.mockResolvedValue({
    exists: false,
    stale: false,
  });
  runtimeMocks.discoverPowerShellExecutableMock.mockReturnValue("pwsh");
  runtimeMocks.detectCodexProcessMock.mockReturnValue({
    running: true,
    matches: ["Codex"],
    executable: "pwsh",
    probeOk: true,
  });
});

async function makeTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-supervisor-"));
  tempRoots.push(root);
  return root;
}

function restoreEnv(name: "GIT_CONFIG_GLOBAL" | "HOME" | "USERPROFILE", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error([
      `git ${args.join(" ")} failed in ${cwd}`,
      `stdout:\n${result.stdout ?? ""}`,
      `stderr:\n${result.stderr ?? ""}`,
    ].join("\n"));
  }

  return (result.stdout ?? "").trim();
}

describe("git/worktree integration", () => {
  it("covers git init, bootstrap, commit, prepare-worktree, status, and worktree alignment", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    const bootstrap = await runBootstrapCommand(workspace);
    expect(bootstrap.ok).toBe(true);

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const firstHead = runGit(workspace, ["rev-parse", "HEAD"]);
    const firstPrepare = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(firstPrepare.ok).toBe(true);
    expect(firstPrepare.action).toBe("created");
    expect(firstPrepare.branch).toBe(DEFAULT_BACKGROUND_WORKTREE_BRANCH);
    expect(firstPrepare.head).toBe(firstHead);
    expect(firstPrepare.backgroundPath).toBe(getBackgroundWorktreePath(workspace));
    expect(firstPrepare.backgroundPath).not.toBeNull();
    if (firstPrepare.backgroundPath) {
      tempRoots.push(firstPrepare.backgroundPath);
    }
    const safeDirectoriesAfterCreate = runGit(workspace, ["config", "--global", "--get-all", "safe.directory"])
      .split(/\r?\n/)
      .filter(Boolean);
    expect(safeDirectoriesAfterCreate).toContain(workspace.replace(/\\/g, "/"));
    expect(safeDirectoriesAfterCreate).toContain(getBackgroundWorktreePath(workspace).replace(/\\/g, "/"));

    const status = await runStatusCommand(workspace);
    expect(status.ready_for_automation).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "missing_background_worktree")).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "background_worktree_head_mismatch")).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "unexpected_background_branch")).toBe(false);

    await appendFile(join(workspace, "README.md"), "\n<!-- integration test change -->\n", "utf8");
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "advance main repo"]);

    const secondHead = runGit(workspace, ["rev-parse", "HEAD"]);
    const secondPrepare = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(secondPrepare.ok).toBe(true);
    expect(secondPrepare.action).toBe("aligned");
    expect(secondPrepare.head).toBe(secondHead);
    expect(secondPrepare.backgroundPath).toBe(firstPrepare.backgroundPath);

    if (!secondPrepare.backgroundPath) {
      throw new Error("Expected prepare-worktree to return a background path.");
    }

    const alignedHead = runGit(secondPrepare.backgroundPath, ["rev-parse", "HEAD"]);
    expect(alignedHead).toBe(secondHead);
  });

  it("rejects redirected background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedTarget = await makeTempWorkspace();
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(redirectedTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirected|symbolic link|junction/i);
  });

  it("rejects dangling redirected background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedRoot = await makeTempWorkspace();
    const missingRedirectTarget = join(redirectedRoot, "missing-background-target");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(missingRedirectTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const result = await runPrepareWorktree({ workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirected|symbolic link|junction/i);
  });

  it("status and doctor reject redirected existing background worktree paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    const redirectedRoot = await makeTempWorkspace();
    const redirectedTarget = join(redirectedRoot, "redirected-worktree");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);
    await runBootstrapCommand(workspace);
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);

    runGit(workspace, ["worktree", "add", "-B", "redirected/worktree", redirectedTarget, "HEAD"]);

    const backgroundPath = getBackgroundWorktreePath(workspace);
    await symlink(redirectedTarget, backgroundPath, "junction");
    tempRoots.push(backgroundPath);

    const status = await runStatusCommand(workspace);
    const doctor = await runDoctor({ workspaceRoot: workspace });

    expect(status.ready_for_automation).toBe(false);
    expect((status.warnings ?? []).some((warning) => warning.code === "unsafe_background_worktree_path")).toBe(true);
    expect(doctor.ok).toBe(false);
    expect(doctor.issues.some((issue) => issue.code === "unsafe_background_worktree_path")).toBe(true);
  });

  it("detects commit gates, skips no-diff commits, and creates controlled autonomy commits for allowlisted paths", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    const bootstrap = await runBootstrapCommand(workspace);
    expect(bootstrap.ok).toBe(true);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const cleanGate = await inspectAutonomyCommitGate(workspace);
    expect(cleanGate.reason).toBe("no_diff");
    expect(cleanGate.ok).toBe(false);
    expect(cleanGate.branchDrift).toBe(false);
    expect(cleanGate.currentBranch).toBe(DEFAULT_AUTONOMY_BRANCH);

    const noDiffCommit = await createAutonomyCommit(workspace, "autonomy(goal/task): no-op");
    expect(noDiffCommit.ok).toBe(true);
    expect(noDiffCommit.committed).toBe(false);
    expect(noDiffCommit.skippedReason).toBe("no_diff");

    await appendFile(join(workspace, "autonomy", "journal.md"), "\n<!-- autonomy commit test -->\n", "utf8");

    const readyGate = await inspectAutonomyCommitGate(workspace);
    expect(readyGate.reason).toBe("dirty_worktree");
    expect(readyGate.ok).toBe(true);
    expect(readyGate.commitReady).toBe(true);
    expect(readyGate.allowedPaths).toContain("autonomy/journal.md");
    expect(readyGate.blockedPaths).toHaveLength(0);
    expect(readyGate.allowedStatusLines.some((line) => line.includes("autonomy/journal.md"))).toBe(true);

    const commitResult = await createAutonomyCommit(workspace, "autonomy(goal-1/task-1): update journal");
    expect(commitResult.ok).toBe(true);
    expect(commitResult.committed).toBe(true);
    expect(commitResult.commitHash).toBeTruthy();
    expect(commitResult.message).toContain("Committed");
    expect(commitResult.currentBranch).toBe(DEFAULT_AUTONOMY_BRANCH);

    const branchAfterCommit = await getCurrentGitBranch(workspace);
    expect(branchAfterCommit).toBe(DEFAULT_AUTONOMY_BRANCH);
    expect(runGit(workspace, ["status", "--porcelain=v1"])).toBe("");
  });

  it("refuses to create autonomy commits when non-allowlisted changes are present", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    const bootstrap = await runBootstrapCommand(workspace);
    expect(bootstrap.ok).toBe(true);

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    await appendFile(join(workspace, "autonomy", "journal.md"), "\n<!-- allowlisted change -->\n", "utf8");
    await appendFile(join(workspace, "README.md"), "\n<!-- blocked change -->\n", "utf8");

    const headBefore = runGit(workspace, ["rev-parse", "HEAD"]);
    const gate = await inspectAutonomyCommitGate(workspace);
    expect(gate.reason).toBe("dirty_worktree");
    expect(gate.ok).toBe(false);
    expect(gate.commitReady).toBe(false);
    expect(gate.allowedPaths).toContain("autonomy/journal.md");
    expect(gate.blockedPaths).toContain("README.md");
    expect(gate.blockedStatusLines.some((line) => line.includes("README.md"))).toBe(true);

    const commitResult = await createAutonomyCommit(workspace, "autonomy(goal-2/task-1): blocked");
    expect(commitResult.ok).toBe(false);
    expect(commitResult.committed).toBe(false);
    expect(commitResult.stageResult).toBeNull();
    expect(commitResult.commitResult).toBeNull();
    expect(commitResult.message).toContain("non-allowlisted changes");
    expect(commitResult.message).toContain("README.md");
    expect(commitResult.message).toContain("autonomy/");

    const headAfter = runGit(workspace, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);
  });

  it("runs review gating and blocks dirty or branch-drift states before review.ps1", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const cleanReview = await runReviewCommand(workspace);
    expect(cleanReview.ok).toBe(true);
    expect(cleanReview.commit_ready).toBe(false);
    expect(cleanReview.commit_skipped_reason).toBe("no_diff");
    expect(cleanReview.issues).toHaveLength(0);
    expect(cleanReview.review_script.exitCode).toBe(0);

    await appendFile(join(workspace, "autonomy", "journal.md"), "\n<!-- review allowlisted gate -->\n", "utf8");
    const dirtyReview = await runReviewCommand(workspace);
    expect(dirtyReview.ok).toBe(true);
    expect(dirtyReview.dirty).toBe(true);
    expect(dirtyReview.commit_ready).toBe(true);
    expect(dirtyReview.commit_skipped_reason).toBeNull();
    expect(dirtyReview.issues).toHaveLength(0);

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "stabilize before blocked-scope test"]);

    await appendFile(join(workspace, "README.md"), "\n<!-- review blocked gate -->\n", "utf8");
    const blockedReview = await runReviewCommand(workspace);
    expect(blockedReview.ok).toBe(false);
    expect(blockedReview.commit_ready).toBe(false);
    expect(blockedReview.commit_skipped_reason).toBe("non_allowlisted_changes");
    expect(blockedReview.issues.some((issue) => issue.code === "non_allowlisted_changes")).toBe(true);

    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "stabilize before drift test"]);
    runGit(workspace, ["switch", "-c", "feature/manual"]);

    const driftReview = await runReviewCommand(workspace);
    expect(driftReview.ok).toBe(false);
    expect(driftReview.commit_ready).toBe(false);
    expect(driftReview.commit_skipped_reason).toBe("branch_drift");
    expect(driftReview.issues.some((issue) => issue.code === "branch_drift")).toBe(true);
  });

  it("fails review when the control plane points to a missing current goal", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const statePath = join(workspace, "autonomy", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.current_goal_id = "goal-missing";
    state.run_mode = "sprint";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const review = await runReviewCommand(workspace);
    expect(review.ok).toBe(false);
    expect(review.commit_ready).toBe(false);
    expect(review.commit_skipped_reason).toBe("review_failed");
    expect(review.issues.some((issue) => issue.code === "review_failed")).toBe(true);
    expect(review.review_script.stderr).toContain("Current goal 'goal-missing'");
  });

  it("fails review when actionable goals are missing report_thread_id", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const goalsPath = join(workspace, "autonomy", "goals.json");
    const statePath = join(workspace, "autonomy", "state.json");
    const goals = JSON.parse(await readFile(goalsPath, "utf8")) as { version: number; goals: Array<Record<string, unknown>> };
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

    goals.goals = [
      {
        id: "goal-1",
        title: "Review thread binding",
        objective: "Ensure review blocks missing thread binding when work exists.",
        success_criteria: ["review fails without report_thread_id"],
        constraints: [],
        out_of_scope: [],
        status: "active",
        run_mode: "sprint",
        created_at: "2026-01-01T00:00:00Z",
        approved_at: "2026-01-01T00:00:00Z",
        completed_at: null,
      },
    ];
    state.current_goal_id = "goal-1";
    state.run_mode = "sprint";
    state.report_thread_id = null;

    await writeFile(goalsPath, `${JSON.stringify(goals, null, 2)}\n`, "utf8");
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const review = await runReviewCommand(workspace);
    expect(review.ok).toBe(false);
    expect(review.commit_ready).toBe(false);
    expect(review.commit_skipped_reason).toBe("review_failed");
    expect(review.issues.some((issue) => issue.code === "review_failed")).toBe(true);
    expect(review.review_script.stderr).toContain("report_thread_id");
  });

  it("fails review when review.local.ps1 fails even with no diff", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      join(workspace, "scripts", "review.local.ps1"),
      "throw 'local review failed'\n",
      "utf8",
    );
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface with local review hook"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const review = await runReviewCommand(workspace);
    expect(review.ok).toBe(false);
    expect(review.hasDiff).toBe(false);
    expect(review.commit_ready).toBe(false);
    expect(review.commit_skipped_reason).toBe("review_failed");
    expect(review.issues.some((issue) => issue.code === "review_failed")).toBe(true);
    expect(review.review_script.stderr).toContain("local review failed");
  });

  it("does not require report_thread_id when the only goal is blocked", async () => {
    const workspace = await makeTempWorkspace();
    const gitHome = join(workspace, ".git-home");
    const gitConfigGlobal = join(gitHome, "gitconfig");
    await mkdir(gitHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    process.env.HOME = gitHome;
    process.env.USERPROFILE = gitHome;
    process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;

    runGit(workspace, ["init"]);
    runGit(workspace, ["config", "user.name", "Codex Test"]);
    runGit(workspace, ["config", "user.email", "codex-test@example.com"]);

    await runBootstrapCommand(workspace);
    await writeFile(
      join(workspace, "scripts", "review.ps1"),
      await readFile(join(repoRoot, "scripts", "review.ps1"), "utf8"),
      "utf8",
    );
    runGit(workspace, ["add", "-A"]);
    runGit(workspace, ["commit", "-m", "bootstrap control surface"]);
    runGit(workspace, ["switch", "-c", DEFAULT_AUTONOMY_BRANCH]);

    const goalsPath = join(workspace, "autonomy", "goals.json");
    const statePath = join(workspace, "autonomy", "state.json");
    const goals = JSON.parse(await readFile(goalsPath, "utf8")) as { version: number; goals: Array<Record<string, unknown>> };
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

    goals.goals = [
      {
        id: "goal-blocked",
        title: "Blocked goal",
        objective: "Preserve blocked maintenance state without thread binding.",
        success_criteria: ["review still runs"],
        constraints: [],
        out_of_scope: [],
        status: "blocked",
        run_mode: "sprint",
        created_at: "2026-01-01T00:00:00Z",
        approved_at: null,
        completed_at: null,
      },
    ];
    state.current_goal_id = null;
    state.run_mode = null;
    state.report_thread_id = null;

    await writeFile(goalsPath, `${JSON.stringify(goals, null, 2)}\n`, "utf8");
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const review = await runReviewCommand(workspace);
    expect(review.ok).toBe(true);
    expect(review.commit_ready).toBe(true);
    expect(review.commit_skipped_reason).toBeNull();
    expect(review.issues).toHaveLength(0);
  });
});
