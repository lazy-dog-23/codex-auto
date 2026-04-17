# codex-auto

[中文说明](README.zh-CN.md)

`codex-auto` lets you set a goal for a repository and have Codex keep pushing that goal forward automatically within approved boundaries.

This repository contains the product code for that workflow: the CLI, repo-local control surface, router skills, templates, tests, and install/upgrade logic. The repo being auto-advanced is the target repo where you install `codex-autonomy`, not this source repo itself.

`codex-supervisor` handles install, doctor, thread binding, status/report, proposal and task materialization, prompt generation, and blocking behavior. It does not read or mutate private Codex databases, automation TOML, SQLite state, or other unsupported internal surfaces.

## What This Repo Provides

- Repo-local autonomy control surface installation and upgrade
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
- However, a same-thread live acceptance run on 2026-04-17 still reproduced the older symptom on this machine: an official heartbeat attached directly to the bound thread advanced `last_run_at`, left `automation_runs=0`, and produced no new target-thread turn. So official thread automations remain the architecture-aligned primary path, but the runtime on this Windows machine cannot yet be treated as stable; the external relay scheduler remains the operational fallback here.
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

- A same-thread official heartbeat live acceptance run targeted the real bound thread `019d8c93-bb6f-7710-a49b-43298c1bcd2e`.
- The temporary heartbeat `bilimusic2-official-hb-live-test-20260417-1430` was created successfully as `ACTIVE`; both the automation TOML and SQLite row existed, and `last_run_at` / `next_run_at` advanced as expected.
- But the target thread produced no new turn, `automation_runs` stayed at `0`, and the test marker never appeared in the thread.
- The practical conclusion is that the official heartbeat runtime on this machine still exhibits the “time advances without a real dispatch” failure mode. The docs and router therefore keep official thread automation as the architecture-first surface, while leaving the external relay scheduler as the working runtime fallback on this machine.

## Natural-Language Entry

After `scripts/install-global.ps1` finishes, a new Codex thread can drive installed repos through the global router skill. Common phrases include:

- `把 auto 装进当前项目`
- `升级当前项目里的 auto`
- `目标是……`
- `确认提案`
- `用冲刺模式推进这个目标`
- `继续当前目标`
- `汇报当前情况`

Chats without a project are for research, planning, or discussion. Repo-local autonomy install and continuation should happen inside a project thread with a real repository root.

When the current thread identity is available, the router auto-binds that thread on first use. If the current thread does not match the already-bound `report_thread_id`, the router blocks and requires an explicit rebind instead of silently continuing on the old binding.

Relay completion events are treated as status callbacks, not as new goal intake. They use the fixed envelope:

- `[Codex Relay Callback]`
- `Event-Type: codex.relay.dispatch.completed.v1`
- `BEGIN_CODEX_RELAY_CALLBACK_JSON`
- `END_CODEX_RELAY_CALLBACK_JSON`

## Core Commands

- `codex-autonomy install --target <repo>`
- `codex-autonomy upgrade-managed --target <repo> [--apply]`
- `codex-autonomy rebaseline-managed --target <repo>`
- `codex-autonomy bind-thread [--report-thread-id <threadId>]`
- `codex-autonomy doctor`
- `codex-autonomy prepare-worktree`
- `codex-autonomy emit-automation-prompts --json` (machine-readable prompt bundle for official thread automation and relay fallback surfaces)
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`
- `codex-autonomy generate-proposal`
- `codex-autonomy approve-proposal --goal-id <goalId>`
- `codex-autonomy review` (runs the review gate, attempts the controlled autonomy closeout commit when eligible, and immediately realigns the background worktree)
- `codex-autonomy report`
- `codex-autonomy status`
- `codex-autonomy pause` / `resume`
- `codex-autonomy merge-autonomy-branch`

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
- `.agents/skills/$autonomy-*`: repo-local autonomy skills
- `.codex/environments/environment.toml`: shared Windows setup plus `verify`, `smoke`, and `review` actions
- `.codex/config.toml`: repo fallback config with `approval_policy = "never"` and `sandbox_mode = "workspace-write"`
- `autonomy/*.json`: canonical repo-local autonomy state
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
