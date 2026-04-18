---
name: autonomy-decision
description: Classify autonomy boundary events and decide whether the bound thread should continue, repair once, back off, or ask the operator.
---

# autonomy-decision

Use this skill before asking the operator when autonomy hits a boundary such as proposal confirmation, verification failure, dirty worktree, closeout drift, environment mismatch, dependency uncertainty, scope change, or thread mismatch.

## Responsibilities

- Run `codex-autonomy status` first and quote `ready_for_automation`, `ready_for_execution`, `automation_state`, `goal_supply_state`, `next_automation_step`, `next_automation_reason`, `current_goal_id`, `current_task_id`, `next_task_id`, and `thread_binding_state`.
- Run `codex-autonomy decide --json` and treat its `decision_event`, `decision_outcome`, `decision_next_action`, `decision_heartbeat`, and `decision_reason` as the control-plane decision.
- Read `autonomy/decision-policy.json` when you need to explain why a decision is automatic versus human-confirmed.
- For `decision_outcome=auto_continue`, continue only through the bounded repo-local control plane and only when the status surface permits it.
- For `decision_next_action=create_successor_goal`, continue only when status reports `successor_goal_available=true` and policy reports `successor_goal_auto_approve=true`; run `codex-autonomy create-successor-goal --auto-approve`, rerun status, then run at most one bounded sprint loop.
- For `decision_outcome=auto_repair_once`, do only the named repair action, such as `run_verify_then_review` or `retry_verification_once`, then rerun `codex-autonomy status` and `codex-autonomy decide --json` before continuing.
- For `decision_outcome=safe_backoff`, leave repo state unchanged except for normal reporting or heartbeat cadence updates.
- For `decision_outcome=ask_human`, stop with one concrete question and the decision evidence. Do not keep looping at 1 minute.
- For `decision_outcome=reject_or_rewrite`, write or preserve the blocker and stop.

## Event classes

- `proposal_boundary`: goal or proposal confirmation is required.
- `successor_goal_boundary`: all approved work is complete and a policy-authorized program charter may supply one minimal successor goal.
- `verification_failure`: tests, browser checks, e2e, or closeout verification need bounded repair or confirmation.
- `recoverable_closeout`: a controlled diff can be closed through verify plus `codex-autonomy review`.
- `dirty_worktree`: repo or background worktree state is unsafe or unclear.
- `scope_change`, `dependency_or_env`, `security_or_secret`, `release_or_git`, `external_service`, `unknown_context`: treat as human-confirmed unless the repo policy explicitly narrows them.

## Guardrails

- Do not override `autonomy/decision-policy.json` from chat context.
- Do not convert `ask_human` into approval just because the current model believes the answer is obvious.
- Do not approve proposals, relax tests, add dependencies, touch credentials, deploy, force-push, bulk-delete, or move the operator thread unless the policy and current user message explicitly allow it.
- Keep every run bounded: one decision, one repair or continuation action, then status again.
