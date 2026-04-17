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

export const TASK_SOURCES = [
  "proposal",
  "followup"
] as const;

export const CONTINUATION_DECISIONS = [
  "none",
  "auto_continued",
  "needs_confirmation"
] as const;

export const VERIFICATION_POLICIES = [
  "strong_template",
] as const;

export const VERIFICATION_AXIS_STATUSES = [
  "pending",
  "passed",
  "failed",
  "blocked",
  "not_applicable",
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

export const AUTO_CONTINUE_STATES = [
  "running",
  "stopped",
  "needs_confirmation",
] as const;

export const AUTOMATION_STATES = [
  "ready",
  "in_progress",
  "paused",
  "review_pending",
  "needs_confirmation",
  "blocked",
  "idle_completed",
  "idle_no_work",
] as const;

export const THREAD_BINDING_STATES = [
  "bound_to_current",
  "bound_to_other",
  "bound_without_current_thread",
  "unbound_current_available",
  "unbound_current_unavailable",
] as const;

export const RECOMMENDED_AUTOMATION_SURFACES = [
  "thread_automation",
  "external_relay_scheduler",
  "manual_only",
] as const;

export const RECOMMENDED_AUTOMATION_PROMPTS = [
  "official_thread_automation",
  "external_relay_scheduler",
] as const;

export const MANAGED_FILE_CLASSES = [
  "static_template",
  "repo_customized",
  "runtime_state",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type RunMode = (typeof RUN_MODES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type TaskSource = (typeof TASK_SOURCES)[number];
export type ContinuationDecision = (typeof CONTINUATION_DECISIONS)[number];
export type VerificationPolicy = (typeof VERIFICATION_POLICIES)[number];
export type VerificationAxisStatus = (typeof VERIFICATION_AXIS_STATUSES)[number];
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
export type AutoContinueState = (typeof AUTO_CONTINUE_STATES)[number];
export type AutomationState = (typeof AUTOMATION_STATES)[number];
export type ManagedFileClass = (typeof MANAGED_FILE_CLASSES)[number];
export type ThreadBindingState = (typeof THREAD_BINDING_STATES)[number];
export type RecommendedAutomationSurface = (typeof RECOMMENDED_AUTOMATION_SURFACES)[number];
export type RecommendedAutomationPrompt = (typeof RECOMMENDED_AUTOMATION_PROMPTS)[number];

export interface GoalTransitionSnapshot {
  from_goal_id: string;
  to_goal_id: string;
  happened_at: string | null;
}

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
  source: TaskSource;
  source_task_id: string | null;
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
  auto_continue_within_goal: boolean;
  block_on_major_decision: boolean;
  default_cruise_cadence: CruiseCadence;
  default_sprint_heartbeat_minutes: number;
}

export interface VerificationAxis {
  id: string;
  title: string;
  required: boolean;
  status: VerificationAxisStatus;
  evidence: string[];
  source_task_id: string | null;
  last_checked_at: string | null;
  reason: string | null;
}

export interface VerificationDocument {
  version: number;
  goal_id: string | null;
  policy: VerificationPolicy;
  axes: VerificationAxis[];
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
  next_step_summary?: string | null;
  continuation_decision?: ContinuationDecision | null;
  verification_pending_axes?: string[] | null;
}

export interface AutonomyResults {
  version: number;
  last_thread_summary_sent_at?: string | null;
  last_inbox_run_at?: string | null;
  last_summary_kind?: SummaryKind | null;
  last_summary_reason?: string | null;
  latest_goal_transition?: GoalTransitionSnapshot | null;
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

export interface InstallDocument {
  version: number;
  product_version: string;
  installed_at: string;
  managed_paths: string[];
  managed_files?: ManagedInstallFile[];
  source_repo: string;
}

export interface ManagedInstallFile {
  path: string;
  template_id: string;
  installed_hash: string;
  last_reconciled_product_version: string;
  management_class: ManagedFileClass;
  baseline_origin?: "template" | "repo_specific";
  content_mode?: "full_file" | "markdown_section";
  section_start_marker?: string;
  section_end_marker?: string;
}

export interface RepoPaths {
  repoRoot: string;
  readmeFile: string;
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
  installFile: string;
  verificationFile: string;
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
  current_thread_id: string | null;
  current_thread_source: string | null;
  thread_binding_state: ThreadBindingState;
  thread_binding_hint: string | null;
  autonomy_branch: string | null;
  sprint_active: boolean;
  last_thread_summary_sent_at: string | null;
  last_inbox_run_at: string | null;
  latest_summary_kind: SummaryKind | null;
  latest_summary_reason: string | null;
  has_recorded_run: boolean;
  results_scope_note: string | null;
  next_automation_reason: string | null;
  recommended_automation_surface: RecommendedAutomationSurface;
  recommended_automation_reason: string | null;
  recommended_automation_prompt: RecommendedAutomationPrompt | null;
  automation_state: AutomationState;
  auto_continue_state: AutoContinueState;
  continuation_reason: string | null;
  closeout_policy: VerificationPolicy | null;
  verification_required: number;
  verification_passed: number;
  verification_pending: number;
  completion_blocked_by_verification: boolean;
  next_task_id: string | null;
  next_task_title: string | null;
  remaining_ready: number;
  last_followup_summary: string | null;
  upgrade_state: string | null;
  upgrade_blocking: boolean;
  upgrade_hint: string | null;
  cli_install_state: string | null;
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
  official_thread_automation: AutomationPromptSpec;
  external_relay_scheduler: AutomationPromptSpec;
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
export const DEFAULT_CRUISE_CADENCE: CruiseCadence = {
  planner_hours: 6,
  worker_hours: 2,
  reviewer_hours: 6,
};
export const STALE_LOCK_AGE_MINUTES = 45;

export const TASK_PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};
