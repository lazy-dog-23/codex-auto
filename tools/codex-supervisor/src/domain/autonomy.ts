import {
  type AutonomyState,
  type BlockerRecord,
  type BlockerSeed,
  type DirtyWorktreeReviewPendingOptions,
  type DirtyWorktreeReviewPendingResult,
  type PlanningWindowOptions,
  type PlanningWindowResult,
  type TaskRecord,
  type TaskStatus,
  type UnblockRecoveryResult,
  type UnblockRestorationDecision,
  type UnblockRestorationOptions,
  type WorkerStartResult,
  type WorkerSuccessResult,
  type WorkerVerifyFailureOptions,
  type WorkerVerifyFailureResult,
  READY_WINDOW_LIMIT,
  TASK_PRIORITY_WEIGHT,
  TASK_STATUSES,
  BLOCKER_STATUSES,
} from './types.js';

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

export function isBlockerStatus(value: string): value is BlockerRecord['status'] {
  return BLOCKER_STATUSES.includes(value as BlockerRecord['status']);
}

export function compareTaskPriority(left: TaskRecord, right: TaskRecord): number {
  const priorityDiff = TASK_PRIORITY_WEIGHT[left.priority] - TASK_PRIORITY_WEIGHT[right.priority];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const timeDiff = left.updated_at.localeCompare(right.updated_at);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.id.localeCompare(right.id);
}

export function buildTaskIndex(tasks: readonly TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((task) => [task.id, task]));
}

export function areDependenciesSatisfied(task: TaskRecord, taskIndex: Map<string, TaskRecord>): boolean {
  return task.depends_on.every((dependencyId) => taskIndex.get(dependencyId)?.status === 'done');
}

export function isPlanningCandidate(task: TaskRecord, taskIndex: Map<string, TaskRecord>): boolean {
  if (task.status !== 'queued' && task.status !== 'ready') {
    return false;
  }

  return areDependenciesSatisfied(task, taskIndex);
}

export function rebalanceTaskWindow(tasks: readonly TaskRecord[], options: PlanningWindowOptions = {}): PlanningWindowResult {
  const readyLimit = Math.max(0, options.readyLimit ?? READY_WINDOW_LIMIT);
  const taskIndex = buildTaskIndex(tasks);
  const candidates = tasks.filter((task) => isPlanningCandidate(task, taskIndex));
  const selectedIds = new Set(
    [...candidates]
      .sort(compareTaskPriority)
      .slice(0, readyLimit)
      .map((task) => task.id),
  );

  const updatedTasks = tasks.map((task) => {
    if (task.status !== 'queued' && task.status !== 'ready') {
      return task;
    }

    const eligible = isPlanningCandidate(task, taskIndex);
    const nextStatus: TaskStatus = eligible && selectedIds.has(task.id) ? 'ready' : 'queued';

    if (task.status === nextStatus) {
      return task;
    }

    return {
      ...task,
      status: nextStatus,
    };
  });

  const originalStatusById = new Map(tasks.map((task) => [task.id, task.status]));
  const promotedTaskIds = updatedTasks
    .filter((task) => task.status === 'ready')
    .map((task) => task.id)
    .filter((taskId) => originalStatusById.get(taskId) === 'queued');

  const demotedTaskIds = updatedTasks
    .filter((task) => task.status === 'queued')
    .map((task) => task.id)
    .filter((taskId) => originalStatusById.get(taskId) === 'ready');

  const readyTasks = updatedTasks.filter((task) => task.status === 'ready').sort(compareTaskPriority);
  const queuedTasks = updatedTasks.filter((task) => task.status === 'queued').sort(compareTaskPriority);

  return {
    tasks: updatedTasks,
    readyTaskIds: readyTasks.map((task) => task.id),
    queuedTaskIds: queuedTasks.map((task) => task.id),
    promotedTaskIds,
    demotedTaskIds,
  };
}

export function startWorkerTask(task: TaskRecord, state: AutonomyState, now: string): WorkerStartResult {
  if (task.status !== 'ready') {
    throw new Error(`Worker can only start a task in ready status. Received ${task.status}.`);
  }

  return {
    task: {
      ...task,
      status: 'in_progress',
      updated_at: now,
    },
    state: {
      ...state,
      current_task_id: task.id,
      cycle_status: 'working',
      last_worker_run_at: now,
    },
  };
}

