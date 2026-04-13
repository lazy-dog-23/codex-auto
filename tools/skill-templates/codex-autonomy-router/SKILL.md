---
name: codex-autonomy-router
description: Detect whether the current local repository already uses codex-autonomy, install it automatically when a user asks in natural language to use auto/autonomy in the current project, and route follow-up requests into codex-autonomy install, upgrade, intake, report, status, pause, resume, review, and merge flows. Use for requests like “把 auto 装进当前项目”, “让这个项目进入自治”, “目标是……”, “继续当前目标”, “汇报当前情况”, “暂停当前目标”, or “合并自治分支”. Also use when an installed repo may need to pick up the latest codex-autonomy control-surface version before continuing.
---

# Codex Autonomy Router

Use this skill inside any local project thread when the user wants the current repository to be managed through `codex-autonomy` in natural language.

## Preconditions

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

## Step 4: Route the natural-language intent

Map the user request to the narrowest `codex-autonomy` flow:

- install / enable autonomy:
  - run the ensure flow above and summarize readiness
- new goal or feature request:
  - run `codex-autonomy intake-goal ...`
  - then `codex-autonomy generate-proposal`
  - if the user clearly asked to proceed immediately with language like “直接做”, “开始做”, “推进”, “修一下”, “实现这个”, or “按这个做”, treat that as the first approval signal and continue with `codex-autonomy approve-proposal --goal-id <goalId>`
  - otherwise summarize the proposal and wait for confirmation
- status / report:
  - use `codex-autonomy status` or `codex-autonomy report`
- pause / resume:
  - use `codex-autonomy pause` or `codex-autonomy resume`
- review / merge:
  - use `codex-autonomy review` or `codex-autonomy merge-autonomy-branch`

## Step 5: Keep the thread natural

- Do not ask the user to manually figure out whether the repo is installed, outdated, or ready; determine that yourself first.
- When the repo was missing `codex-autonomy`, say that you installed and checked it, then continue with the user’s actual goal.
- When the installed repo needed a product refresh, say that you reconciled it to the latest local `codex-autonomy` version, then continue.
- When a blocker is real, report the concrete blocker and stop.

## Output shape

Keep the response short and operational:

1. what you detected
2. what you installed or refreshed
3. whether the repo is ready
4. what goal or action you routed next
