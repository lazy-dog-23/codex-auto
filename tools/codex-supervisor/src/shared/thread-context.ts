export const CURRENT_THREAD_ENV_KEY = "CODEX_THREAD_ID";

export const THREAD_BINDING_STATES = [
  "bound_to_current",
  "bound_to_other",
  "bound_without_current_thread",
  "unbound_current_available",
  "unbound_current_unavailable",
] as const;

export type ThreadBindingState = (typeof THREAD_BINDING_STATES)[number];

export const OPERATOR_THREAD_ACTIONS = [
  "already_bound",
  "bind_current_thread",
  "bind_explicit_thread",
  "continue_from_bound_thread",
  "continue_from_bound_thread_or_explicit_rebind",
] as const;

export type OperatorThreadAction = (typeof OPERATOR_THREAD_ACTIONS)[number];

export interface CurrentThreadContext {
  currentThreadId: string | null;
  currentThreadAvailable: boolean;
  currentThreadSource: string | null;
}

export interface ThreadBindingContext extends CurrentThreadContext {
  reportThreadId: string | null;
  bindingState: ThreadBindingState;
  bindingHint: string | null;
}

export interface OperatorThreadGuidance {
  nextOperatorAction: OperatorThreadAction;
  nextOperatorCommand: string | null;
}

export function resolveCurrentThreadContext(env: NodeJS.ProcessEnv = process.env): CurrentThreadContext {
  const rawThreadId = env[CURRENT_THREAD_ENV_KEY];
  const currentThreadId = typeof rawThreadId === "string" && rawThreadId.trim().length > 0
    ? rawThreadId.trim()
    : null;

  return {
    currentThreadId,
    currentThreadAvailable: currentThreadId !== null,
    currentThreadSource: currentThreadId ? CURRENT_THREAD_ENV_KEY : null,
  };
}

export function inspectThreadBindingContext(
  reportThreadId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ThreadBindingContext {
  const currentThread = resolveCurrentThreadContext(env);
  const normalizedReportThreadId = typeof reportThreadId === "string" && reportThreadId.trim().length > 0
    ? reportThreadId.trim()
    : null;

  if (normalizedReportThreadId) {
    if (currentThread.currentThreadId && normalizedReportThreadId === currentThread.currentThreadId) {
      return {
        ...currentThread,
        reportThreadId: normalizedReportThreadId,
        bindingState: "bound_to_current",
        bindingHint: `Current operator thread ${normalizedReportThreadId} is already bound as report_thread_id.`,
      };
    }

    if (currentThread.currentThreadId) {
      return {
        ...currentThread,
        reportThreadId: normalizedReportThreadId,
        bindingState: "bound_to_other",
        bindingHint: `This repo is bound to report_thread_id ${normalizedReportThreadId}, but the current thread is ${currentThread.currentThreadId}. Continue from the bound thread or explicitly rebind with codex-autonomy bind-thread --report-thread-id ${currentThread.currentThreadId}.`,
      };
    }

    return {
      ...currentThread,
      reportThreadId: normalizedReportThreadId,
      bindingState: "bound_without_current_thread",
      bindingHint: `report_thread_id is bound to ${normalizedReportThreadId}, but the current thread identity is unavailable in this environment.`,
    };
  }

  if (currentThread.currentThreadId) {
    return {
      ...currentThread,
      reportThreadId: null,
      bindingState: "unbound_current_available",
      bindingHint: `Current thread identity is available as ${currentThread.currentThreadId}. Run codex-autonomy bind-thread from this operator thread to bind report_thread_id automatically.`,
    };
  }

  return {
    ...currentThread,
    reportThreadId: null,
    bindingState: "unbound_current_unavailable",
    bindingHint: "Current thread identity is unavailable in this environment. Run codex-autonomy bind-thread --report-thread-id <id> to bind the operator thread explicitly.",
  };
}

export function resolveReportThreadBinding(options: {
  explicitReportThreadId?: string | null | undefined;
  existingReportThreadId?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): {
  reportThreadId: string | null;
  source: "explicit" | "existing" | "current_thread" | "missing";
  threadContext: ThreadBindingContext;
} {
  const explicitReportThreadId = typeof options.explicitReportThreadId === "string" && options.explicitReportThreadId.trim().length > 0
    ? options.explicitReportThreadId.trim()
    : null;
  const existingReportThreadId = typeof options.existingReportThreadId === "string" && options.existingReportThreadId.trim().length > 0
    ? options.existingReportThreadId.trim()
    : null;
  const threadContext = inspectThreadBindingContext(existingReportThreadId, options.env);

  if (explicitReportThreadId) {
    return {
      reportThreadId: explicitReportThreadId,
      source: "explicit",
      threadContext,
    };
  }

  if (existingReportThreadId) {
    return {
      reportThreadId: existingReportThreadId,
      source: "existing",
      threadContext,
    };
  }

  if (threadContext.currentThreadId) {
    return {
      reportThreadId: threadContext.currentThreadId,
      source: "current_thread",
      threadContext,
    };
  }

  return {
    reportThreadId: null,
    source: "missing",
    threadContext,
  };
}

export function getOperatorThreadGuidance(threadContext: ThreadBindingContext): OperatorThreadGuidance {
  switch (threadContext.bindingState) {
    case "bound_to_current":
      return {
        nextOperatorAction: "already_bound",
        nextOperatorCommand: null,
      };
    case "bound_to_other":
      return {
        nextOperatorAction: "continue_from_bound_thread_or_explicit_rebind",
        nextOperatorCommand: threadContext.currentThreadId
          ? `codex-autonomy bind-thread --report-thread-id ${threadContext.currentThreadId}`
          : null,
      };
    case "bound_without_current_thread":
      return {
        nextOperatorAction: "continue_from_bound_thread",
        nextOperatorCommand: null,
      };
    case "unbound_current_available":
      return {
        nextOperatorAction: "bind_current_thread",
        nextOperatorCommand: "codex-autonomy bind-thread",
      };
    case "unbound_current_unavailable":
      return {
        nextOperatorAction: "bind_explicit_thread",
        nextOperatorCommand: "codex-autonomy bind-thread --report-thread-id <id>",
      };
  }
}
