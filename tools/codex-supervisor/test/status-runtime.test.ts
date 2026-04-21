import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detectGitRepositoryMock = vi.fn();
const getBackgroundWorktreePathMock = vi.fn();
const getWorktreeSummaryMock = vi.fn();
const inspectAutonomyCommitGateMock = vi.fn();
const inspectCycleLockMock = vi.fn();
const discoverPowerShellExecutableMock = vi.fn();
const detectCodexProcessMock = vi.fn();
const runProcessMock = vi.fn();
const inspectManagedUpgradeStateMock = vi.fn();
const loadTasksDocumentMock = vi.fn();
const loadGoalsDocumentMock = vi.fn();
const loadStateDocumentMock = vi.fn();
const loadBlockersDocumentMock = vi.fn();
const loadResultsDocumentMock = vi.fn();
const loadSettingsDocumentMock = vi.fn();
const loadVerificationDocumentMock = vi.fn();
const loadDecisionPolicyDocumentMock = vi.fn();
const loadPendingOperationMock = vi.fn();

vi.mock("../src/infra/git.js", () => ({
  DEFAULT_BACKGROUND_WORKTREE_BRANCH: "codex/background",
  detectGitRepository: detectGitRepositoryMock,
  getBackgroundWorktreePath: getBackgroundWorktreePathMock,
  getWorktreeSummary: getWorktreeSummaryMock,
  inspectAutonomyCommitGate: inspectAutonomyCommitGateMock,
}));

vi.mock("../src/infra/lock.js", () => ({
  inspectCycleLock: inspectCycleLockMock,
}));

vi.mock("../src/infra/process.js", () => ({
  discoverPowerShellExecutable: discoverPowerShellExecutableMock,
  detectCodexProcess: detectCodexProcessMock,
  isChildProcessSpawnBlocked: (error?: string) => typeof error === "string" && /\b(?:EPERM|EACCES)\b/i.test(error),
  commandSucceeded: (result: { exitCode: number | null; error?: string | undefined }) =>
    result.exitCode === 0 && !result.error,
  runProcess: runProcessMock,
}));

vi.mock("../src/commands/control-plane.js", () => ({
  loadTasksDocument: loadTasksDocumentMock,
  loadGoalsDocument: loadGoalsDocumentMock,
  loadStateDocument: loadStateDocumentMock,
  loadBlockersDocument: loadBlockersDocumentMock,
  loadResultsDocument: loadResultsDocumentMock,
  loadSettingsDocument: loadSettingsDocumentMock,
  loadVerificationDocument: loadVerificationDocumentMock,
  loadDecisionPolicyDocument: loadDecisionPolicyDocumentMock,
  loadPendingOperation: loadPendingOperationMock,
}));

vi.mock("../src/commands/upgrade-managed.js", () => ({
  inspectManagedUpgradeState: inspectManagedUpgradeStateMock,
}));

