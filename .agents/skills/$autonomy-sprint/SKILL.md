---
name: autonomy-sprint
description: Kick off and continue a single autonomy goal in short, bounded execution loops.
---

# autonomy-sprint

Use this skill when the goal should start immediately and keep moving in short cycles.

## Responsibilities

- Read the current goal, task queue, and most recent result.
- Start with one immediate kickoff loop when the goal is first approved.
- Move through plan, work, review, and report in a single bounded pass.
- Stop when the goal is blocked, completed, or there is nothing eligible to do.

## Guardrails

- Do not pick up a second task in the same loop.
- Do not keep running after a blocker or review_pending condition.
- Do not broaden the goal beyond its approved boundaries.
