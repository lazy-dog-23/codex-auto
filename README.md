# codex-auto

[中文说明](README.zh-CN.md)

`codex-auto` lets you set a goal for a repository and have Codex keep pushing that goal forward automatically within approved boundaries.

This repository contains the product code for that workflow: the CLI, repo-local control surface, router skills, templates, tests, and install/upgrade logic. The repo being auto-advanced is the target repo where you install `codex-autonomy`, not this source repo itself.

`codex-supervisor` handles install, doctor, thread binding, status/report, proposal and task materialization, prompt generation, and blocking behavior. It does not read or mutate private Codex databases, automation TOML, SQLite state, or other unsupported internal surfaces.

## What This Repo Provides

- Repo-local autonomy control surface installation and upgrade
- Target-repo project baseline creation with `TEAM_GUIDE.md` and a thin `AGENTS.override.md`
- Thread-bound operator/reporting workflow
- Goal / proposal / task state management
- Global router skill and relay manual-audit skill distribution
- Managed `README.md` section support for installed target repos
- Windows-first verification and worktree preparation flows

## Prerequisites

- Windows
- Node.js 22
- npm
- Git
- PowerShell 7
- A working Windows Codex App installation

## Installation

### Install for local development

```powershell
npm --prefix tools/codex-supervisor install
npm --prefix tools/codex-supervisor run build
```

