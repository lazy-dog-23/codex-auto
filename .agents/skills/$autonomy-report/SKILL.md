---
name: autonomy-report
description: Summarize the current autonomy state for the thread and Inbox without changing code.
---

# autonomy-report

Use this skill when the user wants a concise status update from the automation run.

## Responsibilities

- Read the latest autonomy state, recent verification result, and journal entry.
- Summarize the current goal, current task, latest verify/review outcome, latest commit, blockers, and why the loop is idle when nothing ran.
- Bind every summary to `report_thread_id`; treat the originating thread as the sole operator-facing surface.
- Treat normal success as a heartbeat summary, and surface blocked, review_pending, commit failure, or other failure states immediately.
- Keep the report short and actionable.

## Guardrails

- Do not modify business code.
- Do not change task state unless the reporting workflow explicitly owns it.
- Do not invent commit details or review conclusions.
