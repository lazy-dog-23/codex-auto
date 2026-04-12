import { beforeEach, describe, expect, it, vi } from "vitest";

const detectGitRepositoryMock = vi.fn();
const getBackgroundWorktreePathMock = vi.fn();
const getWorktreeSummaryMock = vi.fn();
const readJsonFileMock = vi.fn();
const inspectCycleLockMock = vi.fn();
const discoverPowerShellExecutableMock = vi.fn();
const detectCodexProcessMock = vi.fn();

vi.mock("../src/infra/git.js", () => ({
  DEFAULT_BACKGROUND_WORKTREE_BRANCH: "codex/background",
  detectGitRepository: detectGitRepositoryMock,
  getBackgroundWorktreePath: getBackgroundWorktreePathMock,
  getWorktreeSummary: getWorktreeSummaryMock,
}));

vi.mock("../src/infra/json.js", () => ({
  readJsonFile: readJsonFileMock,
}));

vi.mock("../src/infra/lock.js", () => ({
  inspectCycleLock: inspectCycleLockMock,
}));

vi.mock("../src/infra/process.js", () => ({
  discoverPowerShellExecutable: discoverPowerShellExecutableMock,
  detectCodexProcess: detectCodexProcessMock,
}));

describe("status runtime gates", () => {
  beforeEach(() => {
    vi.resetModules();
    detectGitRepositoryMock.mockReset();
    getBackgroundWorktreePathMock.mockReset();
    getWorktreeSummaryMock.mockReset();
    readJsonFileMock.mockReset();
    inspectCycleLockMock.mockReset();
    discoverPowerShellExecutableMock.mockReset();
    detectCodexProcessMock.mockReset();
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
    readJsonFileMock
      .mockResolvedValueOnce({
        version: 1,
        tasks: [
          {
            id: "task-ready",
            title: "Ready task",
            status: "ready",
            priority: "P1",
            depends_on: [],
            acceptance: [],
            file_hints: [],
            retry_count: 0,
            last_error: null,
            updated_at: "2026-04-12T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        version: 1,
        current_task_id: null,
        cycle_status: "idle",
        last_planner_run_at: null,
        last_worker_run_at: null,
        last_result: "planned",
        consecutive_worker_failures: 0,
        needs_human_review: false,
        open_blocker_count: 0,
      })
      .mockResolvedValueOnce({
        version: 1,
        blockers: [],
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