### Install the machine-level CLI

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1
codex-autonomy --version
```

### Install into a target repository

1. Install prerequisites: Node.js 22, npm, Git, and PowerShell 7.
2. Run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`.
3. In a target repository, install the control surface with `codex-autonomy install --target <repo>`.
4. In that target repository, run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`.
5. Run `codex-autonomy doctor`.
6. If the target is a Git repo, run `codex-autonomy prepare-worktree`.
7. Bind the current operator thread with `codex-autonomy bind-thread`. If the current environment does not expose a thread identity, fall back to `codex-autonomy bind-thread --report-thread-id <thread-id>`.

## Upgrade

- Refresh the machine-level CLI and global skills by rerunning `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-global.ps1`.
- Update an installed target repo with `codex-autonomy upgrade-managed --target <repo> [--apply]`.
- Accept advisory target-repo drift as the new baseline with `codex-autonomy rebaseline-managed --target <repo>` when that drift is intentional.

## Troubleshooting

- If `codex-autonomy bind-thread` cannot resolve the current thread, use `codex-autonomy bind-thread --report-thread-id <thread-id>`.
- If `prepare-worktree` refuses to run, confirm the target repo is a valid Git repository and the working tree is not dirty outside the managed allowlist.
- If the target repo README exceeds the managed section limits, installation continues in advisory mode and the README is not overwritten.

## Known Limitations

- Starting with Codex App 26.415, official thread automations are the preferred same-thread continuation surface for repo-local autonomy. They preserve thread context and should be the primary path when the bound project thread can keep working in place.
- Earlier Windows validation on the older `heartbeat + MINUTELY` path showed cases where the scheduler advanced the next trigger time without dispatching a real thread run. Treat that as a historical caveat about the older path, not as a blanket statement about 26.415 official thread automations.
- A later same-thread live revalidation on April 17, 2026, after restarting Codex App, succeeded on this machine: a heartbeat attached to the bound thread produced new in-thread turns again. Treat the earlier miss as a stale-runtime caveat, not as the default assumption for 26.415.
- When the current thread is not the bound thread, or the wake-up must come from outside the app, use relay or an external scheduler as the fallback bridge.
- This repo now includes test scaffolding for the external-scheduler path: `scripts/run-codex-relay-scheduled-test.ps1` and `scripts/register-codex-relay-scheduled-test.ps1` drive `Task Scheduler -> relay -> bound thread` through the public relay CLI instead of private Codex storage.
- The relay runner now labels each invocation as an external scheduled wake-up, requires the target thread to check `codex-autonomy status`, and only allows one bounded loop when `thread_binding_state=bound_to_current`; otherwise it must stop with a mismatch or readiness report.
- When a later wake-up finds a recoverable closeout diff in the repo, `status` now tells the operator to run `codex-autonomy review`, and the external scheduler runners self-heal once with `scripts/verify.ps1 + codex-autonomy review` before deciding whether automation can continue.
- The scheduled runners now write logs under `%CODEX_HOME%` when available, otherwise `%USERPROFILE%\\.codex\\scheduled-runs\\<repo-name>` or `%USERPROFILE%\\.codex\\scheduled-relay-runs\\<repo-name>`, so external scheduler artifacts do not dirty the target repository.
- Use the in-app browser by default for unauthenticated local/public page verification. Switch to the current browser bridge or another live browser surface only when the flow genuinely depends on login state.

Recent validation (2026-04-16):

- The real bound-thread recovery path has been exercised on a live Windows Codex App repository: `long turn -> relay_send_wait timeout -> relay_dispatch_status succeeds -> short follow-up send succeeds`.
- In the same validation round, the bound thread completed a verify closeout and marked the active goal completed.
- The remaining unverified layer in that session was only the system scheduler wake-up itself; the delegated environment could not register Windows `Task Scheduler` tasks and blocked the runner's extra app-server spawn with `spawn EPERM`.

Recent validation (2026-04-17):

- After restarting Codex App, a same-thread official heartbeat live acceptance run targeted a real bound project thread.
- The recreated heartbeat produced new turns on the bound project thread and kept continuation inside that same thread, which is the intended 26.415 operating model.
- The practical conclusion is that official thread automation is now the preferred operational surface on this machine when work stays inside the bound project thread. Relay or an external scheduler remains the fallback for cross-thread, cross-project, or out-of-app wake-ups.

## Natural-Language Entry

After `scripts/install-global.ps1` finishes, a new Codex thread can drive installed repos through the global router skill. Common phrases include:

- `把 auto 装进当前项目`
- `初始化这个项目`
- `给当前项目做基线`
- `生成项目结构图`
- `跑 graphify 快照`
- `升级当前项目里的 auto`
- `目标是……`
- `确认提案`
- `确认提案并继续`
- `用冲刺模式推进这个目标`
- `继续当前目标`
- `快速续跑`
- `任务完成后 1 分钟继续`
- `按第二条处理 blocker`
- `把这个 goal 收窄为 checklist/manual lane`
- `保留 heartbeat 继续推进`
- `汇报当前情况`

Chats without a project are for research, planning, or discussion. Repo-local autonomy install and continuation should happen inside a project thread with a real repository root.

When the current thread identity is available, the router auto-binds that thread on first use. If the current thread does not match the already-bound `report_thread_id`, the router blocks and requires an explicit rebind instead of silently continuing on the old binding.

If the natural-language request already means "approve and keep going" or "keep this bound thread running", the router should not stop at proposal approval. It should translate that into `approve-proposal -> status -> official thread heartbeat -> bounded kickoff` when the current thread is already the bound thread.

The same rule applies to blocker decisions: if the user says things like "use blocker option 2", "narrow this goal to a checklist/manual lane", or "keep the heartbeat and continue with the narrower scope", the router and automation prompts should translate that into the repo-local unblock and bounded plan/sprint flow instead of making the user name CLI tools.

Fast follow-up requests such as `快速续跑`, `任务完成后 1 分钟继续`, or "continue one minute after each clean task" should use the same official thread heartbeat, not a second scheduler. The heartbeat should use entry-lease plus end-of-turn self-rescheduling: check status and locks first; when the bound thread is clean, ready, and idle, temporarily set that same heartbeat to a 30-minute entry lease before repo writes or long verification; run exactly one bounded loop; then set that same heartbeat to a 1-minute burst only when the refreshed status is still bound, clean, unblocked, execution-ready, and has a concrete next task. Otherwise it should fall back to the normal cadence, safe backoff, or pause.

Relay completion events are treated as status callbacks, not as new goal intake. They use the fixed envelope:

- `[Codex Relay Callback]`
- `Event-Type: codex.relay.dispatch.completed.v1`
- `BEGIN_CODEX_RELAY_CALLBACK_JSON`
- `END_CODEX_RELAY_CALLBACK_JSON`

## Core Commands

- `codex-autonomy install --target <repo>`
- `codex-autonomy init-project --target <repo> --mode existing|new` (installs the control surface and creates `TEAM_GUIDE.md` plus `AGENTS.override.md`; preserves existing docs unless `--refresh-docs` is passed)
- `codex-autonomy graphify-snapshot --target <repo> [--profile source-only|full]` (builds a local Graphify code map without installing hooks or editing `AGENTS.md`)
- `codex-autonomy scan --target <repo> [--profile source-only|full] [--update-team-guide]` (combines the Graphify map with docs, scripts, entrypoints, and verification hints, then writes `autonomy/context/repo-map.json`; it refreshes `TEAM_GUIDE.md` only when requested)
- `codex-autonomy query --target <repo> --json` (stable compact automation state for heartbeat, relay, scheduler, or UI consumers)
- `codex-autonomy upgrade-managed --target <repo> [--apply]`
- `codex-autonomy rebaseline-managed --target <repo>`
- `codex-autonomy bind-thread [--report-thread-id <threadId>]`
- `codex-autonomy doctor`
- `codex-autonomy prepare-worktree`
- `codex-autonomy emit-automation-prompts --json` (machine-readable prompt bundle for official thread automation and relay fallback surfaces)
- The surface-first prompt bundle now includes `whenToUse`, `whenNotToUse`, and `selectionRule` metadata so an agent can choose the right automation surface or role without extra operator coaching.
- The `official_thread_automation` prompt includes entry-lease plus self-rescheduling burst semantics for bound-thread sprint work: ready and idle work first moves the same heartbeat to a 30-minute lease while the loop runs; clean completed task plus a ready next task then means 1-minute fast follow-up; blockers, dirty state, confirmation waits, review pending, or thread mismatch mean normal cadence, safe backoff, or pause.
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`
- `codex-autonomy generate-proposal`
- `codex-autonomy approve-proposal --goal-id <goalId>`
- natural-language "approve and continue" should map to `approve-proposal`, then the same-thread heartbeat path when the bound thread can continue safely
- `codex-autonomy create-successor-goal --auto-approve` (only when the repo decision policy enables a charter-bound long-running program successor)
- `codex-autonomy review` (runs the review gate, attempts the controlled autonomy closeout commit when eligible, and immediately realigns the background worktree)
- `codex-autonomy report`
- `codex-autonomy status`
- `codex-autonomy decide --json` (classifies the current boundary and returns whether the agent may continue, repair once, back off, or must ask the operator)
- `codex-autonomy unblock <taskId>` when a blocker decision was already made in natural language and that decision only narrows scope or picks an existing blocker option
- `codex-autonomy pause` / `resume`
- `codex-autonomy merge-autonomy-branch`

