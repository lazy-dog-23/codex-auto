import { describe, expect, it } from "vitest";

import {
  inspectThreadBindingContext,
  resolveCurrentThreadContext,
  resolveReportThreadBinding,
} from "../src/shared/thread-context.js";

describe("thread context helpers", () => {
  it("reads the current thread id from CODEX_THREAD_ID", () => {
    const context = resolveCurrentThreadContext({
      CODEX_THREAD_ID: "thread-123",
    });

    expect(context.currentThreadId).toBe("thread-123");
    expect(context.currentThreadAvailable).toBe(true);
    expect(context.currentThreadSource).toBe("CODEX_THREAD_ID");
  });

  it("reports a mismatch when the current thread differs from report_thread_id", () => {
    const context = inspectThreadBindingContext("thread-bound", {
      CODEX_THREAD_ID: "thread-current",
    });

    expect(context.bindingState).toBe("bound_to_other");
    expect(context.bindingHint).toContain("thread-bound");
    expect(context.bindingHint).toContain("thread-current");
  });

  it("falls back to the current thread when no report thread is bound yet", () => {
    const binding = resolveReportThreadBinding({
      existingReportThreadId: null,
      env: {
        CODEX_THREAD_ID: "thread-current",
      },
    });

    expect(binding.reportThreadId).toBe("thread-current");
    expect(binding.source).toBe("current_thread");
    expect(binding.threadContext.bindingState).toBe("unbound_current_available");
  });
});