describe("status runtime gates", () => {
  beforeEach(() => {
    process.env.CODEX_THREAD_ID = "thread-123";
    vi.resetModules();
    detectGitRepositoryMock.mockReset();
    getBackgroundWorktreePathMock.mockReset();
    getWorktreeSummaryMock.mockReset();
    inspectAutonomyCommitGateMock.mockReset();
    inspectCycleLockMock.mockReset();
    discoverPowerShellExecutableMock.mockReset();
    detectCodexProcessMock.mockReset();
    runProcessMock.mockReset();
    inspectManagedUpgradeStateMock.mockReset();
    loadTasksDocumentMock.mockReset();
    loadGoalsDocumentMock.mockReset();
    loadStateDocumentMock.mockReset();
    loadBlockersDocumentMock.mockReset();
    loadResultsDocumentMock.mockReset();
    loadSettingsDocumentMock.mockReset();
    loadVerificationDocumentMock.mockReset();
    loadDecisionPolicyDocumentMock.mockReset();
    loadPendingOperationMock.mockReset();
    loadPendingOperationMock.mockResolvedValue(null);
    runProcessMock.mockImplementation((command: string, args: string[], options?: { cwd?: string }) => ({
      command,
      args,
      cwd: options?.cwd ?? "C:/repo",
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: undefined,
    }));
    inspectManagedUpgradeStateMock.mockResolvedValue({
      state: "not_installed",
      summary: null,
    });
    inspectAutonomyCommitGateMock.mockResolvedValue({
      ok: false,
      repoRoot: "C:/repo",
      expectedBranch: "codex/autonomy",
      currentBranch: "codex/autonomy",
      head: "abc123",
      dirty: false,
      hasDiff: false,
      commitReady: false,
      branchDrift: false,
      allowlist: [],
      allowedPaths: [],
      ignoredPaths: [],
      blockedPaths: [],
      allowedStatusLines: [],
      ignoredStatusLines: [],
      blockedStatusLines: [],
      statusLines: [],
      reason: "no_diff",
    });
  });

  afterEach(() => {
    delete process.env.CODEX_THREAD_ID;
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
          source: "proposal",
          source_task_id: null,
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
      sprint_active: true,
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
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
    });
    loadDecisionPolicyDocumentMock.mockResolvedValue(undefined);
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

  it("keeps automation ready when runtime shell probes are deferred inside a thread environment", async () => {
    detectGitRepositoryMock.mockResolvedValue({
      path: "C:/repo",
      gitDir: "C:/repo/.git/worktrees/codex-background",
      commonGitDir: "C:/repo/.git",
      head: "abc123",
      dirty: false,
      statusLines: [],
      probeMode: "filesystem",
    });
    getBackgroundWorktreePathMock.mockReturnValue("C:\\repo.__codex_bg");
    getWorktreeSummaryMock.mockResolvedValue({
      path: "C:\\repo.__codex_bg",
      repoRoot: "C:/repo",
      commonGitDir: "C:/repo/.git",
      branch: "codex/background",
      head: "abc123",
      dirty: false,
      statusLines: [],
      probeMode: "filesystem",
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
          source: "proposal",
          source_task_id: null,
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
          run_mode: "sprint",
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
      run_mode: "sprint",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "planned",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: "thread-123",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
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
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
    });
    inspectCycleLockMock.mockResolvedValue({
      exists: false,
      stale: false,
    });
    discoverPowerShellExecutableMock.mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    detectCodexProcessMock.mockReturnValue({
      running: false,
      matches: [],
      executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      probeOk: false,
      error: "Child process execution is blocked in this environment, so Codex process detection was skipped. spawnSync pwsh EPERM",
    });

    const { runStatusCommand } = await import("../src/commands/status.js");
    const summary = await runStatusCommand("C:/repo");

    expect(summary.ready_for_automation).toBe(true);
    expect(summary.automation_state).toBe("ready");
    expect(summary.next_automation_reason).toContain("Ready for");
    expect(summary.warnings?.some((warning) => warning.code === "git_runtime_probe_deferred")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "background_runtime_probe_deferred")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "codex_process_probe_deferred")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "not_a_git_repo")).toBe(false);
    expect(summary.warnings?.some((warning) => warning.code === "codex_process_probe_failed")).toBe(false);
  });

  it("keeps automation ready when only managed control-surface files are dirty", async () => {
    detectGitRepositoryMock.mockResolvedValue({
      path: "C:/repo",
      gitDir: ".git",
      commonGitDir: "C:/repo/.git",
      head: "abc123",
      dirty: true,
      statusLines: [" M autonomy/journal.md"],
    });
    getBackgroundWorktreePathMock.mockReturnValue("C:\\repo.__codex_bg");
    getWorktreeSummaryMock.mockResolvedValue({
      path: "C:\\repo.__codex_bg",
      repoRoot: "C:/repo",
      commonGitDir: "C:/repo/.git",
      branch: "codex/background",
      head: "abc123",
      dirty: true,
      statusLines: [" M autonomy/journal.md"],
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
          source: "proposal",
          source_task_id: null,
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
      report_thread_id: "thread-123",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
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
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
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

    expect(summary.ready_for_automation).toBe(true);
    expect(summary.auto_continue_state).toBe("running");
    expect(summary.warnings?.some((warning) => warning.code === "control_surface_dirty_only")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "ready_for_followup_autocontinue")).toBe(true);
  });

  it("does not stop automation when only advisory managed drift is present", async () => {
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
      branch: "codex/background",
      head: "abc123",
      dirty: false,
      statusLines: [],
    });
    inspectManagedUpgradeStateMock.mockResolvedValue({
      state: "managed_advisory_drift",
      summary: null,
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
          source: "proposal",
          source_task_id: null,
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
      report_thread_id: "thread-123",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
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
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
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

    expect(summary.ready_for_automation).toBe(true);
    expect(summary.automation_state).toBe("ready");
    expect(summary.upgrade_state).toBe("managed_advisory_drift");
    expect(summary.upgrade_blocking).toBe(false);
    expect(summary.upgrade_hint).toContain("rebaseline-managed");
    expect(summary.warnings?.some((warning) => warning.code === "managed_advisory_drift")).toBe(true);
    expect(summary.next_automation_reason).toContain("Ready for");
  });

  it("surfaces a recoverable closeout diff instead of a generic dirty-repo blocker", async () => {
    detectGitRepositoryMock.mockResolvedValue({
      path: "C:/repo",
      gitDir: ".git",
      commonGitDir: "C:/repo/.git",
      head: "abc123",
      dirty: true,
      statusLines: [" M docs/optimization/program-roadmap.md"],
      unmanagedDirtyPaths: ["docs/optimization/program-roadmap.md"],
      managedControlSurfaceOnly: false,
    });
    getBackgroundWorktreePathMock.mockReturnValue("C:\\repo.__codex_bg");
    getWorktreeSummaryMock.mockResolvedValue({
      path: "C:\\repo.__codex_bg",
      repoRoot: "C:/repo",
      commonGitDir: "C:/repo/.git",
      branch: "codex/background",
      head: "abc123",
      dirty: false,
      statusLines: [],
    });
    inspectAutonomyCommitGateMock.mockResolvedValue({
      ok: true,
      repoRoot: "C:/repo",
      expectedBranch: "codex/autonomy",
      currentBranch: "codex/autonomy",
      head: "abc123",
      dirty: true,
      hasDiff: true,
      commitReady: true,
      branchDrift: false,
      allowlist: ["AGENTS.md"],
      allowedPaths: ["docs/optimization/program-roadmap.md"],
      ignoredPaths: [],
      blockedPaths: [],
      allowedStatusLines: [" M docs/optimization/program-roadmap.md"],
      ignoredStatusLines: [],
      blockedStatusLines: [],
      statusLines: [" M docs/optimization/program-roadmap.md"],
      reason: "dirty_worktree",
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
          source: "proposal",
          source_task_id: null,
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
          run_mode: "sprint",
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
      run_mode: "sprint",
      last_planner_run_at: null,
      last_worker_run_at: null,
      last_result: "passed",
      consecutive_worker_failures: 0,
      needs_human_review: false,
      open_blocker_count: 0,
      report_thread_id: "thread-123",
      autonomy_branch: "codex/autonomy",
      sprint_active: true,
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
      worker: { status: "passed", goal_id: "goal-1", task_id: "task-ready", summary: "completed task-ready", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
      review: { status: "passed", goal_id: "goal-1", task_id: "task-ready", summary: "passed", happened_at: null, sent_at: null, verify_summary: null, hash: null, message: null, review_status: "passed" },
      commit: { status: "passed", goal_id: "goal-1", task_id: "task-ready", summary: null, happened_at: null, sent_at: null, verify_summary: null, hash: "abc123", message: "autonomy(goal-1/task-ready): Ready task", review_status: null },
      reporter: { status: "sent", goal_id: "goal-1", task_id: null, summary: "sent", happened_at: null, sent_at: "2026-04-13T01:00:00Z", verify_summary: null, hash: null, message: null, review_status: null },
    });
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
    });
    loadVerificationDocumentMock.mockResolvedValue({
      version: 1,
      goal_id: "goal-1",
      policy: "lightweight",
      axes: [],
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
    expect(summary.automation_state).toBe("blocked");
    expect(summary.warnings?.some((warning) => warning.code === "repo_dirty_review_recoverable")).toBe(true);
    expect(summary.warnings?.some((warning) => warning.code === "repo_dirty_unmanaged")).toBe(false);
    expect(summary.next_automation_reason).toContain("Run codex-autonomy review");
  });

  it("blocks automation when static-template managed drift is present", async () => {
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
      branch: "codex/background",
      head: "abc123",
      dirty: false,
      statusLines: [],
    });
    inspectManagedUpgradeStateMock.mockResolvedValue({
      state: "managed_diverged",
      summary: null,
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
          source: "proposal",
          source_task_id: null,
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
      report_thread_id: "thread-123",
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
    loadSettingsDocumentMock.mockResolvedValue({
      version: 1,
      install_source: "local_package",
      initial_confirmation_required: true,
      report_surface: "thread_and_inbox",
      auto_commit: "autonomy_branch",
      autonomy_branch: "codex/autonomy",
      auto_continue_within_goal: true,
      block_on_major_decision: true,
      default_cruise_cadence: {
        planner_hours: 6,
        worker_hours: 2,
        reviewer_hours: 6,
      },
      default_sprint_heartbeat_minutes: 15,
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
    expect(summary.upgrade_state).toBe("managed_diverged");
    expect(summary.warnings?.some((warning) => warning.code === "managed_diverged")).toBe(true);
  });

  it("normalizes git status paths and stabilizes after two identical snapshots", async () => {
    const statusSnapshots = [" M autonomy\\journal.md\n", " M autonomy\\journal.md\n"];
    let statusIndex = 0;

    runProcessMock.mockImplementation((command: string, args: string[], options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? "C:/repo";
      const key = `${command} ${args.join(" ")}`;

      if (key === "git rev-parse --show-toplevel") {
        return { command, args, cwd, exitCode: 0, stdout: "C:/repo\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-common-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git branch --show-current") {
        return { command, args, cwd, exitCode: 0, stdout: "codex/autonomy\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse HEAD") {
        return { command, args, cwd, exitCode: 0, stdout: "abc123\n", stderr: "", error: undefined };
      }

      if (key === "git status --porcelain=v1 --untracked-files=all") {
        const stdout = statusSnapshots[Math.min(statusIndex, statusSnapshots.length - 1)];
        statusIndex += 1;
        return { command, args, cwd, exitCode: 0, stdout, stderr: "", error: undefined };
      }

      throw new Error(`Unexpected git command: ${key}`);
    });

    const { probeWorktreeState } = await import("../src/infra/worktree-state.js");
    const probe = await probeWorktreeState("C:/repo", { debounceMs: 0 });

    expect(probe).not.toBeNull();
    expect(probe?.stable).toBe(true);
    expect(probe?.transient).toBe(false);
    expect(probe?.attempts).toBe(2);
    expect(probe?.normalizedStatusLines).toEqual([" M autonomy/journal.md"]);
    expect(probe?.managedDirtyPaths).toEqual(["autonomy/journal.md"]);
    expect(probe?.unmanagedDirtyPaths).toEqual([]);
    expect(probe?.managedControlSurfaceOnly).toBe(true);
  });

  it("reports transient_git_state when consecutive snapshots never match", async () => {
    const statusSnapshots = [
      " M autonomy\\journal.md\n",
      " M README.md\n",
      " M autonomy\\journal.md\n",
      " M README.md\n",
    ];
    let statusIndex = 0;

    runProcessMock.mockImplementation((command: string, args: string[], options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? "C:/repo";
      const key = `${command} ${args.join(" ")}`;

      if (key === "git rev-parse --show-toplevel") {
        return { command, args, cwd, exitCode: 0, stdout: "C:/repo\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-common-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git branch --show-current") {
        return { command, args, cwd, exitCode: 0, stdout: "codex/autonomy\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse HEAD") {
        return { command, args, cwd, exitCode: 0, stdout: "abc123\n", stderr: "", error: undefined };
      }

      if (key === "git status --porcelain=v1 --untracked-files=all") {
        const stdout = statusSnapshots[Math.min(statusIndex, statusSnapshots.length - 1)];
        statusIndex += 1;
        return { command, args, cwd, exitCode: 0, stdout, stderr: "", error: undefined };
      }

      throw new Error(`Unexpected git command: ${key}`);
    });

    const { probeWorktreeState } = await import("../src/infra/worktree-state.js");
    const probe = await probeWorktreeState("C:/repo", { debounceMs: 0, maxAttempts: 4 });

    expect(probe).not.toBeNull();
    expect(probe?.stable).toBe(false);
    expect(probe?.transient).toBe(true);
    expect(probe?.reason).toBe("transient_git_state");
    expect(probe?.attempts).toBe(4);
    expect(probe?.normalizedStatusLines).toEqual([" M README.md"]);
    expect(probe?.managedControlSurfaceOnly).toBe(false);
  });

  it("stabilizes HEAD together with status before reporting a worktree snapshot", async () => {
    const headSnapshots = ["abc123\n", "def456\n", "def456\n"];
    let headIndex = 0;

    runProcessMock.mockImplementation((command: string, args: string[], options?: { cwd?: string }) => {
      const cwd = options?.cwd ?? "C:/repo";
      const key = `${command} ${args.join(" ")}`;

      if (key === "git rev-parse --show-toplevel") {
        return { command, args, cwd, exitCode: 0, stdout: "C:/repo\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse --git-common-dir") {
        return { command, args, cwd, exitCode: 0, stdout: ".git\n", stderr: "", error: undefined };
      }

      if (key === "git branch --show-current") {
        return { command, args, cwd, exitCode: 0, stdout: "codex/background\n", stderr: "", error: undefined };
      }

      if (key === "git rev-parse HEAD") {
        const stdout = headSnapshots[Math.min(headIndex, headSnapshots.length - 1)];
        headIndex += 1;
        return { command, args, cwd, exitCode: 0, stdout, stderr: "", error: undefined };
      }

      if (key === "git status --porcelain=v1 --untracked-files=all") {
        return { command, args, cwd, exitCode: 0, stdout: "", stderr: "", error: undefined };
      }

      throw new Error(`Unexpected git command: ${key}`);
    });

    const { probeWorktreeState } = await import("../src/infra/worktree-state.js");
    const probe = await probeWorktreeState("C:/repo", { debounceMs: 0, maxAttempts: 4 });

    expect(probe).not.toBeNull();
    expect(probe?.stable).toBe(true);
    expect(probe?.transient).toBe(false);
    expect(probe?.head).toBe("def456");
    expect(probe?.attempts).toBe(3);
  });

  it("falls back to filesystem Git metadata when child process execution is blocked", async () => {
    runProcessMock.mockImplementation((command: string, args: string[], options?: { cwd?: string }) => ({
      command,
      args,
      cwd: options?.cwd ?? "C:/repo",
      exitCode: null,
      stdout: "",
      stderr: "",
      error: new Error(`spawnSync ${command} EPERM`).message,
    }));

    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const workspace = await mkdtemp(join(tmpdir(), "codex-status-runtime-"));
    const gitDir = join(workspace, ".git");

    await mkdir(gitDir, { recursive: true });
    await mkdir(join(gitDir, "refs", "heads", "codex"), { recursive: true });
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/codex/autonomy\n", "utf8");
    await writeFile(join(gitDir, "refs", "heads", "codex", "autonomy"), "abc123\n", "utf8");

    const { probeWorktreeState } = await import("../src/infra/worktree-state.js");
    const probe = await probeWorktreeState(workspace, { allowFilesystemFallback: true });

    expect(probe).not.toBeNull();
    expect(probe?.probeMode).toBe("filesystem");
    expect(probe?.repoRoot.replace(/\\/g, "/")).toBe(workspace.replace(/\\/g, "/"));
    expect(probe?.branch).toBe("codex/autonomy");
    expect(probe?.head).toBe("abc123");
    expect(probe?.dirty).toBe(false);
    expect(probe?.statusLines).toEqual([]);
  });
});
