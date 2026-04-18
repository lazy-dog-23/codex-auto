---
name: codex-autonomy-router
description: Detect whether the current local repository already uses codex-autonomy, install it automatically when a user asks in natural language to use auto/autonomy in the current project, and route follow-up requests into codex-autonomy init-project, install, upgrade, intake, proposal confirmation, blocker resolution, decision-boundary classification, sprint/cruise continuation, report, status, pause, resume, review, and merge flows. Use for requests like “初始化这个项目”, “给当前项目做基线”, “创建项目现状文档”, “把 auto 装进当前项目”, “升级当前项目里的 auto”, “刷新当前项目里的 auto”, “让这个项目进入自治”, “目标是……”, “确认提案”, “确认提案并继续”, “用冲刺模式推进这个目标”, “用巡航模式推进这个目标”, “继续当前目标”, “快速续跑”, “任务完成后 1 分钟继续”, “自动判断能不能继续”, “只有越界或高风险时问我”, “按第二条处理 blocker”, “把这个 goal 收窄为 checklist/manual lane”, “保留 heartbeat 继续推进”, “按长期目标继续生成下一步”, “已授权长期自治”, “汇报当前情况”, “暂停当前目标”, “处理下一个目标”, or “合并自治分支”. Also use when an installed repo may need to pick up the latest codex-autonomy control-surface version before continuing.
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
- project init / baseline:
  - use this path for `初始化这个项目`、`给当前项目做基线`、`创建项目现状文档`、`生成 TEAM_GUIDE`
  - for existing repositories, run `codex-autonomy init-project --target . --mode existing`
  - for genuinely new/empty repositories, run `codex-autonomy init-project --target . --mode new`
  - if the user explicitly asks to regenerate existing project docs, add `--refresh-docs`; otherwise preserve existing `TEAM_GUIDE.md` and `AGENTS.override.md`
  - summarize created, refreshed, and skipped paths, then quote the next setup/doctor/worktree steps from the command result
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
  - if that immediate-proceed request also implies ongoing autonomy in the bound thread, rerun `codex-autonomy status`, then:
    - if `recommended_automation_surface=thread_automation`, read `official_thread_automation.prompt` from `codex-autonomy emit-automation-prompts --json`, create or update the official thread heartbeat, and if the user asked for fast follow-up / 自调度 / 任务完成后 1 分钟继续, use that official prompt's entry-lease plus self-rescheduling burst semantics instead of creating a separate scheduler path
    - if `next_automation_step=execute_bounded_loop`, run one bounded repo-local `$autonomy-sprint` pass immediately
    - if `recommended_automation_surface=external_relay_scheduler`, quote the bound-thread mismatch and route to the relay / external scheduler fallback instead of creating a same-thread heartbeat here
  - otherwise summarize the proposal and wait for confirmation
- proposal confirmation:
  - inspect `codex-autonomy status` or the repo control-plane files to find the active `awaiting_confirmation` goal
  - run `codex-autonomy approve-proposal --goal-id <goalId>`
  - if the user also asked to continue now, keep running, or start autonomy in place with phrases like `确认提案并继续`, `确认后自己往下做`, or `直接开始自治`, treat that as a request to keep the bound thread moving:
    - rerun `codex-autonomy status`
    - if `recommended_automation_surface=thread_automation`, create or update the official thread heartbeat from `official_thread_automation.prompt`; if the user asked for `快速续跑`, `任务完成后 1 分钟继续`, `burst heartbeat`, or equivalent wording, treat that as a request for the same prompt's entry-lease plus self-rescheduling burst mode
    - if `next_automation_step=execute_bounded_loop`, run one bounded repo-local `$autonomy-sprint` pass immediately
    - if `next_automation_step=plan_or_rebalance`, do one bounded repo-local `$autonomy-plan` pass, rerun status once, and only enter `$autonomy-sprint` if execution becomes ready
  - otherwise summarize the activated goal id, current run mode, and next ready task
