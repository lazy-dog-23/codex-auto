export const TASK_STATUSES = [
  "queued",
  "ready",
  "in_progress",
  "verify_failed",
  "blocked",
  "done"
] as const;

export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const GOAL_STATUSES = [
  "draft",
  "awaiting_confirmation",
  "approved",
  "active",
  "completed",
  "blocked",
  "cancelled"
] as const;

export const RUN_MODES = ["sprint", "cruise"] as const;

export const REVIEW_STATUSES = [
  "not_reviewed",
  "passed",
  "followup_required"
] as const;

export const PROPOSAL_STATUSES = [
  "awaiting_confirmation",
  "approved",
  "superseded",
  "cancelled"
] as const;

export const CYCLE_STATUSES = [
  "idle",
  "planning",
  "working",
  "blocked",
  "review_pending"
] as const;

export const LAST_RESULTS = [
  "noop",
  "planned",
  "passed",
  "failed",
  "blocked"
] as const;

export const BLOCKER_STATUSES = ["open", "resolved"] as const;
export const BLOCKER_SEVERITIES = ["low", "medium", "high"] as const;
export const REPORT_SURFACES = ["thread_and_inbox"] as const;
export const INSTALL_SOURCES = ["local_package"] as const;
export const AUTO_COMMIT_MODES = ["disabled", "autonomy_branch"] as const;
export const RESULT_STATES = ["not_run", "noop", "planned", "passed", "failed", "blocked", "sent", "skipped"] as const;
export const SUMMARY_KINDS = [
  "normal_success",
  "thread_summary",
  "immediate_exception",
  "goal_transition",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type RunMode = (typeof RUN_MODES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
export type LastResult = (typeof LAST_RESULTS)[number];
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];
export type ReportSurface = (typeof REPORT_SURFACES)[number];
export type InstallSource = (typeof INSTALL_SOURCES)[number];
export type AutoCommitMode = (typeof AUTO_COMMIT_MODES)[number];
export type ResultState = (typeof RESULT_STATES)[number];
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export interface GoalRecord {
  id: string;
  title: string;
  objective: string;
  success_criteria: string[];
  constraints: string[];
  out_of_scope: string[];
  status: GoalStatus;
  run_mode: RunMode;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

export interface GoalsDocument {
  version: number;
  goals: GoalRecord[];
}

export interface ProposedTask {
  id: string;
  title: string;
  priority: TaskPriority;
  depends_on: string[];
  acceptance: string[];
  file_hints: string[];
}

export interface GoalProposal {
  goal_id: string;
  status: ProposalStatus;
  summary: string;
  tasks: ProposedTask[];
  created_at: string;
  approved_at: string | null;
}

export interface ProposalsDocument {
  version: number;
  proposals: GoalProposal[];
}

export interface AutonomyTask {
  id: string;
  goal_id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  depends_on: string[];
  acceptance: string[];
  file_hints: string[];
  retry_count: number;
  last_error: string | null;
  updated_at: string;
  commit_hash: string | null;
  review_status: ReviewStatus;
}

export interface TasksDocument {
  version: number;
  tasks: AutonomyTask[];
}

export interface CruiseCadence {
  planner_hours: number;
  worker_hours: number;
  reviewer_hours: number;
}

export interface AutonomySettings {
  version: number;
  install_source: InstallSource;
  initial_confirmation_required: boolean;
  report_surface: ReportSurface;
  auto_commit: AutoCommitMode;
  autonomy_branch: string;
  default_cruise_cadence: CruiseCadence;
  default_sprint_heartbeat_minutes: number;
}

export interface ResultEntry {
  status: ResultState;
  goal_id: string | null;
  task_id?: string | null;
  summary: string | null;
  happened_at?: string | null;
  sent_at?: string | null;
  verify_summary?: string | null;
  hash?: string | null;
  message?: string | null;
  review_status?: ReviewStatus | null;
}

export interface AutonomyResults {
  version: number;
  last_thread_summary_sent_at?: string | null;
  last_inbox_run_at?: string | null;
  last_summary_kind?: SummaryKind | null;
  last_summary_reason?: string | null;
  planner: ResultEntry;
  worker: ResultEntry;
  review: ResultEntry;
  commit: ResultEntry;
  reporter: ResultEntry;
}

export interface AutonomyState {
  version: number;
  current_goal_id: string | null;
  current_task_id: string | null;
  cycle_status: CycleStatus;
  run_mode: RunMode | null;
  last_planner_run_at: string | null;
  last_worker_run_at: string | null;
  last_result: LastResult;
  consecutive_worker_failures: number;
  needs_human_review: boolean;
  open_blocker_count: number;
  report_thread_id: string | null;
  autonomy_branch: string;
  sprint_active: boolean;
  paused: boolean;
  pause_reason: string | null;
  last_thread_summary_sent_at?: string | null;
  last_inbox_run_at?: string | null;
}

export interface Blocker {
  id: string;
  task_id: string;
  question: string;
  severity: BlockerSeverity;
  status: BlockerStatus;
  resolution: string | null;
  opened_at: string;
  resolved_at: string | null;
}

export interface BlockersDocument {
  version: number;
  blockers: Blocker[];
}

export interface RepoPaths {
  repoRoot: string;
  autonomyDir: string;
  schemaDir: string;
  locksDir: string;
  tasksFile: string;
  stateFile: string;
  blockersFile: string;
  goalsFile: string;
  proposalsFile: string;
  settingsFile: string;
  resultsFile: string;
  journalFile: string;
  goalFile: string;
  cycleLockFile: string;
  agentsFile: string;
  codexDir: string;
  environmentFile: string;
  configFile: string;
  scriptsDir: string;
  setupScript: string;
  verifyScript: string;
  smokeScript: string;
  reviewScript: string;
  cliDir: string;
  cliPackageFile: string;
}

export interface BackgroundWorktreeSettings {
  branch: string;
  path: string;
}

export interface CommandWarning {
  code: string;
  message: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
  warnings?: CommandWarning[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  details: string;
}

export interface DoctorResult extends CommandResult {
  checks: DoctorCheck[];
}

export interface StatusSummary extends CommandResult {
  total_tasks: number;
  total_goals: number;
  tasks_by_status: Record<TaskStatus, number>;
  goals_by_status: Record<GoalStatus, number>;
  current_goal_id: string | null;
  current_task_id: string | null;
  cycle_status: CycleStatus;
  run_mode: RunMode | null;
  open_blocker_count: number;
  last_result: LastResult;
  ready_for_automation: boolean;
  paused: boolean;
  review_pending_reason?: string | null;
  latest_commit_hash?: string | null;
  latest_commit_message?: string | null;
  report_thread_id: string | null;
  autonomy_branch: string | null;
  sprint_active: boolean;
  last_thread_summary_sent_at: string | null;
  last_inbox_run_at: string | null;
  latest_summary_kind: SummaryKind | null;
  latest_summary_reason: string | null;
  next_automation_reason: string | null;
  results_summary: {
    planner_summary: string | null;
    worker_result: string | null;
    review_result: string | null;
    commit_result: string | null;
    reporter_sent_at: string | null;
  } | null;
  next_automation_ready: boolean;
}

export interface AutomationPromptSpec {
  name: string;
  cadence: string;
  prompt: string;
}

export interface AutomationPromptsResult extends CommandResult {
  planner: AutomationPromptSpec;
  worker: AutomationPromptSpec;
  reviewer: AutomationPromptSpec;
  reporter: AutomationPromptSpec;
  sprint: AutomationPromptSpec;
}

export interface LockRecord {
  owner: string;
  command: string;
  pid: number;
  hostname: string;
  started_at: string;
}

export const READY_WINDOW_LIMIT = 5;
export const DEFAULT_BACKGROUND_BRANCH = "codex/background";
export const DEFAULT_AUTONOMY_BRANCH = "codex/autonomy";
export const DEFAULT_SPRINT_HEARTBEAT_MINUTES = 15;
export const STALE_LOCK_AGE_MINUTES = 45;

export const TASK_PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};
