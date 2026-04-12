import { beforeEach, describe, expect, it, vi } from "vitest";

const detectGitRepositoryMock = vi.fn();
const getBackgroundWorktreePathMock = vi.fn();
const getWorktreeSummaryMock = vi.fn();
const inspectCycleLockMock = vi.fn();
const discoverPowerShellExecutableMock = vi.fn();
const detectCodexProcessMock = vi.fn();
const loadTasksDocumentMock = vi.fn();
const loadGoalsDocumentMock = vi.fn();
const loadStateDocumentMock = vi.fn();
const loadBlockersDocumentMock = vi.fn();
const loadResultsDocumentMock = vi.fn();

vi.mock("../src/infra/git.js", () => ({
  DEFAULT_BACKGROUND_WORKTREE_BRANCH: "codex/background",
  detectGitRepository: detectGitRepositoryMock,
  getBackgroundWorktreePath: getBackgroundWorktreePathMock,
  getWorktreeSummary: getWorktreeSummaryMock,
}));

vi.mock("../src/infra/lock.js", () => ({
  inspectCycleLock: inspectCycleLockMock,
}));

vi.mock("../src/infra/process.js", () => ({
  discoverPowerShellExecutable: discoverPowerShellExecutableMock,
  detectCodexProcess: detectCodexProcessMock,
}));

vi.mock("../src/commands/control-plane.js", () => ({
  loadTasksDocument: loadTasksDocumentMock,
  loadGoalsDocument: loadGoalsDocumentMock,
  loadStateDocument: loadStateDocumentMock,
  loadBlockersDocument: loadBlockersDocumentMock,
  loadResultsDocument: loadResultsDocumentMock,
}));

describe("status runtime gates", () => {
  beforeEach(() => {
    vi.resetModules();
    detectGitRepositoryMock.mockReset();
    getBackgroundWorktreePathMock.mockReset();
    getWorktreeSummaryMock.mockReset();
    inspectCycleLockMock.mockReset();
    discoverPowerShellExecutableMock.mockReset();
    detectCodexProcessMock.mockReset();
    loadTasksDocumentMock.mockReset();
    loadGoalsDocumentMock.mockReset();
    loadStateDocumentMock.mockReset();
    loadBlockersDocumentMock.mockReset();
    loadResultsDocumentMock.mockReset();
  });

  it("blocks automation when the background worktree branch diverges", async () => {
    detectGitRepositoryMock.mockResolvedValue({
      path: "C:/repo",
      gitDir: ".git",
      commonGitDir: "C:/repo/.git",
      head: "abc123",
      dirty: false,
      statusLines: [],
    });
    getBackgroundWorktreePathMock.mockReturnValue("C:\\repo.__codex_bg");
    getWorktreeSummaryMock.mockResolvedValue({
      path: "C:\\repo.__codex_bg",
      repoRoot: "C:/repo",
      commonGitDir: "C:/repo/.git",
      branch: "feature/manual",
      head: "abc123",
      dirty: false,
      statusLines: [],
    });
    loadTasksDocumentMock.mockResolvedValue({
      version: 1,
      tasks: [
        {
          id: "task-ready",
          goal_id: "goal-1",
          title: "Ready task",
          status: "ready",
          priority: "P1",
          depends_on: [],
          acceptance: [],
          file_hints: [],
          retry_count: 0,
          last_error: null,
          updated_at: "2026-04-12T00:00:00Z",
          commit_hash: null,
          review_status: "not_reviewed",
        },
      ],
    });
    loadGoalsDocumentMock.mockResolvedValue({
      version: 1,
      goals: [
        {
          id: "goal-1",
          title: "Goal 1",
          objective: "Ship it",
          success_criteria: ["done"],
          constraints: [],
          out_of_scope: [],
          status: "active",
          run_mode: "cruise",
          created_at: "2026-04-12T00:00:00Z",
          approved_at: "2026-04-12T00:10:00Z",
          completed_at: null,
        },
      ],
    });
    loadStateDocumentMock.mockResolvedValue({
      version: 1,
      current_goal_id: "goal-1",
      current_task_id: null,
      cycle_status: "idle",
      run_mode: "cruise",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "planned",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: null,
      autonomy_branch: "codex/autonomy",
      sprint_active: false,
      paused: false,
      pause_reason: null,
    });
    loadBlockersDocumentMock.mockResolvedValue({
      version: 1,
      blockers: [],
    });
    loadResultsDocumentMock.mockResolvedValue({
      version: 1,
      planner: { status: "planned", goal_id: "goal-1", task_id: null, summary: "planned", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      worker: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      review: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      commit: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
      reporter: { status: "not_run", goal_id: null, task_id: null, summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: null },
    });
    inspectCycleLockMock.mockResolvedValue({
      exists: false,
      stale: false,
    });
    discoverPowerShellExecutableMock.mockReturnValue("pwsh");
    detectCodexProcessMock.mockReturnValue({
      running: true,
      matches: ["Codex"],
      executable: "pwsh",
      probeOk: true,
    });

    const { runStatusCommand } = await import("../src/commands/status.js");
    const summary = await runStatusCommand("C:/repo");

    expect(summary.ready_for_automation).toBe(false);
    expect(summary.warnings?.some((warning) => warning.code === "unexpected_background_branch")).toBe(true);
  });
});