- blocker or decision-boundary follow-up:
  - use this path for `按第二条处理 blocker`、`按 blocker 的第二个方案做`、`把这个 goal 收窄为 checklist/manual lane`、`不要等模拟器，先按 manual lane 收口`、`保留 heartbeat 继续推进`
  - inspect `codex-autonomy status` first, then read the current open blocker from `autonomy/blockers.json` or `codex-autonomy report`
  - only continue automatically when the user decision clearly narrows scope or chooses among already-recorded blocker options without expanding the approved goal
  - if the decision would broaden scope, relax constraints, add a new external dependency, or otherwise change the approved boundary, keep the blocker open, report that boundary, and stop
  - when the decision safely resolves the blocker inside the current goal:
    - update proposal/task wording through one bounded repo-local `$autonomy-plan` pass if the narrower scope needs to be reflected in control-plane artifacts
    - run `codex-autonomy unblock <taskId>` for the blocked task
    - rerun `codex-autonomy status`
    - if the refreshed state now says `next_automation_step=plan_or_rebalance`, do one bounded `$autonomy-plan` pass, rerun status once, and continue only if execution becomes ready
    - if the refreshed state now says `next_automation_step=execute_bounded_loop`, run one bounded `$autonomy-sprint` pass
    - if the thread is already the bound thread and `recommended_automation_surface=thread_automation`, keep or refresh the official heartbeat instead of asking the user to recreate it manually
- sprint continuation:
  - use this path for `用冲刺模式推进这个目标`
  - inspect `codex-autonomy status` first; if there is no active or confirmable goal, report that and stop
  - if the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop
  - if the active goal is not already in sprint mode, run `codex-autonomy set-run-mode <goalId> sprint`
  - if the goal is paused, run `codex-autonomy resume`
  - then use the repo-local `$autonomy-sprint` skill for one bounded loop only; do not improvise a freeform coding pass outside the control plane
