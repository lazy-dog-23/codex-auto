# codex-auto

[中文说明](README.zh-CN.md)

`codex-auto` is the product repository for `codex-autonomy`. It is not meant to be the active target repo being autonomously worked on. This repo contains the reusable control surface, CLI, templates, skills, tests, and install/upgrade logic that get applied to another repository.

`codex-supervisor` manages installation, doctor checks, status and report flows, proposal and task materialization, prompt generation, and blocking behavior. It does not read or mutate private Codex databases, automation TOML, SQLite state, or other unsupported internal surfaces.

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

## Natural-Language Entry

After `scripts/install-global.ps1` finishes, a new Codex thread can drive installed repos through the global router skill. Common phrases include:

- `把 auto 装进当前项目`
- `升级当前项目里的 auto`
- `目标是……`
- `确认提案`
- `用冲刺模式推进这个目标`
- `继续当前目标`
- `汇报当前情况`

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
- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`
- `codex-autonomy generate-proposal`
- `codex-autonomy approve-proposal --goal-id <goalId>`
- `codex-autonomy review`
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
- `scripts/review.ps1`: baseline effect-review gate
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
