---
name: autonomy-review
description: Run the review action, evaluate user-visible behavior, and record follow-up needs without touching unrelated code.
---

# autonomy-review

Use this skill when a task has reached a reviewable state and needs an effect-level check.

## Responsibilities

- Read the current goal, task, and latest verification context.
- Run `scripts/review.ps1` and interpret the result in plain language.
- Record whether the change is acceptable or needs follow-up.
- Keep the review bounded to the current task.

## Guardrails

- Do not broaden the scope into new implementation work.
- Do not replace verification with a manual eyeball check unless the script already does that.
- Do not continue after a genuine blocker.
