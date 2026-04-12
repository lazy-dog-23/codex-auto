import {
  type AutonomyState,
  type BlockerRecord,
  type BlockerSeed,
  type DirtyWorktreeReviewPendingOptions,
  type DirtyWorktreeReviewPendingResult,
  type GoalCompletionResult,
  type GoalProposal,
  type GoalRecord,
  type GoalTransitionResult,
  type PlanningWindowOptions,
  type PlanningWindowResult,
  type ProposalMaterializationResult,
  type TaskRecord,
  type TaskStatus,
  type UnblockRecoveryResult,
  type UnblockRestorationDecision,
  type UnblockRestorationOptions,
  type WorkerStartResult,
  type WorkerSuccessOptions,
  type WorkerSuccessResult,
  type WorkerVerifyFailureOptions,
  type WorkerVerifyFailureResult,
  READY_WINDOW_LIMIT,
  TASK_PRIORITY_WEIGHT,
  TASK_STATUSES,
  BLOCKER_STATUSES,
} from "./types.js";

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

export function isBlockerStatus(value: string): value is BlockerRecord["status"] {
  return BLOCKER_STATUSES.includes(value as BlockerRecord["status"]);
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
  return task.depends_on.every((dependencyId) => {
    const dependency = taskIndex.get(dependencyId);
    return dependency?.goal_id === task.goal_id && dependency.status === "done";
  });
}

export function isPlanningCandidate(
  task: TaskRecord,
  taskIndex: Map<string, TaskRecord>,
  currentGoalId: string | null,
): boolean {
  if (task.status !== "queued" && task.status !== "ready") {
    return false;
  }

  if (!currentGoalId || task.goal_id !== currentGoalId) {
    return false;
  }

  return areDependenciesSatisfied(task, taskIndex);
}