## Automation Readiness

`codex-autonomy status` now separates scheduler wake-up readiness from execution readiness:

- `ready_for_automation=true` means the control plane can safely wake up and do one bounded next step. That next step may still be planning-only or confirmation-only work.
- `ready_for_execution=true` means the next wake-up can actually enter a bounded implementation loop.
- `goal_supply_state` distinguishes whether the next step is continuing an active goal, picking up another approved goal, waiting for proposal confirmation, idling after completion, staying empty, or stopping for manual triage.
- `next_automation_step` tells the runner whether it should `execute_bounded_loop`, `plan_or_rebalance`, `create_successor_goal`, `await_confirmation`, `idle`, or `manual_triage`.
- `decision_event`, `decision_outcome`, `decision_next_action`, and `decision_heartbeat` tell a heartbeat or bound thread whether it can keep going without the user. Agents should run `codex-autonomy decide --json` before converting blocker, verification, dirty worktree, closeout, scope, environment, or thread-boundary states into a human question.
- `create_successor_goal` is disabled by default. It only becomes automation-ready when `autonomy/decision-policy.json` defines an authorized long-running charter and allows one minimal successor goal after all approved work is complete. The write command also enforces the same bound-thread and `status` / `decide` gates at the CLI boundary.
- If a control-plane write is interrupted, `autonomy/operations/pending.json` blocks the next heartbeat until `codex-autonomy status`, `doctor`, or rerunning the original command can surface or recover the pending operation.

## Developer Fallback

If you are validating from source without a global install, build first and use the CLI entry directly:

```powershell
npm --prefix tools/codex-supervisor run build
node tools/codex-supervisor/dist/cli.js <command>
```

## Target README Management

Installed target repos do not hand over the entire `README.md`. Only the section between these markers is managed:

- `<!-- codex-autonomy:managed:start -->`
- `<!-- codex-autonomy:managed:end -->`

Default limits:

- total README size `<= 24 KiB`
- managed section size `<= 8 KiB`

Oversized files, files with NUL bytes, broken markers, or non-text files stay in advisory mode and are not overwritten automatically.

## Repo Layout

- `AGENTS.md`: stable operating rules
- `AGENTS.override.md`: optional thin target-repo overlay created by `init-project`
- `TEAM_GUIDE.md`: compact target-repo current-state snapshot created by `init-project`
- `.agents/skills/$autonomy-*`: repo-local autonomy skills
- `.codex/environments/environment.toml`: shared Windows setup plus `verify`, `smoke`, and `review` actions
- `.codex/config.toml`: repo fallback config with `approval_policy = "never"` and `sandbox_mode = "workspace-write"`
- `autonomy/*.json`: canonical repo-local autonomy state
- `autonomy/decision-policy.json`: repo-local decision boundary policy for auto-continue, one-shot repair, safe backoff, and human escalation
- `autonomy/operations/pending.json`: transient recovery marker for interrupted multi-file control-plane writes
- `autonomy/context/repo-map.json`: scan output used as a compact repo orientation map for agents and schedulers
- `scripts/verify.ps1`: worker acceptance gate
- `scripts/review.ps1`: baseline effect-review gate consumed by `codex-autonomy review`
- `tools/codex-supervisor`: TypeScript CLI implementation

## Verification

Use the narrowest checks that match the work:

```powershell
npm --prefix tools/codex-supervisor run build
npm --prefix tools/codex-supervisor run test
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

## License

This repository is released under the MIT License. See [LICENSE](LICENSE).