export function completeWorkerTask(task: TaskRecord, state: AutonomyState, now: string): WorkerSuccessResult {
  if (task.status !== 'in_progress') {
    throw new Error(`Worker can only complete a task in in_progress status. Received ${task.status}.`);
  }

  if (state.current_task_id !== null && state.current_task_id !== task.id) {
    throw new Error(`Worker state does not point at task ${task.id}.`);
  }

  return {
    task: {
      ...task,
      status: 'done',
      last_error: null,
      updated_at: now,
    },
    state: {
      ...state,
      current_task_id: null,
      cycle_status: 'idle',
      last_worker_run_at: now,
      last_result: 'passed',
      consecutive_worker_failures: 0,
      needs_human_review: false,
    },
  };
}

export function failWorkerVerification(
  task: TaskRecord,
  state: AutonomyState,
  now: string,
  options: WorkerVerifyFailureOptions = {},
): WorkerVerifyFailureResult {
  if (task.status !== 'in_progress') {
    throw new Error(`Worker can only fail verification from in_progress status. Received ${task.status}.`);
  }

  if (state.current_task_id !== null && state.current_task_id !== task.id) {
    throw new Error(`Worker state does not point at task ${task.id}.`);
  }

  const escalatedToBlocked = Boolean(options.ambiguity) || task.retry_count >= 1;
  const blockerSeed: BlockerSeed | null = escalatedToBlocked
    ? {
        task_id: task.id,
        question: options.question ?? options.reason ?? 'What needs to change before this task can run again?',
        severity: options.severity ?? (options.ambiguity ? 'high' : 'medium'),
        status: 'open',
        resolution: null,
        opened_at: now,
        resolved_at: null,
      }
    : null;

  return {
    task: {
      ...task,
      status: escalatedToBlocked ? 'blocked' : 'verify_failed',
      retry_count: task.retry_count + 1,
      last_error: options.reason ?? task.last_error ?? 'Verification failed.',
      updated_at: now,
    },
    state: {
      ...state,
      current_task_id: null,
      cycle_status: 'blocked',
      last_worker_run_at: now,
      last_result: 'failed',
      consecutive_worker_failures: state.consecutive_worker_failures + 1,
      needs_human_review: escalatedToBlocked,
      open_blocker_count: state.open_blocker_count + (escalatedToBlocked ? 1 : 0),
    },
    blockerSeed,
    escalatedToBlocked,
  };
}

export function shouldEnterReviewPendingForDirtyWorktree(isDirty: boolean): boolean {
  return isDirty;
}

export function enterReviewPendingForDirtyWorktree(
  state: AutonomyState,
  now: string,
  options: DirtyWorktreeReviewPendingOptions = {},
): DirtyWorktreeReviewPendingResult {
  return {
    state: {
      ...state,
      current_task_id: options.keepCurrentTaskId === false ? null : state.current_task_id,
      cycle_status: 'review_pending',
      last_worker_run_at: now,
      last_result: 'blocked',
      needs_human_review: true,
    },
  };
}

export function countOpenBlockers(blockers: readonly BlockerRecord[]): number {
  return blockers.filter((blocker) => blocker.status === 'open').length;
}

export function countOpenBlockersForTask(blockers: readonly BlockerRecord[], taskId: string): number {
  return blockers.filter((blocker) => blocker.task_id === taskId && blocker.status === 'open').length;
}

export function reconcileOpenBlockerCount(state: AutonomyState, blockers: readonly BlockerRecord[]): AutonomyState {
  return {
    ...state,
    open_blocker_count: countOpenBlockers(blockers),
  };
}

export function decideUnblockRestoration(options: UnblockRestorationOptions): UnblockRestorationDecision {
  const readyLimit = Math.max(0, options.readyLimit ?? READY_WINDOW_LIMIT);

  if (options.openBlockerCountForTask > 0) {
    return {
      nextTaskStatus: 'blocked',
      reason: 'open_blockers',
      entersReadyWindow: false,
    };
  }

  if (!options.dependenciesSatisfied) {
    return {
      nextTaskStatus: 'queued',
      reason: 'dependencies_unmet',
      entersReadyWindow: false,
    };
  }

  if (options.readyCount < readyLimit) {
    return {
      nextTaskStatus: 'ready',
      reason: 'ready_window_available',
      entersReadyWindow: true,
    };
  }

  return {
    nextTaskStatus: 'queued',
    reason: 'ready_window_full',
    entersReadyWindow: false,
  };
}

export function applyUnblockRestoration(
  task: TaskRecord,
  decision: UnblockRestorationDecision,
  now: string,
): UnblockRecoveryResult {
  return {
    task: {
      ...task,
      status: decision.nextTaskStatus,
      last_error: decision.nextTaskStatus === 'blocked' ? task.last_error : null,
      updated_at: now,
    },
    decision,
  };
}

export function resolveTaskAfterUnblock(
  task: TaskRecord,
  decision: UnblockRestorationDecision,
  now: string,
): UnblockRecoveryResult {
  return applyUnblockRestoration(task, decision, now);
}
