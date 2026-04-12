import type { AutonomyState as SharedAutonomyState, AutonomyTask, Blocker, BlockerSeverity, BlockersDocument, TasksDocument } from '../contracts/autonomy.js';

export {
  BLOCKER_SEVERITIES,
  BLOCKER_STATUSES,
  CYCLE_STATUSES,
  DEFAULT_BACKGROUND_BRANCH,
  LAST_RESULTS,
  READY_WINDOW_LIMIT,
  STALE_LOCK_AGE_MINUTES,
  TASK_PRIORITIES,
  TASK_PRIORITY_WEIGHT,
  TASK_STATUSES,
} from '../contracts/autonomy.js';

export type {
  AutomationPromptSpec,
  AutomationPromptsResult,
  BackgroundWorktreeSettings,
  Blocker,
  BlockerSeverity,
  BlockerStatus,
  BlockersDocument,
  CommandResult,
  CycleStatus,
  DoctorCheck,
  DoctorResult,
  LastResult,
  LockRecord,
  RepoPaths,
  StatusSummary,
  AutonomyTask,
  TaskPriority,
  TaskStatus,
  TasksDocument,
} from '../contracts/autonomy.js';

export type TaskRecord = AutonomyTask;
export type TasksFile = TasksDocument;
export type BlockerRecord = Blocker;
export type BlockersFile = BlockersDocument;
export type AutonomyState = SharedAutonomyState;

export interface BlockerSeed {
  task_id: string;
  question: string;
  severity: BlockerSeverity;
  status: 'open';
  resolution: null;
  opened_at: string;
  resolved_at: null;
}

export interface PlanningWindowOptions {
  readyLimit?: number;
}

export interface PlanningWindowResult {
  tasks: TaskRecord[];
  readyTaskIds: string[];
  queuedTaskIds: string[];
  promotedTaskIds: string[];
  demotedTaskIds: string[];
}

export interface WorkerStartResult {
  task: TaskRecord;
  state: AutonomyState;
}

export interface WorkerSuccessResult {
  task: TaskRecord;
  state: AutonomyState;
}

export interface WorkerVerifyFailureOptions {
  reason?: string;
  question?: string;
  severity?: BlockerSeverity;
  ambiguity?: boolean;
}

export interface WorkerVerifyFailureResult {
  task: TaskRecord;
  state: AutonomyState;
  blockerSeed: BlockerSeed | null;
  escalatedToBlocked: boolean;
}

export interface DirtyWorktreeReviewPendingOptions {
  keepCurrentTaskId?: boolean;
}

export interface DirtyWorktreeReviewPendingResult {
  state: AutonomyState;
}

export interface UnblockRestorationOptions {
  openBlockerCountForTask: number;
  dependenciesSatisfied: boolean;
  readyCount: number;
  readyLimit?: number;
}

export type UnblockRestorationReason =
  | 'open_blockers'
  | 'dependencies_unmet'
  | 'ready_window_full'
  | 'ready_window_available';

export interface UnblockRestorationDecision {
  nextTaskStatus: 'blocked' | 'queued' | 'ready';
  reason: UnblockRestorationReason;
  entersReadyWindow: boolean;
}

export interface UnblockRecoveryResult {
  task: TaskRecord;
  decision: UnblockRestorationDecision;
}
