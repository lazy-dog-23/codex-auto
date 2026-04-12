---
name: autonomy-work
description: Pick one ready task, make the smallest change that satisfies it, verify the result, and stop.
---

# autonomy-work

Use this skill when you are executing a single ready task in a dedicated worktree.

## Responsibilities

- Read `autonomy/goal.md`, `autonomy/tasks.json`, `autonomy/state.json`, and `autonomy/blockers.json`.
- Select exactly one `ready` task.
- Make the smallest possible change for that task.
- Run `scripts/verify.ps1`.
- Update task status and append one journal entry.

## Guardrails

- Do not pick a second task in the same run.
- Do not auto commit, push, or deploy.
- Do not continue after a verification failure or real ambiguity.
- If the background worktree is dirty, set `review_pending` and stop.

## Failure handling

- First verification failure: mark the task `verify_failed` and increment `retry_count`.
- Second verification failure or a real ambiguity: mark the task `blocked` and add a blocker.
- Success: mark the task `done` and stop.
