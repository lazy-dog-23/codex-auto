---
name: codex-autonomy-router
description: Detect whether the current local repository already uses codex-autonomy, install it automatically when a user asks in natural language to use auto/autonomy in the current project, and route follow-up requests into codex-autonomy install, upgrade, intake, proposal confirmation, sprint/cruise continuation, report, status, pause, resume, review, and merge flows. Use for requests like “把 auto 装进当前项目”, “升级当前项目里的 auto”, “刷新当前项目里的 auto”, “让这个项目进入自治”, “目标是……”, “确认提案”, “用冲刺模式推进这个目标”, “用巡航模式推进这个目标”, “继续当前目标”, “汇报当前情况”, “暂停当前目标”, “处理下一个目标”, or “合并自治分支”. Also use when an installed repo may need to pick up the latest codex-autonomy control-surface version before continuing.
---

# Codex Autonomy Router

Use this skill inside any local project thread when the user wants the current repository to be managed through `codex-autonomy` in natural language.

## Preconditions

- This skill is for project threads with a real repository root. If the current conversation is a Chat, a project-less thread, or a research/discussion workspace without a repo root, do not try to install the control surface. Explain that Chats are for research/planning/discussion, while repo-local autonomy needs a project thread.
- Work in the current repository only. Do not install into another path unless the user explicitly names it.
- Prefer PowerShell-native commands.
- Assume the product source repository lives at `{{SOURCE_REPO}}` on this machine.

## Step 1: Ensure the global CLI exists

