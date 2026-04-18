import type {
  AutonomyResults as SharedAutonomyResults,
  AutonomySettings as SharedAutonomySettings,
  AutonomyState as SharedAutonomyState,
  AutonomyTask,
  Blocker,
  BlockerSeverity,
  BlockersDocument,
  GoalProposal,
  GoalRecord,
  GoalsDocument,
  ProposedTask,
  ProposalsDocument,
  ReviewStatus,
  RunMode,
  TasksDocument,
} from "../contracts/autonomy.js";

export {
  AUTO_COMMIT_MODES,
  AUTO_CONTINUE_STATES,
  BLOCKER_SEVERITIES,
  BLOCKER_STATUSES,
  CONTINUATION_DECISIONS,
  CYCLE_STATUSES,
  DEFAULT_AUTONOMY_BRANCH,
  DEFAULT_BACKGROUND_BRANCH,
  DEFAULT_SPRINT_HEARTBEAT_MINUTES,
  DECISION_EVENTS,
  DECISION_HEARTBEATS,
  DECISION_NEXT_ACTIONS,
  DECISION_OUTCOMES,
  GOAL_SOURCES,
  GOAL_STATUSES,
  INSTALL_SOURCES,
  LAST_RESULTS,
  PROPOSAL_STATUSES,
  READY_WINDOW_LIMIT,
  REPORT_SURFACES,
  RESULT_STATES,
  REVIEW_STATUSES,
  RUN_MODES,
  STALE_LOCK_AGE_MINUTES,
  TASK_PRIORITIES,
  TASK_PRIORITY_WEIGHT,
  TASK_SOURCES,
  TASK_STATUSES,
  VERIFICATION_AXIS_STATUSES,
  VERIFICATION_POLICIES,
} from "../contracts/autonomy.js";

export type {
  AutoCommitMode,
  AutoContinueState,
  AutomationPromptSpec,
  AutomationPromptsResult,
  BackgroundWorktreeSettings,
  Blocker,
  BlockerSeverity,
  BlockerStatus,
  BlockersDocument,
  CommandResult,
  ContinuationDecision,
  CruiseCadence,
  CycleStatus,
  DecisionAdvice,
  DecisionEvent,
  DecisionHeartbeat,
  DecisionNextAction,
  DecisionOutcome,
  DecisionPolicyDocument,
  DoctorCheck,
  DoctorResult,
  GoalProposal,
  GoalSource,
  GoalStatus,
  GoalsDocument,
  GoalRecord,
  InstallSource,
  InstallDocument,
  LastResult,
  LockRecord,
  ProposedTask,
  ProposalsDocument,
  RepoPaths,
  ReportSurface,
  ResultEntry,
  ResultState,
  ReviewStatus,
  RunMode,
  StatusSummary,
  VerificationAxis,
  VerificationAxisStatus,
  VerificationDocument,
  VerificationPolicy,
  AutonomyTask,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TasksDocument,
} from "../contracts/autonomy.js";

export type TaskRecord = AutonomyTask;
export type TasksFile = TasksDocument;
export type BlockerRecord = Blocker;
export type BlockersFile = BlockersDocument;
export type GoalDocument = GoalsDocument;
export type GoalProposalDocument = ProposalsDocument;
export type GoalResultFile = SharedAutonomyResults;
export type SettingsFile = SharedAutonomySettings;
export type AutonomyResults = SharedAutonomyResults;
export type AutonomySettings = SharedAutonomySettings;
export type AutonomyState = SharedAutonomyState;

export interface BlockerSeed {
  task_id: string;
  question: string;
  severity: BlockerSeverity;
  status: "open";
  resolution: null;
  opened_at: string;
  resolved_at: null;
}

export interface PlanningWindowOptions {
  readyLimit?: number;
  currentGoalId?: string | null;
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

export interface WorkerSuccessOptions {
  reviewStatus?: ReviewStatus;
  commitHash?: string | null;
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
  taskGoalId: string;
  currentGoalId: string | null;
  openBlockerCountForTask: number;
  dependenciesSatisfied: boolean;
  readyCount: number;
  readyLimit?: number;
}

export type UnblockRestorationReason =
  | "goal_not_active"
  | "open_blockers"
  | "dependencies_unmet"
  | "ready_window_full"
  | "ready_window_available";

export interface UnblockRestorationDecision {
  nextTaskStatus: "blocked" | "queued" | "ready";
  reason: UnblockRestorationReason;
  entersReadyWindow: boolean;
}

export interface UnblockRecoveryResult {
  task: TaskRecord;
  decision: UnblockRestorationDecision;
}

export interface GoalTransitionResult {
  goals: GoalRecord[];
  state: AutonomyState;
  activatedGoalId: string | null;
}

export interface ProposalMaterializationResult {
  tasks: TaskRecord[];
  state: AutonomyState;
  goals: GoalRecord[];
  proposals: GoalProposal[];
}

export interface GoalCompletionResult {
  goals: GoalRecord[];
  state: AutonomyState;
  completedGoalId: string | null;
  activatedGoalId: string | null;
}

export interface IntakeGoalInput {
  goal: GoalRecord;
  reportThreadId?: string | null;
}

export interface ReviewOutcome {
  task: TaskRecord;
  state: AutonomyState;
}

export interface FollowupSeed {
  goal_id: string;
  title: string;
  acceptance: string[];
  file_hints: string[];
  source_task_id: string | null;
  updated_at: string;
}

export interface FollowupTaskCreationResult {
  tasks: TaskRecord[];
  createdTask: TaskRecord | null;
  duplicateTaskId: string | null;
  loopDetected: boolean;
  blockerSeed: BlockerSeed | null;
}
