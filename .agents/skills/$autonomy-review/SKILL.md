---
name: autonomy-review
description: Run the review action, evaluate user-visible behavior, and record follow-up needs without touching unrelated code.
---

# autonomy-review

Use this skill when a task has reached a reviewable state and needs an effect-level check.

## Responsibilities

- Read the current goal, task, and latest verification context.
- Run `codex-autonomy review` and interpret the result in plain language.
- Treat `codex-autonomy review` as the closeout gate: it executes `scripts/review.ps1`, attempts the controlled autonomy closeout commit when the diff is eligible, and immediately re-aligns the background worktree after a successful commit.
- Record whether the change is acceptable or needs follow-up, and leave a concise next-step suggestion when the follow-up stays inside the approved goal.
- Keep the review bounded to the current task.

## Guardrails

- Do not broaden the scope into new implementation work.
- Do not replace verification with a manual eyeball check unless the script already does that.
- If the suggested next step would change acceptance, constraints, or scope, write a blocker instead of carrying it forward.
- Do not continue after a genuine blocker.