export function rebalanceTaskWindow(
  tasks: readonly TaskRecord[],
  options: PlanningWindowOptions = {},
): PlanningWindowResult {
  const readyLimit = Math.max(0, options.readyLimit ?? READY_WINDOW_LIMIT);
  const currentGoalId = options.currentGoalId ?? null;
  const taskIndex = buildTaskIndex(tasks);
  const candidates = tasks.filter((task) => isPlanningCandidate(task, taskIndex, currentGoalId));
  const selectedIds = new Set(
    [...candidates]
      .sort(compareTaskPriority)
      .slice(0, readyLimit)
      .map((task) => task.id),
  );

  const updatedTasks = tasks.map((task) => {
    if (task.status !== "queued" && task.status !== "ready") {
      return task;
    }

    const eligible = isPlanningCandidate(task, taskIndex, currentGoalId);
    const nextStatus: TaskStatus = eligible && selectedIds.has(task.id) ? "ready" : "queued";
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
    .filter((task) => task.status === "ready")
    .map((task) => task.id)
    .filter((taskId) => originalStatusById.get(taskId) === "queued");
  const demotedTaskIds = updatedTasks
    .filter((task) => task.status === "queued")
    .map((task) => task.id)
    .filter((taskId) => originalStatusById.get(taskId) === "ready");

  const readyTasks = updatedTasks.filter((task) => task.status === "ready").sort(compareTaskPriority);
  const queuedTasks = updatedTasks.filter((task) => task.status === "queued").sort(compareTaskPriority);

  return {
    tasks: updatedTasks,
    readyTaskIds: readyTasks.map((task) => task.id),
    queuedTaskIds: queuedTasks.map((task) => task.id),
    promotedTaskIds,
    demotedTaskIds,
  };
}

export function startWorkerTask(task: TaskRecord, state: AutonomyState, now: string): WorkerStartResult {
  if (task.status !== "ready") {
    throw new Error(`Worker can only start a task in ready status. Received ${task.status}.`);
  }

  if (state.current_goal_id && task.goal_id !== state.current_goal_id) {
    throw new Error(`Worker can only start tasks for goal ${state.current_goal_id}. Received ${task.goal_id}.`);
  }

  return {
    task: {
      ...task,
      status: "in_progress",
      updated_at: now,
    },
    state: {
      ...state,
      current_task_id: task.id,
      current_goal_id: task.goal_id,
      cycle_status: "working",
      last_worker_run_at: now,
    },
  };
}

export function completeWorkerTask(
  task: TaskRecord,
  state: AutonomyState,
  now: string,
  options: WorkerSuccessOptions = {},
): WorkerSuccessResult {
  if (task.status !== "in_progress") {
    throw new Error(`Worker can only complete a task in in_progress status. Received ${task.status}.`);
  }

  if (state.current_task_id !== null && state.current_task_id !== task.id) {
    throw new Error(`Worker state does not point at task ${task.id}.`);
  }

  return {
    task: {
      ...task,
      status: "done",
      last_error: null,
      updated_at: now,
      commit_hash: options.commitHash ?? task.commit_hash,
      review_status: options.reviewStatus ?? task.review_status,
    },
    state: {
      ...state,
      current_task_id: null,
      current_goal_id: task.goal_id,
      cycle_status: "idle",
      last_worker_run_at: now,
      last_result: "passed",
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
  if (task.status !== "in_progress") {
    throw new Error(`Worker can only fail verification from in_progress status. Received ${task.status}.`);
  }

  if (state.current_task_id !== null && state.current_task_id !== task.id) {
    throw new Error(`Worker state does not point at task ${task.id}.`);
  }

  const escalatedToBlocked = Boolean(options.ambiguity) || task.retry_count >= 1;
  const blockerSeed: BlockerSeed | null = escalatedToBlocked
    ? {
        task_id: task.id,
        question: options.question ?? options.reason ?? "What needs to change before this task can run again?",
        severity: options.severity ?? (options.ambiguity ? "high" : "medium"),
        status: "open",
        resolution: null,
        opened_at: now,
        resolved_at: null,
      }
    : null;

  return {
    task: {
      ...task,
      status: escalatedToBlocked ? "blocked" : "verify_failed",
      retry_count: task.retry_count + 1,
      last_error: options.reason ?? task.last_error ?? "Verification failed.",
      updated_at: now,
    },
    state: {
      ...state,
      current_task_id: null,
      current_goal_id: task.goal_id,
      cycle_status: "blocked",
      last_worker_run_at: now,
      last_result: "failed",
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
      cycle_status: "review_pending",
      last_worker_run_at: now,
      last_result: "blocked",
      needs_human_review: true,
    },
  };
}

export function countOpenBlockers(blockers: readonly BlockerRecord[]): number {
  return blockers.filter((blocker) => blocker.status === "open").length;
}

export function countOpenBlockersForTask(blockers: readonly BlockerRecord[], taskId: string): number {
  return blockers.filter((blocker) => blocker.task_id === taskId && blocker.status === "open").length;
}

export function reconcileOpenBlockerCount(state: AutonomyState, blockers: readonly BlockerRecord[]): AutonomyState {
  return {
    ...state,
    open_blocker_count: countOpenBlockers(blockers),
  };
}

export function decideUnblockRestoration(options: UnblockRestorationOptions): UnblockRestorationDecision {
  const readyLimit = Math.max(0, options.readyLimit ?? READY_WINDOW_LIMIT);

  if (options.taskGoalId !== options.currentGoalId) {
    return {
      nextTaskStatus: "queued",
      reason: "goal_not_active",
      entersReadyWindow: false,
    };
  }

  if (options.openBlockerCountForTask > 0) {
    return {
      nextTaskStatus: "blocked",
      reason: "open_blockers",
      entersReadyWindow: false,
    };
  }

  if (!options.dependenciesSatisfied) {
    return {
      nextTaskStatus: "queued",
      reason: "dependencies_unmet",
      entersReadyWindow: false,
    };
  }

  if (options.readyCount < readyLimit) {
    return {
      nextTaskStatus: "ready",
      reason: "ready_window_available",
      entersReadyWindow: true,
    };
  }

  return {
    nextTaskStatus: "queued",
    reason: "ready_window_full",
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
      last_error: decision.nextTaskStatus === "blocked" ? task.last_error : null,
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

export function pickNextApprovedGoal(goals: readonly GoalRecord[]): GoalRecord | null {
  const approvedGoals = goals.filter((goal) => goal.status === "approved");
  if (approvedGoals.length === 0) {
    return null;
  }

  return [...approvedGoals].sort((left, right) => {
    const leftKey = left.approved_at ?? left.created_at;
    const rightKey = right.approved_at ?? right.created_at;
    const timeDiff = leftKey.localeCompare(rightKey);
    if (timeDiff !== 0) {
      return timeDiff;
    }

    return left.id.localeCompare(right.id);
  })[0] ?? null;
}

export function activateGoal(goals: readonly GoalRecord[], state: AutonomyState, goalId: string): GoalTransitionResult {
  const targetGoal = goals.find((goal) => goal.id === goalId);
  if (!targetGoal) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const updatedGoals: GoalRecord[] = goals.map((goal) => {
    if (goal.id === goalId) {
      return {
        ...goal,
        status: "active" as const,
      };
    }

    if (goal.status === "active" && goal.id !== goalId) {
      return {
        ...goal,
        status: "approved" as const,
      };
    }

    return goal;
  });

  return {
    goals: updatedGoals,
    state: {
      ...state,
      current_goal_id: goalId,
      run_mode: targetGoal.run_mode,
      sprint_active: targetGoal.run_mode === "sprint",
    },
    activatedGoalId: goalId,
  };
}

export function materializeProposal(
  goals: readonly GoalRecord[],
  proposals: readonly GoalProposal[],
  existingTasks: readonly TaskRecord[],
  state: AutonomyState,
  goalId: string,
  now: string,
): ProposalMaterializationResult {
  const goal = goals.find((entry) => entry.id === goalId);
  if (!goal) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const proposal = proposals.find((entry) => entry.goal_id === goalId && entry.status === "awaiting_confirmation");
  if (!proposal) {
    throw new Error(`Awaiting proposal not found for goal ${goalId}`);
  }

  const materializedTasks = proposal.tasks.map((task) => ({
    id: task.id,
    goal_id: goalId,
    title: task.title,
    status: "queued" as const,
    priority: task.priority,
    depends_on: [...task.depends_on],
    acceptance: [...task.acceptance],
    file_hints: [...task.file_hints],
    retry_count: 0,
    last_error: null,
    updated_at: now,
    commit_hash: null,
    review_status: "not_reviewed" as const,
  }));

  const taskIds = new Set(materializedTasks.map((task) => task.id));
  const mergedTasks = [
    ...existingTasks.filter((task) => !(task.goal_id === goalId && taskIds.has(task.id))),
    ...materializedTasks,
  ];

  const existingActiveGoal = goals.find((entry) => entry.status === "active");
  const updatedGoals: GoalRecord[] = goals.map((entry) => {
    if (entry.id !== goalId) {
      return entry;
    }

    const shouldActivate = existingActiveGoal === undefined || existingActiveGoal.id === goalId;
    return {
      ...entry,
      status: shouldActivate ? ("active" as const) : ("approved" as const),
      approved_at: entry.approved_at ?? now,
    };
  });

  const updatedProposals = proposals.map((entry) => {
    if (entry.goal_id !== goalId) {
      return entry;
    }

    return {
      ...entry,
      status: "approved" as const,
      approved_at: now,
    };
  });

  const shouldActivate = existingActiveGoal === undefined || existingActiveGoal.id === goalId;
  const nextState: AutonomyState = shouldActivate
    ? {
        ...state,
        current_goal_id: goalId,
        run_mode: goal.run_mode,
        sprint_active: goal.run_mode === "sprint",
      }
    : state;

  return {
    tasks: mergedTasks,
    goals: updatedGoals,
    proposals: updatedProposals,
    state: nextState,
  };
}

export function completeCurrentGoalIfEligible(
  goals: readonly GoalRecord[],
  tasks: readonly TaskRecord[],
  state: AutonomyState,
  now: string,
): GoalCompletionResult {
  const currentGoalId = state.current_goal_id;
  if (!currentGoalId) {
    return {
      goals: [...goals],
      state,
      completedGoalId: null,
      activatedGoalId: null,
    };
  }

  const currentGoalTasks = tasks.filter((task) => task.goal_id === currentGoalId);
  if (currentGoalTasks.length === 0 || currentGoalTasks.some((task) => task.status !== "done")) {
    return {
      goals: [...goals],
      state,
      completedGoalId: null,
      activatedGoalId: null,
    };
  }

  let updatedGoals = goals.map((goal) => {
    if (goal.id !== currentGoalId) {
      return goal;
    }

    return {
      ...goal,
      status: "completed" as const,
      completed_at: now,
    };
  });

  let nextState: AutonomyState = {
    ...state,
    current_goal_id: null,
    run_mode: null,
    sprint_active: false,
  };

  const nextGoal = pickNextApprovedGoal(updatedGoals);
  if (nextGoal) {
    const activated = activateGoal(updatedGoals, nextState, nextGoal.id);
    updatedGoals = activated.goals;
    nextState = activated.state;
  }

  return {
    goals: updatedGoals,
    state: nextState,
    completedGoalId: currentGoalId,
    activatedGoalId: nextGoal?.id ?? null,
  };
}