- continue current goal:
  - use this path for `继续当前目标`, `处理下一个目标`, `快速续跑`, `任务完成后 1 分钟继续`, `用 burst heartbeat 推进`, or equivalent wording
  - inspect `codex-autonomy status` first
  - if the status is blocked, dirty, waiting for confirmation, review-pending, non-executable, or otherwise ambiguous, run `codex-autonomy decide --json` before asking the user; use the decision result as the routing contract
  - if `decision_outcome=auto_repair_once` and `decision_next_action=run_verify_then_review`, run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`, then `codex-autonomy review`, rerun status and decide once, then continue only if the refreshed state allows it
  - if `decision_outcome=ask_human` or `decision_outcome=reject_or_rewrite`, stop with the decision reason and one concrete question instead of asking the user to name tools
  - when the intent is recurring or automatic continuation, also run `codex-autonomy emit-automation-prompts --json`
  - if the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; if unmanaged diffs are present, report them and stop
  - always quote `ready_for_automation`, `ready_for_execution`, `goal_supply_state`, `next_automation_step`, `next_automation_reason`, `successor_goal_available`, `successor_goal_auto_approve`, and `successor_goal_reason` from the status output instead of inferring them
  - treat `recommended_automation_surface` and `recommended_automation_reason` from status as the default surface choice; do not ask the user to pick a surface when the control plane already made that choice
  - if you need the actual automation prompt, read `emit-automation-prompts --json` and obey each surface's `whenToUse`, `whenNotToUse`, and `selectionRule` metadata instead of improvising your own routing rule
  - if `ready_for_automation=false`, quote `next_automation_reason` from the status output and stop
  - if the active goal is paused, run `codex-autonomy resume`
  - if `recommended_automation_surface=thread_automation` and the user is in the bound project thread, treat official Codex thread automation as the primary path:
    - take `official_thread_automation.prompt` from `emit-automation-prompts --json`
    - create or update a thread heartbeat with `automation_update(kind=\"heartbeat\", destination=\"thread\", ...)`
    - preserve the entry-lease plus self-rescheduling burst policy from the emitted prompt; do not strip it out and do not create a second heartbeat just for fast follow-up
    - if the user explicitly asked for fast follow-up / 任务完成后 1 分钟继续, set the first wake-up cadence to burst only when `ready_for_automation=true`, `ready_for_execution=true`, and a concrete `next_task_id` exists; otherwise keep the normal cadence and quote the blocking reason
    - the running heartbeat should update the same heartbeat record before and after each bounded loop: before repo writes or long verification, set a 30-minute entry lease; after closeout, clean ready next task -> burst cadence, uncertain but still runnable -> normal cadence, blocker / needs confirmation / review_pending / dirty / thread mismatch -> safe backoff or pause
    - if the user also asked to continue now and `next_automation_step=execute_bounded_loop`, after the heartbeat is active use the repo-local `$autonomy-sprint` skill for one bounded loop only
    - if the user also asked to continue now and `next_automation_step=plan_or_rebalance`, do one bounded repo-local `$autonomy-plan` pass, rerun `codex-autonomy status` once, and only switch to `$autonomy-sprint` if the refreshed status says `ready_for_execution=true`
    - if `next_automation_step=create_successor_goal`, run `codex-autonomy decide --json`; only when `decision_outcome=auto_continue`, `decision_next_action=create_successor_goal`, `successor_goal_available=true`, and `successor_goal_auto_approve=true`, run `codex-autonomy create-successor-goal --auto-approve`, rerun `codex-autonomy status`, and run at most one bounded `$autonomy-sprint` pass for the new goal
    - if status reports `pending_control_plane_operation`, recover it by rerunning the original command from the bound thread when safe; otherwise report the operation id and stop
    - if `next_automation_step=await_confirmation`, report that the next goal is still awaiting confirmation and stop; do not improvise execution
  - if `recommended_automation_surface=external_relay_scheduler`, do not create a heartbeat in the current thread:
    - quote `report_thread_id`, `thread_binding_state`, and `recommended_automation_reason`
    - take `external_relay_scheduler.prompt` from `emit-automation-prompts --json`
    - route the work to the supported relay / external scheduler fallback instead of pretending the current thread owns the control loop
  - if `recommended_automation_surface=manual_only`, stop after quoting the blocking reason; do not improvise a fake automation path
  - for immediate non-recurring continuation, if `next_automation_step=execute_bounded_loop` and the active goal run mode is `sprint`, use the repo-local `$autonomy-sprint` skill for one bounded loop
  - for immediate non-recurring continuation, if `next_automation_step=plan_or_rebalance`, use the repo-local `$autonomy-plan` skill for one bounded planning pass, rerun status once, and stop unless execution becomes ready
  - for immediate non-recurring continuation, if `next_automation_step=create_successor_goal`, run `codex-autonomy decide --json`; continue only through `codex-autonomy create-successor-goal --auto-approve` when both the decision and status successor fields allow it, then rerun status and stop unless execution becomes ready
  - if `pending_control_plane_operation` appears at any point, do not create a new goal or bounded loop until the pending operation is recovered or explicitly reported
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
  - when summarizing readiness, quote `automation_state`, `ready_for_automation`, `ready_for_execution`, `goal_supply_state`, `next_automation_step`, `next_automation_reason`, `successor_goal_available`, `successor_goal_auto_approve`, `successor_goal_reason`, `report_thread_id`, `current_thread_id`, `thread_binding_state`, and `thread_binding_hint` from the command output instead of inferring from earlier `doctor` observations
- pause / resume:
  - use `codex-autonomy pause` or `codex-autonomy resume`
- review / merge:
  - use `codex-autonomy review` or `codex-autonomy merge-autonomy-branch`

## Step 5: Keep the thread natural

- Do not ask the user to manually figure out whether the repo is installed, outdated, or ready; determine that yourself first.
- When the repo was missing `codex-autonomy`, say that you installed and checked it, then continue with the user’s actual goal.
- When the installed repo needed a product refresh, say that you reconciled it to the latest local `codex-autonomy` version, then continue.
- When the user has already made a clear natural-language decision such as approving now, choosing blocker option 2, narrowing the goal to a checklist/manual lane, or asking to keep the heartbeat, translate that into the correct control-plane commands yourself; do not make the user spell out `approve-proposal`, `unblock`, `automation_update`, or relay tool names.
- For `汇报当前情况` and `继续当前目标`, do not repeat `doctor` findings as blockers unless the final `codex-autonomy status` output also reports them.
- When a repo is in authorized long-running mode and status says `next_automation_step=create_successor_goal`, do not ask the user to write the next goal manually; use `decide --json` and the successor-goal command path, or stop with the exact policy reason.
- Before escalating any blocker, proposal wait, verification failure, dirty worktree, closeout diff, scope, environment, or thread-boundary uncertainty to the user, run `codex-autonomy decide --json` and follow `decision_outcome`: continue only on `auto_continue`, repair once on `auto_repair_once`, slow down on `safe_backoff`, and ask only on `ask_human` / `reject_or_rewrite`.
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