1. Check whether `codex-autonomy` is already on `PATH`.
2. If it exists, compare `codex-autonomy --version` with `{{SOURCE_REPO}}/tools/codex-supervisor/package.json`.
3. If the user is asking to install, enable, or actively continue autonomy in the current project, prefer refreshing the machine-level CLI from the source repository once before repo routing.
4. If the command is missing, or the installed CLI version is older than the source repository version, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "{{INSTALL_GLOBAL_SCRIPT}}"
```

5. Because the install script force-reinstalls the local package, it is also the safe fallback when the source repository changed locally without a version bump.
6. If the install script is missing or fails, stop and report that the machine-level CLI is not ready.

## Step 2: Ensure the current project has the control surface

Treat the repository as already installed only if all of these are present:

- `autonomy/install.json`
- `.codex/config.toml`
- `AGENTS.md`

If any of them is missing, run:

```powershell
codex-autonomy install --target .
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1
codex-autonomy doctor
```

If `doctor` shows a Git repo and no unmanaged dirty blocker, also run:

```powershell
codex-autonomy prepare-worktree
```

## Step 3: Refresh to the latest local product version

If the control surface is already installed, or was just installed, reconcile it against the current local product before routing the user request:

```powershell
codex-autonomy upgrade-managed --target . --apply --json
codex-autonomy doctor
codex-autonomy status
```

Interpret the result this way:

- `managed_advisory_drift` is not blocking. Continue and mention it briefly only when relevant.
- `manual_conflict`, `foreign_occupied`, metadata corruption, or unmanaged dirty blockers are real stop conditions. Report the exact paths or reason and stop.
- If the repo is healthy enough for automation and the background worktree is missing or stale, run `codex-autonomy prepare-worktree`.

## Step 3.5: Resolve the current operator thread before routing

1. Read the current thread id from `$env:CODEX_THREAD_ID`.
2. Run `codex-autonomy status` from the repo root and inspect:
   - `report_thread_id`
   - `current_thread_id`
   - `thread_binding_state`
   - `thread_binding_hint`
3. Apply this policy exactly:
   - if `thread_binding_state=unbound_current_available`, run `codex-autonomy bind-thread`, then refresh `codex-autonomy status`
   - if `thread_binding_state=bound_to_current`, continue
   - if `thread_binding_state=bound_to_other`, stop and report the mismatch; tell the user to continue from the bound thread or explicitly run `codex-autonomy bind-thread --report-thread-id $env:CODEX_THREAD_ID` if they want to move the operator anchor
   - if `thread_binding_state=unbound_current_unavailable` and the next action needs an operator thread, stop and require `codex-autonomy bind-thread --report-thread-id <id>`
4. Never silently reuse an old `report_thread_id` as if it were the current thread.
5. Never auto-rebind to a different current thread without saying so.

## Step 3.6: Recognize relay completion callbacks before normal routing

- If the incoming message starts with `[Codex Relay Callback]`, treat it as a relay completion / status event, not as a new goal or proposal request.
- Prefer the machine payload between `BEGIN_CODEX_RELAY_CALLBACK_JSON` and `END_CODEX_RELAY_CALLBACK_JSON`; if those markers are missing, fall back to the surrounding human text cautiously.
- Do not run `intake-goal`, `generate-proposal`, `approve-proposal`, sprint, or cruise routing for that event.
- Summarize the callback as delegated status:
  - succeeded: quote the target project/thread and the returned `replyText`
  - failed / timed_out: quote `errorCode` / `errorMessage`
- Do not auto-rebind `report_thread_id` based on a callback event.
- When initiating async relay work from this product surface, only pass `callbackThreadId` from a public current-thread identity or the repo's bound `report_thread_id`.
- If neither a public current-thread id nor a safe bound report thread is available, stop and require explicit `codex-autonomy bind-thread` instead of guessing a callback target.

## Step 4: Route the natural-language intent

Map the user request to the narrowest `codex-autonomy` flow:

- install / enable autonomy:
  - run the ensure flow above and summarize readiness
- product refresh / upgrade:
  - use this path for `升级当前项目里的 auto`、`刷新当前项目里的 auto`、`更新这个项目的自治控制面`
  - run the ensure flow above, then `codex-autonomy upgrade-managed --target . --apply --json`
  - if the result ends in `managed_advisory_drift`, summarize it as non-blocking and mention `codex-autonomy rebaseline-managed --target .` only as an optional cleanup step
  - if the result contains `manual_conflict`, `foreign_occupied`, or unmanaged dirty blockers, report the exact paths or blocker and stop
  - quote `thread_binding_state`, `thread_binding_hint`, `next_operator_action`, and `next_operator_command` from the command result when explaining what the operator thread should do next
- new goal or feature request:
  - run `codex-autonomy intake-goal ...`
  - then `codex-autonomy generate-proposal`
  - if the user clearly asked to proceed immediately with language like “直接做”, “开始做”, “推进”, “修一下”, “实现这个”, or “按这个做”, treat that as the first approval signal and continue with `codex-autonomy approve-proposal --goal-id <goalId>`
  - otherwise summarize the proposal and wait for confirmation
- proposal confirmation:
  - inspect `codex-autonomy status` or the repo control-plane files to find the active `awaiting_confirmation` goal
  - run `codex-autonomy approve-proposal --goal-id <goalId>`
  - summarize the activated goal id, current run mode, and next ready task
- sprint continuation:
  - use this path for `用冲刺模式推进这个目标`
  - inspect `codex-autonomy status` first; if there is no active or confirmable goal, report that and stop
  - if the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop
  - if the active goal is not already in sprint mode, run `codex-autonomy set-run-mode <goalId> sprint`
  - if the goal is paused, run `codex-autonomy resume`
  - then use the repo-local `$autonomy-sprint` skill for one bounded loop only; do not improvise a freeform coding pass outside the control plane
- continue current goal:
  - use this path for `继续当前目标` or `处理下一个目标`
  - inspect `codex-autonomy status` first
  - when the intent is recurring or automatic continuation, also run `codex-autonomy emit-automation-prompts --json`
  - if the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop
  - if `ready_for_automation=false`, quote `next_automation_reason` from the status output and stop
  - if the active goal is paused, run `codex-autonomy resume`
  - if `recommended_automation_surface=thread_automation` and the user is in the bound project thread, treat official Codex thread automation as the primary path:
    - take `official_thread_automation.prompt` from `emit-automation-prompts --json`
    - create or update a thread heartbeat with `automation_update(kind=\"heartbeat\", destination=\"thread\", ...)`
    - keep the automation prompt short and durable; do not inline scheduler details into the prompt body
    - if the user also asked to continue now, after the heartbeat is active, use the repo-local `$autonomy-sprint` skill for one bounded loop only
  - if `recommended_automation_surface=external_relay_scheduler`, do not create a heartbeat in the current thread:
    - quote `report_thread_id`, `thread_binding_state`, and `recommended_automation_reason`
    - take `external_relay_scheduler.prompt` from `emit-automation-prompts --json`
    - route the work to the supported relay / external scheduler fallback instead of pretending the current thread owns the control loop
  - if `recommended_automation_surface=manual_only`, stop after quoting the blocking reason; do not improvise a fake automation path
  - for immediate non-recurring continuation, if the active goal run mode is `sprint`, use the repo-local `$autonomy-sprint` skill for one bounded loop
  - for immediate non-recurring continuation in `cruise`, keep the response bounded to the current ready state unless the user explicitly asks for an immediate bounded work pass
- cruise mode change:
  - use this path for `用巡航模式推进这个目标`
  - inspect `codex-autonomy status` first; if there is no active or confirmable goal, report that and stop
  - run `codex-autonomy set-run-mode <goalId> cruise`
  - if the goal is paused, run `codex-autonomy resume`
  - if the user also wants ongoing continuation and `recommended_automation_surface=thread_automation`, create or update the official thread heartbeat from `official_thread_automation.prompt`
  - summarize the updated run mode and next ready state; do not silently replace cruise with a sprint-style freeform loop
- status / report:
  - for `汇报当前情况`, prefer `codex-autonomy status`
  - use `codex-autonomy report` only when the user explicitly wants the detailed result summary
  - run the CLI from the repo root and treat its final output as authoritative
  - if the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness, and surface unmanaged diffs as the effective blocker
  - when summarizing readiness, quote `automation_state`, `ready_for_automation`, `next_automation_reason`, `report_thread_id`, `current_thread_id`, `thread_binding_state`, and `thread_binding_hint` from the command output instead of inferring from earlier `doctor` observations
- pause / resume:
  - use `codex-autonomy pause` or `codex-autonomy resume`
- review / merge:
  - use `codex-autonomy review` or `codex-autonomy merge-autonomy-branch`

## Step 5: Keep the thread natural

- Do not ask the user to manually figure out whether the repo is installed, outdated, or ready; determine that yourself first.
- When the repo was missing `codex-autonomy`, say that you installed and checked it, then continue with the user’s actual goal.
- When the installed repo needed a product refresh, say that you reconciled it to the latest local `codex-autonomy` version, then continue.
- For `汇报当前情况` and `继续当前目标`, do not repeat `doctor` findings as blockers unless the final `codex-autonomy status` output also reports them.
- Never synthesize blockers like `not_a_git_repo` or `PowerShell executable was not found` unless the final `codex-autonomy status` or `codex-autonomy report` output still contains them.
- When runtime Git probes are deferred, prefer a direct `git status --short` cross-check over assuming the repo is clean.
- If the repo is bound to another thread, say so explicitly and stop; do not keep treating the current thread as if it were the operator surface.
- For `确认提案` and sprint/cruise continuation, prefer the existing repo-local control-plane commands and skills over ad hoc edits.
- When a blocker is real, report the concrete blocker and stop.

## Output shape

Keep the response short and operational:

1. what you detected
2. what you installed or refreshed
3. whether the repo is ready
4. what goal or action you routed next
