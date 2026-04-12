export const TASK_STATUSES = [
  "queued",
  "ready",
  "in_progress",
  "verify_failed",
  "blocked",
  "done"
] as const;

export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

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

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
export type LastResult = (typeof LAST_RESULTS)[number];
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

export interface AutonomyTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  depends_on: string[];
  acceptance: string[];
  file_hints: string[];
  retry_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface TasksDocument {
  version: number;
  tasks: AutonomyTask[];
}

export interface AutonomyState {
  version: number;
  current_task_id: string | null;
  cycle_status: CycleStatus;
  last_planner_run_at: string | null;
  last_worker_run_at: string | null;
  last_result: LastResult;
  consecutive_worker_failures: number;
  needs_human_review: boolean;
  open_blocker_count: number;
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
  tasks_by_status: Record<TaskStatus, number>;
  current_task_id: string | null;
  cycle_status: CycleStatus;
  open_blocker_count: number;
  last_result: LastResult;
  ready_for_automation: boolean;
}

export interface AutomationPromptSpec {
  name: string;
  cadence: string;
  prompt: string;
}

export interface AutomationPromptsResult extends CommandResult {
  planner: AutomationPromptSpec;
  worker: AutomationPromptSpec;
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
export const STALE_LOCK_AGE_MINUTES = 45;

export const TASK_PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};
