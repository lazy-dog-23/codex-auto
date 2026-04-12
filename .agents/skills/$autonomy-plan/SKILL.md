---
name: autonomy-plan
description: Read the autonomy goal and state, keep the queued/ready window within policy, and update autonomy files without touching business code.
---

# autonomy-plan

Use this skill when you need to plan the next automation cycle for the repo control plane.

## Responsibilities

- Read `autonomy/goal.md`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, and any directly relevant source hints.
- Decide which eligible tasks should be `ready` and which should stay `queued`.
- Keep at most 5 tasks in `ready`.
- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.
- Write `autonomy/*.json` via atomic temp-file then rename semantics.
- Update only autonomy state and journal entries.

## Guardrails

- Do not edit business code.
- Do not take implementation ownership of a worker task.
- Do not bypass blockers or dependencies.
- If the next step is unclear, write a blocker and stop.

## Output

- Reconciled task queue state.
- Updated cycle status.
- New blocker records when needed.
- A journal entry for the run.
