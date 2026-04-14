---
name: codex-relay-manual-audit
description: Use when you need to manually test or audit codex-thread-relay-mcp from a Codex source thread, classify whether the issue belongs to the relay product or to codex-autonomy, and leave a minimal repro plus rerun order.
---

# Codex Relay Manual Audit

Use this skill from a source Codex thread when the goal is to manually drive `codex-thread-relay-mcp`, observe failures or instability, and decide whether the fix belongs in the relay product or in `codex-autonomy`.

Assume the product source repository for `codex-autonomy` lives at `{{SOURCE_REPO}}`.

## Operating Model

- Keep `codex-autonomy` as the source-side manual control surface.
- Use the installed `threadRelay` MCP tools directly; do not add or rely on a repo-local relay CLI inside `codex-autonomy`.
- Prefer the trusted project named `codex-thread-relay-mcp` when it exists in `relay_list_projects`.
- Run the matrix in order so later failures are easy to attribute.

## Scenario Matrix

Run these scenarios in order:

1. `relay_list_projects` and confirm the target project is trusted.
2. `relay_create_thread` to create an empty target thread.
3. `relay_send_wait` on that brand-new remembered thread.
4. `relay_dispatch` by `threadId`.
5. `relay_dispatch` by exact `threadName`.
6. `relay_dispatch` by unique `query`.
7. `relay_dispatch_async` create-and-send with explicit `callbackThreadId`.
8. `relay_dispatch_status` polling for a completed async run.
9. `relay_dispatch_deliver` after a forced callback pending / failed state.
10. `relay_dispatch_recover` for a pending / failed callback or a recoverable timed-out dispatch.
11. Invalid `threadId`.
12. Ambiguous `query`.
13. Busy target.
14. Timeout path.
15. Target reply missing or malformed.
16. App-server unavailable or interrupted.

For each scenario, record:

- exact tool call
- expected result
- actual result
- whether the failure is reproducible

## Attribution Rules

Classify issues this way:

- `codex-thread-relay-mcp`: thread resolution, busy lease handling, session lifecycle, state persistence, structured error codes, reply extraction, create-and-send orchestration, MCP tool payload quality.
- `codex-autonomy`: operator workflow confusion, missing manual playbook steps, install/sync script gaps, README drift, relay callback event misrouting, review/check guidance gaps, or source-thread practices that make relay testing hard to reproduce.

Do not attribute a relay tool failure to `codex-autonomy` unless the relay behavior is already correct and the source-side guidance or workflow is what failed.

## Minimal Repro Format

When you find a bug, capture:

1. source thread id
2. target project id
3. target thread id or selector
4. exact tool arguments
5. returned error code or reply
6. whether retry changes the outcome

Keep the repro small enough to run again after the fix.

## Regression Rerun Order

After a fix, rerun in this order:

1. the failing minimal repro
2. the nearest happy path for the same selector mode
3. the full scenario matrix from the top if the fix touched shared state, error mapping, or dispatch resolution

## Output Shape

Return a short operator report:

1. scenarios run
2. failures found
3. attribution per failure
4. minimal repro references
5. rerun status after fixes
