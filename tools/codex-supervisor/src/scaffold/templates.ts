import {
  MANAGED_README_SECTION_END,
  MANAGED_README_SECTION_START,
} from "../shared/managed-readme.js";

export function getAgentsMarkdown(): string {
  return [
    "# Repo Control Surface",
    "",
    "这份仓库把控制面收口在 repo 内。任何自动化工作都必须先读这里，再读对应 skill 和 `autonomy/*` 状态文件。",
    "",
    "## 硬规则",
    "",
    "1. 一次只处理一个任务，禁止并行拿多个任务。",
    "2. `scripts/verify.ps1` 是 worker 的唯一验收门。",
    "3. 只改必要源文件和 `autonomy/*`，不要扩散到无关区域。",
    "4. 遇到歧义、冲突、缺失上下文时，先写 blocker，再停止。",
    "5. 手工 `commit`、`push`、`deploy` 统统禁止；自动提交只允许自治流程在 `codex/autonomy` 分支上执行。",
    "6. 所有写入 `autonomy/*` 的动作，先拿 `autonomy/locks/cycle.lock`。",
    "7. `autonomy/*` 下的 JSON 必须原子写入，时间统一用 UTC ISO 8601，路径统一用 repo-relative forward-slash。",
    "8. 由于 repo 默认 `approval_policy=never`，禁止 destructive 或高影响操作：不得执行 force push、history rewrite、批量删除、越界写入、凭据变更、部署、外部系统副作用；需要这类动作时必须先写 blocker 并停止。",
    "",
    "## 运行约定",
    "",
    "- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。",
    "- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。",
    "- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。",
    "- dirty background worktree 立即置为 `review_pending` 并停机。",
    "- Reviewer 运行 `codex-autonomy review` 做效果检查、受控 closeout commit 与 background worktree 对齐，不扩大任务范围。",
    "- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总，详细运行记录留在 Inbox 和 journal。",
    "- Sprint runner 的 heartbeat 只是唤醒间隔，不是任务时长；每次唤醒只推进单个任务闭环，当前 goal 完成且存在下一个 approved goal 时同轮直接接续。",
    "- `sprint_active=false` 或 `paused=true` 时只做状态检查和汇报，不做新的 plan/work/review 推进。",
    "- Sprint runner 遇到 blocker、review_pending 或无任务时停下。",
    "- Worker、Reviewer 或 Sprint runner 如果生成了“下一步建议”，只允许目标内 follow-up 自动入队；一旦改变验收、约束或范围，必须写 blocker 等线程确认。",
    "- `autonomy/verification.json` 是 closeout gate；体检/安全/健壮性类 goal 在 required verification axis 清零前不得完成。",
    "- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。",
    "",
    "## 线程入口",
    "",
    "- 原线程是唯一操作入口，`report_thread_id` 是所有摘要和异常回传的锚点。",
    "- 线程内的自然语言动作固定收口为：`把 auto 装进当前项目`、`目标是……`、`确认提案`、`用冲刺模式推进这个目标`、`用巡航模式推进这个目标`、`汇报当前情况`、`暂停当前目标`、`继续当前目标`、`处理下一个目标`、`合并自治分支`。",
    "- `汇报当前情况` 必须先运行 `codex-autonomy status`；只有明确要求详细结果时才运行 `codex-autonomy report`，并且以最终命令输出里的 `automation_state`、`ready_for_automation`、`ready_for_execution`、`goal_supply_state`、`next_automation_step`、`next_automation_reason`、`report_thread_id`、`current_thread_id`、`thread_binding_state`、`thread_binding_hint` 为准。若状态里出现 `git_runtime_probe_deferred` 或 `background_runtime_probe_deferred`，还必须直接运行一次 `git status --short` 再判断真实 blocker。",
    "- `继续当前目标`、`处理下一个目标`、`用冲刺模式推进这个目标` 在执行前必须先运行 `codex-autonomy status`；如果 `ready_for_automation=false`，原样汇报 `next_automation_reason` 并停止；如果 `ready_for_execution=false`，则严格按 `next_automation_step` 收口：`plan_or_rebalance` 只做一轮规划/收口，`await_confirmation` 只汇报待确认并停止，只有 `execute_bounded_loop` 才能进入业务代码闭环。若状态里出现 `git_runtime_probe_deferred` 或 `background_runtime_probe_deferred`，还必须直接运行一次 `git status --short`，发现 unmanaged drift 就停止。",
    "- 如果 `thread_binding_state=bound_to_other`，当前线程不是 operator thread；必须明确报告 mismatch 并停止，不得静默沿用旧 `report_thread_id` 继续。",
    "- `goal.md` 只镜像当前 active goal；真正的目标队列和批准边界以 `goals.json`、`proposals.json`、`tasks.json` 为准。",
    "",
    "## Skills",
    "",
    "- `.agents/skills/$autonomy-plan/SKILL.md`",
    "- `.agents/skills/$autonomy-work/SKILL.md`",
    "- `.agents/skills/$autonomy-intake/SKILL.md`",
    "- `.agents/skills/$autonomy-review/SKILL.md`",
    "- `.agents/skills/$autonomy-report/SKILL.md`",
    "- `.agents/skills/$autonomy-sprint/SKILL.md`",
    "",
    "## Shared Environment",
    "",
    "- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。",
  ].join("\n");
}

export function getAutonomyPlanSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-plan",
    "description: Read the active goal queue and state, keep the ready window within policy, and update autonomy files without touching business code.",
    "---",
    "",
    "# autonomy-plan",
    "",
    "Use this skill when you need to plan the next automation cycle for the repo control plane.",
    "",
    "## Responsibilities",
    "",
    "- Read `autonomy/goal.md`, `autonomy/goals.json`, `autonomy/proposals.json`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, `autonomy/results.json`, and `autonomy/verification.json`.",
    "- Keep at most 5 tasks in `ready` for the current active goal.",
    "- If a goal is still `awaiting_confirmation`, update only `autonomy/proposals.json` and do not materialize tasks yet.",
    "- If the goal is `approved` or `active`, rebalance only inside that approved boundary.",
    "- If a worker, reviewer, or sprint loop leaves a follow-up suggestion that still fits the approved goal, convert it into proposal or task queue adjustments.",
    "- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.",
    "- Write `autonomy/*.json` via atomic temp-file then rename semantics.",
    "- Update only autonomy state, proposal, result, and journal entries.",
    "",
    "## Guardrails",
    "",
    "- Do not edit business code.",
    "- Do not take implementation ownership of a worker task.",
    "- Do not bypass blockers or dependencies.",
    "- Do not expand scope, change acceptance, or relax constraints without a blocker.",
    "- If a suggested next step would cross the approved goal boundary, write a blocker instead of promoting it.",
    "- If the next step is unclear, write a blocker and stop.",
    "",
    "## Output",
    "",
    "- Reconciled task queue state.",
    "- Updated cycle status.",
    "- New blocker records when needed.",
    "- A journal entry for the run.",
  ].join("\n");
}

export function getAutonomyWorkSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-work",
    "description: Pick one ready task, make the smallest change that satisfies it, verify and review the result, and stop.",
    "---",
    "",
    "# autonomy-work",
    "",
    "Use this skill when you are executing a single ready task in a dedicated worktree.",
    "",
    "## Responsibilities",
    "",
    "- Read `autonomy/goal.md`, `autonomy/goals.json`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, and `autonomy/results.json`.",
    "- Select exactly one `ready` task.",
    "- Make the smallest possible change for that task.",
    "- Run `scripts/verify.ps1`.",
    "- Then run `codex-autonomy review` as the closeout gate; it executes `scripts/review.ps1`, attempts the controlled autonomy closeout commit on `codex/autonomy`, and re-aligns the background worktree when the diff is eligible.",
    "- If `codex-autonomy review` reports a commit or background-worktree failure, stop and surface it instead of falling back to a manual commit.",
    "- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.",
    "- Write `autonomy/*.json` via atomic temp-file then rename semantics.",
    "- Update task status, review status, result summary, and append one journal entry.",
    "",
    "## Guardrails",
    "",
    "- Do not pick a second task in the same run.",
    "- Do not push or deploy.",
    "- Do not continue after a verification failure or real ambiguity.",
    "- If the background worktree is dirty, set `review_pending` and stop.",
    "",
    "## Failure handling",
    "",
    "- First verification failure: mark the task `verify_failed` and increment `retry_count`.",
    "- Second verification failure or a real ambiguity: mark the task `blocked` and add a blocker.",
    "- Success: mark the task `done` and stop.",
  ].join("\n");
}

export function getAutonomyIntakeSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-intake",
    "description: Normalize a user goal into repo-local autonomy intent and capture the smallest useful intake artifacts.",
    "---",
    "",
    "# autonomy-intake",
    "",
    "Use this skill when a natural-language request needs to be converted into the repo's current autonomy objective.",
    "",
    "## Responsibilities",
    "",
    "- Read the current `autonomy/goal.md` and existing journal entries before writing anything.",
    "- Turn the user request into a concise objective, constraints, and success criteria.",
    "- Keep the intake focused on the current repository and current thread.",
    "- Treat thread phrases like `目标是……` as goal intake, and leave `确认提案` or mode changes to their dedicated command paths.",
    "- Update only the repo-local intake artifacts that already exist.",
    "",
    "## Guardrails",
    "",
    "- Do not edit application code.",
    "- Do not expand scope beyond the user request without a blocker.",
    "- Do not invent execution details that belong to worker or reviewer passes.",
  ].join("\n");
}

export function getAutonomyReviewSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-review",
    "description: Run the review action, evaluate user-visible behavior, and record follow-up needs without touching unrelated code.",
    "---",
    "",
    "# autonomy-review",
    "",
    "Use this skill when a task has reached a reviewable state and needs an effect-level check.",
    "",
    "## Responsibilities",
    "",
    "- Read the current goal, task, latest verification context, and `autonomy/verification.json` closeout state.",
    "- Run `codex-autonomy review` and interpret the result in plain language.",
    "- Treat `codex-autonomy review` as the closeout gate: it executes `scripts/review.ps1`, attempts the controlled autonomy closeout commit when the diff is eligible, and re-aligns the background worktree after a successful commit.",
    "- Record whether the change is acceptable or needs follow-up, and leave a concise next-step suggestion when the follow-up stays inside the approved goal.",
    "- If required verification axes are still pending, keep the goal open and convert that gap into follow-up work instead of calling the goal complete.",
    "- Keep the review bounded to the current task.",
    "",
    "## Guardrails",
    "",
    "- Do not broaden the scope into new implementation work.",
    "- Do not replace verification with a manual eyeball check unless the script already does that.",
    "- If the suggested next step would change acceptance, constraints, or scope, write a blocker instead of carrying it forward.",
    "- Do not continue after a genuine blocker.",
  ].join("\n");
}

export function getAutonomyReportSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-report",
    "description: Summarize the current autonomy state for the thread and Inbox without changing code.",
    "---",
    "",
    "# autonomy-report",
    "",
    "Use this skill when the user wants a concise status update from the automation run.",
    "",
    "## Responsibilities",
    "",
    "- Read the latest autonomy state, recent verification result, and journal entry.",
    "- For `汇报当前情况`, run `codex-autonomy status` from the repo root first; only use `codex-autonomy report` when the user explicitly asks for a detailed result summary.",
    "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before trusting readiness; treat unmanaged diffs from that direct Git check as the effective blocker.",
    "- Summarize the current goal, current task, latest verify/review outcome, latest commit, blockers, and why the loop is idle when nothing ran.",
    "- Bind every summary to `report_thread_id`; treat the originating thread as the sole operator-facing surface.",
    "- Quote `automation_state`, `ready_for_automation`, `ready_for_execution`, `goal_supply_state`, `next_automation_step`, `next_automation_reason`, `report_thread_id`, `current_thread_id`, `thread_binding_state`, and `thread_binding_hint` directly from the latest CLI output instead of inferring from older observations.",
    "- Treat normal success as a heartbeat summary, and surface blocked, review_pending, commit failure, or other failure states immediately.",
    "- Keep the report short and actionable.",
    "",
    "## Guardrails",
    "",
    "- Do not modify business code.",
    "- Do not change task state unless the reporting workflow explicitly owns it.",
    "- Do not invent commit details or review conclusions.",
    "- Do not repeat stale `doctor` blockers unless the latest `codex-autonomy status` or `codex-autonomy report` output still reports them.",
    "- Do not report `ready_for_automation=true` when runtime Git probes were deferred and a direct `git status --short` shows unmanaged repo drift.",
    "- If `thread_binding_state=bound_to_other`, say this thread is not the bound operator thread and stop instead of pretending the current thread owns the repo surface.",
  ].join("\n");
}

export function getAutonomySprintSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-sprint",
    "description: Kick off and continue a single autonomy goal in short, bounded execution loops.",
    "---",
    "",
    "# autonomy-sprint",
    "",
    "Use this skill when the goal should start immediately and keep moving in short cycles.",
    "",
    "## Responsibilities",
    "",
    "- Start every `继续当前目标`, `处理下一个目标`, or sprint continuation pass by running `codex-autonomy status` from the repo root.",
    "- Read the current goal, task queue, most recent result, and the latest `ready_for_automation`, `ready_for_execution`, `goal_supply_state`, `next_automation_step`, and `next_automation_reason` fields.",
    "- If the status output warns `git_runtime_probe_deferred` or `background_runtime_probe_deferred`, run `git status --short` from the repo root before continuing; if that direct Git check shows unmanaged diffs, report them and stop.",
    "- If `codex-autonomy status` says the repo has a recoverable closeout diff and explicitly tells you to run `codex-autonomy review`, first rerun the narrowest verification needed for that dirty diff; at minimum run `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`, then `codex-autonomy review`, then rerun `codex-autonomy status` once before deciding whether the loop can continue.",
    "- Start with one immediate kickoff loop when the goal is first approved.",
    "- Treat the sprint heartbeat as a wake-up interval, not a task duration.",
    "- When sprint_active is false or paused is true, keep the loop to a status check and report, then stop.",
    "- If `ready_for_automation=false`, stop after reporting `next_automation_reason` instead of improvising a freeform coding pass.",
    "- If `ready_for_execution=false`, obey `next_automation_step`: `plan_or_rebalance` means do one bounded planning/rebalance pass and rerun status once, `await_confirmation` means report the approval wait and stop, and only `execute_bounded_loop` may enter the business-code loop.",
    "- If `thread_binding_state=bound_to_other`, stop and report the operator-thread mismatch instead of continuing in the wrong thread.",
    "- Move through plan, work, review, and report in a single bounded pass.",
    "- When the current goal completes and another approved goal exists, continue in the same loop instead of waiting for the next heartbeat.",
    "- If a task finishes and the next step still belongs to the approved goal set, leave a concise follow-up suggestion for the next planning pass or immediate continuation.",
    "- Stop when sprint_active is false, paused is true, the goal is blocked, or there is nothing eligible to do.",
    "",
    "## Guardrails",
    "",
    "- Do not pick up a second task in the same loop.",
    "- Do not bypass the latest `codex-autonomy status` readiness check.",
    "- Do not continue when runtime Git probes were deferred and a direct `git status --short` still shows unmanaged repo drift.",
    "- Do not keep running after a blocker, review_pending condition, commit failure, or pause.",
    "- Do not broaden the goal beyond its approved boundaries.",
    "- If the suggested next step would change acceptance, constraints, or scope, write a blocker instead of continuing.",
  ].join("\n");
}

export function getDefaultGoalMarkdown(): string {
  return [
    "# Objective",
    "",
    "建立一个可安装到任意本地仓库的 Windows 原生 Codex 自治产品，所有自治状态都由 repo 内文件驱动，所有运行规则都明确、可校验、可恢复。",
    "",
    "## Success Criteria",
    "",
    "- Codex app 能读取 repo 级 `AGENTS.md` 和 repo skills。",
    "- `.codex/environments/environment.toml` 能定义 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。",
    "- `.codex/config.toml` 默认采用 `approval_policy = \"never\"`、`sandbox_mode = \"workspace-write\"`、`gpt-5.4`、`xhigh` 和 `fast`。",
    "- `scripts/setup.windows.ps1` 可重复执行且不覆盖已有内容。",
    "- `scripts/verify.ps1` 是 worker 的正式验收门，`scripts/review.ps1` 负责效果检查。",
    "",
    "## Constraints",
    "",
    "- 只通过 repo 内文件和本地脚本驱动自治。",
    "- 不触碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。",
    "- 手工 `commit`、`push`、`deploy` 仍然禁止；自动提交只允许自治流程在 `codex/autonomy` 分支上执行。",
    "- 所有写入 `autonomy/*` 的动作都必须先拿 `autonomy/locks/cycle.lock`。",
    "- 时间统一为 UTC ISO 8601，路径统一为 repo-relative forward-slash。",
    "- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总。",
    "- Sprint runner 的 heartbeat 是唤醒间隔，不是任务时长；当前 goal 完成且存在下一个 approved goal 时同轮直接接续。",
    "",
    "## Out of Scope",
    "",
    "- GUI dashboard。",
    "- 自动推送、自动部署。",
    "- Windows hooks。",
    "- 直接操控 Codex app 内部状态。",
  ].join("\n");
}

export function getInstallGoalMarkdown(): string {
  return [
    "# Objective",
    "",
    "把 `codex-autonomy` 安装到当前仓库，形成 repo-local 的自治控制面骨架，并让后续 worker 可以在同一套文件约定下继续推进。",
    "",
    "## Success Criteria",
    "",
    "- 目标仓库能直接看到 repo 级 `AGENTS.md` 和 repo skills。",
    "- `.codex/environments/environment.toml` 能定义 Windows setup script，以及 `verify`、`smoke` 和 `review` 三个 actions。",
    "- `.codex/config.toml` 默认采用 `approval_policy = \"never\"`、`sandbox_mode = \"workspace-write\"`、`gpt-5.4`、`xhigh` 和 `fast`。",
    "- `scripts/setup.windows.ps1`、`scripts/verify.ps1`、`scripts/smoke.ps1`、`scripts/review.ps1` 都存在且可重复执行。",
    "- `autonomy/goal.md` 和 `autonomy/journal.md` 已放入仓库，供后续自治循环继续补全。",
    "",
    "## Constraints",
    "",
    "- 只写目标仓库根目录内的控制面文件。",
    "- 保留现有用户文件，不覆盖已有内容。",
    "- 不触碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。",
    "- 时间统一为 UTC ISO 8601，路径统一为 repo-relative forward-slash。",
    "- Reporter 只有异常、blocked、review_pending、commit 失败等情况立即回线程；正常成功按 heartbeat 汇总。",
    "- Sprint runner 的 heartbeat 是唤醒间隔，不是任务时长；当前 goal 完成且存在下一个 approved goal 时同轮直接接续。",
    "",
    "## Out of Scope",
    "",
    "- GUI dashboard。",
    "- 直接操控 Codex app 内部状态。",
    "- 自动推送、自动部署。",
  ].join("\n");
}

export function getDefaultJournalMarkdown(): string {
  return [
    "# Journal",
    "",
    "Append one entry per run. Do not rewrite old entries.",
    "",
    "## Entry Template",
    "",
    "```md",
    "## 2026-04-12T00:00:00Z | planner | task: <task-id>",
    "- result: planned | passed | failed | blocked | noop",
    "- summary: <short summary>",
    "- verify: <what ran and what happened>",
    '- blocker: <blocker id or "none">',
    "```",
  ].join("\n");
}

export function getInstallVerifyScriptTemplate(): string {
  return String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-PropertyExists {
    param(
        [Parameter(Mandatory)]$Item,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path,
        [string]$Context = ''
    )
    $hasProperty = $Item.PSObject.Properties.Name -contains $Name
    $contextLabel = if ([string]::IsNullOrWhiteSpace($Context)) { '' } else { "$Context " }
    Assert-True $hasProperty "Missing required key '$Name' in $contextLabel$Path."
}

function Read-Toml {
    param([Parameter(Mandatory)][string]$Path)
    $lines = Get-Content -LiteralPath $Path
    $result = [ordered]@{
        version = $null
        setup = [ordered]@{}
        actions = @()
    }
    $currentSection = $null
    $currentAction = $null

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
            continue
        }

        switch -Regex ($line) {
            '^\[setup\]$' {
                $currentSection = 'setup'
                $currentAction = $null
                continue
            }
            '^\[\[actions\]\]$' {
                if ($null -ne $currentAction -and $currentAction.Count -gt 0) {
                    $result.actions += [pscustomobject]$currentAction
                }
                $currentSection = 'actions'
                $currentAction = [ordered]@{}
                continue
            }
            '^version\s*=\s*(\d+)$' {
                $result.version = [int]$Matches[1]
                continue
            }
            '^(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(?<value>.*)"$' {
                $key = $Matches.key
                $value = $Matches.value
                if ($currentSection -eq 'actions' -and $null -ne $currentAction) {
                    $currentAction[$key] = $value
                } elseif ($currentSection -eq 'setup') {
                    $result.setup[$key] = $value
                } else {
                    $result[$key] = $value
                }
                continue
            }
            default {
                throw "Unsupported TOML line in $($Path): $line"
            }
        }
    }

    if ($null -ne $currentAction -and $currentAction.Count -gt 0) {
        $result.actions += [pscustomobject]$currentAction
    }

    $result.setup = [pscustomobject]$result.setup
    $result.actions = @($result.actions)

    return [pscustomobject]$result
}

function Read-SimpleTomlMap {
    param([Parameter(Mandatory)][string]$Path)
    $lines = Get-Content -LiteralPath $Path
    $result = [ordered]@{}
    $currentSection = ''

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
            continue
        }

        if ($line -match '^\[(?<name>[^\[\]]+)\]$') {
            $currentSection = $Matches.name.Trim()
            continue
        }

        if ($line -match '^\[\[') {
            throw "Unsupported TOML array-of-tables in $($Path): $line"
        }

        if ($line -notmatch '^(?<key>[A-Za-z0-9_.:-]+)\s*=\s*(?<value>.+)$') {
            throw "Unsupported TOML line in $($Path): $line"
        }

        $key = $Matches.key
        $rawValue = $Matches.value.Trim()

        if ($rawValue -match '^"(.*)"$') {
            $value = $Matches[1]
        } elseif ($rawValue -eq 'true') {
            $value = $true
        } elseif ($rawValue -eq 'false') {
            $value = $false
        } elseif ($rawValue -match '^-?\d+$') {
            $value = [int]$rawValue
        } else {
            throw "Unsupported TOML value in $($Path): $line"
        }

        $fullKey = if ([string]::IsNullOrWhiteSpace($currentSection)) { $key } else { "$currentSection.$key" }
        $result[$fullKey] = $value
    }

    return $result
}

function Test-RequiredText {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Patterns
    )
    $text = Get-Content -LiteralPath $Path -Raw
    foreach ($pattern in $Patterns) {
        Assert-True ($text -match $pattern) "Required pattern '$pattern' was not found in $Path."
    }
}

function Test-StateDocument {
    param([Parameter(Mandatory)][string]$Path)
    $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($key in @(
        'version',
        'current_goal_id',
        'current_task_id',
        'cycle_status',
        'run_mode',
        'last_planner_run_at',
        'last_worker_run_at',
        'last_result',
        'consecutive_worker_failures',
        'needs_human_review',
        'open_blocker_count',
        'report_thread_id',
        'autonomy_branch',
        'sprint_active',
        'paused',
        'pause_reason'
    )) {
        Assert-PropertyExists -Item $state -Name $key -Path $Path
    }
    if ($state.PSObject.Properties.Name -contains 'last_thread_summary_sent_at' -and $null -ne $state.last_thread_summary_sent_at) {
        $threadSummarySentAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$state.last_thread_summary_sent_at, [ref]$threadSummarySentAt)) "Invalid last_thread_summary_sent_at in $Path."
    }
    if ($state.PSObject.Properties.Name -contains 'last_inbox_run_at' -and $null -ne $state.last_inbox_run_at) {
        $inboxRunAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$state.last_inbox_run_at, [ref]$inboxRunAt)) "Invalid last_inbox_run_at in $Path."
    }

    Assert-True (@('idle','planning','working','blocked','review_pending') -contains [string]$state.cycle_status) "Invalid cycle_status in $Path."
    Assert-True ($null -eq $state.run_mode -or @('sprint','cruise') -contains [string]$state.run_mode) "Invalid run_mode in $Path."
    Assert-True (@('noop','planned','passed','failed','blocked') -contains [string]$state.last_result) "Invalid last_result in $Path."
}

function Test-TaskCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'tasks' -Path $Path

    foreach ($task in @($doc.tasks)) {
        foreach ($key in @(
            'id',
            'goal_id',
            'title',
            'status',
            'priority',
            'depends_on',
            'acceptance',
            'file_hints',
            'retry_count',
            'last_error',
            'updated_at',
            'commit_hash',
            'review_status',
            'source',
            'source_task_id'
        )) {
            Assert-PropertyExists -Item $task -Name $key -Path $Path -Context 'a task from'
        }

        Assert-True (@('queued','ready','in_progress','verify_failed','blocked','done') -contains [string]$task.status) "Invalid task status in $Path."
        Assert-True (@('P0','P1','P2','P3') -contains [string]$task.priority) "Invalid task priority in $Path."
        Assert-True (@('not_reviewed','passed','followup_required') -contains [string]$task.review_status) "Invalid review_status in $Path."
        Assert-True (@('proposal','followup') -contains [string]$task.source) "Invalid task source in $Path."
    }
}

function Test-GoalCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'goals' -Path $Path

    foreach ($goal in @($doc.goals)) {
        foreach ($key in @(
            'id',
            'title',
            'objective',
            'success_criteria',
            'constraints',
            'out_of_scope',
            'status',
            'run_mode',
            'created_at',
            'approved_at',
            'completed_at'
        )) {
            Assert-PropertyExists -Item $goal -Name $key -Path $Path -Context 'a goal from'
        }

        Assert-True (@('draft','awaiting_confirmation','approved','active','completed','blocked','cancelled') -contains [string]$goal.status) "Invalid goal status in $Path."
        Assert-True (@('sprint','cruise') -contains [string]$goal.run_mode) "Invalid goal run_mode in $Path."
    }
}

function Test-ProposalCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'proposals' -Path $Path

    foreach ($proposal in @($doc.proposals)) {
        foreach ($key in @(
            'goal_id',
            'status',
            'summary',
            'tasks',
            'created_at',
            'approved_at'
        )) {
            Assert-PropertyExists -Item $proposal -Name $key -Path $Path -Context 'a proposal from'
        }

        Assert-True (@('awaiting_confirmation','approved','superseded','cancelled') -contains [string]$proposal.status) "Invalid proposal status in $Path."

        foreach ($task in @($proposal.tasks)) {
            foreach ($key in @('id','title','priority','depends_on','acceptance','file_hints')) {
                Assert-PropertyExists -Item $task -Name $key -Path $Path -Context 'a proposed task from'
            }
        }
    }
}

function Test-SettingsDocument {
    param([Parameter(Mandatory)][string]$Path)
    $settings = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($key in @(
        'version',
        'install_source',
        'initial_confirmation_required',
        'report_surface',
        'auto_commit',
        'autonomy_branch',
        'auto_continue_within_goal',
        'block_on_major_decision',
        'default_cruise_cadence',
        'default_sprint_heartbeat_minutes'
    )) {
        Assert-PropertyExists -Item $settings -Name $key -Path $Path
    }

    Assert-True ([string]$settings.install_source -eq 'local_package') "Invalid install_source in $Path."
    Assert-True ([string]$settings.report_surface -eq 'thread_and_inbox') "Invalid report_surface in $Path."
    Assert-True (@('disabled','autonomy_branch') -contains [string]$settings.auto_commit) "Invalid auto_commit mode in $Path."
    Assert-True ($settings.auto_continue_within_goal -is [bool]) "auto_continue_within_goal must be a boolean in $Path."
    Assert-True ($settings.block_on_major_decision -is [bool]) "block_on_major_decision must be a boolean in $Path."

    $cadence = $settings.default_cruise_cadence
    foreach ($key in @('planner_hours','worker_hours','reviewer_hours')) {
        Assert-PropertyExists -Item $cadence -Name $key -Path $Path -Context 'default_cruise_cadence from'
    }
}

function Test-ResultsDocument {
    param([Parameter(Mandatory)][string]$Path)
    $results = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $results -Name 'version' -Path $Path
    if ($results.PSObject.Properties.Name -contains 'last_thread_summary_sent_at' -and $null -ne $results.last_thread_summary_sent_at) {
        $threadSummarySentAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$results.last_thread_summary_sent_at, [ref]$threadSummarySentAt)) "Invalid last_thread_summary_sent_at in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'last_inbox_run_at' -and $null -ne $results.last_inbox_run_at) {
        $inboxRunAt = [datetime]::MinValue
        Assert-True ([DateTime]::TryParse([string]$results.last_inbox_run_at, [ref]$inboxRunAt)) "Invalid last_inbox_run_at in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'last_summary_kind') {
        Assert-True ($null -eq $results.last_summary_kind -or @('normal_success','thread_summary','immediate_exception','goal_transition') -contains [string]$results.last_summary_kind) "Invalid last_summary_kind in $Path."
    }
    if ($results.PSObject.Properties.Name -contains 'latest_goal_transition' -and $null -ne $results.latest_goal_transition) {
        $transition = $results.latest_goal_transition
        foreach ($key in @('from_goal_id','to_goal_id','happened_at')) {
            Assert-PropertyExists -Item $transition -Name $key -Path $Path -Context 'latest_goal_transition from'
        }
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$transition.from_goal_id)) "Invalid latest_goal_transition.from_goal_id in $Path."
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$transition.to_goal_id)) "Invalid latest_goal_transition.to_goal_id in $Path."
        if ($null -ne $transition.happened_at) {
            $transitionAt = [datetime]::MinValue
            Assert-True ([DateTime]::TryParse([string]$transition.happened_at, [ref]$transitionAt)) "Invalid latest_goal_transition.happened_at in $Path."
        }
    }

    foreach ($entryName in @('planner','worker','review','commit','reporter')) {
        Assert-PropertyExists -Item $results -Name $entryName -Path $Path
        $entry = $results.$entryName
        foreach ($key in @('status','goal_id','summary')) {
            Assert-PropertyExists -Item $entry -Name $key -Path $Path -Context "$entryName entry from"
        }

        Assert-True (@('not_run','noop','planned','passed','failed','blocked','sent','skipped') -contains [string]$entry.status) "Invalid $entryName result status in $Path."
    }
}

function Test-VerificationDocument {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'goal_id' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'policy' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'axes' -Path $Path

    Assert-True (@('strong_template') -contains [string]$doc.policy) "Invalid verification policy in $Path."
    foreach ($axis in @($doc.axes)) {
        foreach ($key in @('id','title','required','status','evidence','source_task_id','last_checked_at','reason')) {
            Assert-PropertyExists -Item $axis -Name $key -Path $Path -Context 'a verification axis from'
        }

        Assert-True (@('pending','passed','failed','blocked','not_applicable') -contains [string]$axis.status) "Invalid verification axis status in $Path."
    }
}

function Test-BlockerCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'blockers' -Path $Path

    foreach ($blocker in @($doc.blockers)) {
        foreach ($key in @(
            'id',
            'task_id',
            'question',
            'severity',
            'status',
            'resolution',
            'opened_at',
            'resolved_at'
        )) {
            Assert-PropertyExists -Item $blocker -Name $key -Path $Path -Context 'a blocker from'
        }

        Assert-True (@('low','medium','high') -contains [string]$blocker.severity) "Invalid blocker severity in $Path."
        Assert-True (@('open','resolved') -contains [string]$blocker.status) "Invalid blocker status in $Path."
    }
}

function Invoke-CliHarness {
    $cliDir = Join-Path $repoRoot 'tools/codex-supervisor'
    $packageJson = Join-Path $cliDir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        return
    }

    $tsc = Join-Path $cliDir 'node_modules/.bin/tsc.cmd'
    $vitestModule = Join-Path $cliDir 'node_modules/vitest/vitest.mjs'
    Assert-True (Test-Path -LiteralPath $tsc) 'Missing local TypeScript CLI. Run scripts/setup.windows.ps1 first.'
    Assert-True (Test-Path -LiteralPath $vitestModule) 'Missing local Vitest module. Run scripts/setup.windows.ps1 first.'

    Push-Location $cliDir
    try {
        & $tsc -p tsconfig.json --noEmit
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript validation failed with exit code $LASTEXITCODE."
        }

        & node $vitestModule run
        if ($LASTEXITCODE -ne 0) {
            throw "Vitest failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

Write-Host 'Verifying repo control surface...'

foreach ($requiredPath in @(
    'AGENTS.md',
    '.agents/skills/$autonomy-plan/SKILL.md',
    '.agents/skills/$autonomy-work/SKILL.md',
    '.agents/skills/$autonomy-intake/SKILL.md',
    '.agents/skills/$autonomy-review/SKILL.md',
    '.agents/skills/$autonomy-report/SKILL.md',
    '.agents/skills/$autonomy-sprint/SKILL.md',
    '.codex/environments/environment.toml',
    '.codex/config.toml',
    'scripts/setup.windows.ps1',
    'scripts/verify.ps1',
    'scripts/smoke.ps1',
    'scripts/review.ps1',
    'autonomy/goal.md',
    'autonomy/journal.md',
    'autonomy/tasks.json',
    'autonomy/goals.json',
    'autonomy/proposals.json',
    'autonomy/state.json',
    'autonomy/settings.json',
    'autonomy/results.json',
    'autonomy/verification.json',
    'autonomy/blockers.json',
    'autonomy/schema/tasks.schema.json',
    'autonomy/schema/goals.schema.json',
    'autonomy/schema/proposals.schema.json',
    'autonomy/schema/state.schema.json',
    'autonomy/schema/settings.schema.json',
    'autonomy/schema/results.schema.json',
    'autonomy/schema/blockers.schema.json',
    'autonomy/schema/verification.schema.json',
    'autonomy/locks'
)) {
    Assert-True (Test-Path -LiteralPath (Join-Path $repoRoot $requiredPath)) "Missing required path: $requiredPath"
}

Test-RequiredText -Path (Join-Path $repoRoot 'AGENTS.md') -Patterns @(
    '一次只处理一个任务',
    'scripts/verify.ps1',
    'scripts/review.ps1',
    'autonomy/\*',
    'cycle\.lock',
    'UTC ISO 8601',
    'repo-relative forward-slash',
    'codex/autonomy',
    'Reporter 只有异常',
    'Sprint runner 的 heartbeat 只是唤醒间隔'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-plan/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-plan',
    'autonomy/goals\.json',
    'awaiting_confirmation',
    'Keep at most 5 tasks in'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-work/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-work',
    'Select exactly one',
    'scripts/review\.ps1',
    'codex/autonomy',
    'review_pending'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-intake/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-intake',
    'Normalize a user goal'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-review/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-review',
    'scripts/review\.ps1'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-report/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-report',
    'Summarize the current autonomy state'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-sprint/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-sprint',
    'short, bounded execution loops'
)

Test-RequiredText -Path (Join-Path $repoRoot 'autonomy/goal.md') -Patterns @(
    '(?m)^# Objective',
    '(?m)^## Success Criteria',
    '(?m)^## Constraints',
    '(?m)^## Out of Scope'
)

Test-RequiredText -Path (Join-Path $repoRoot 'autonomy/journal.md') -Patterns @(
    'Append one entry per run',
    'Entry Template',
    'result: planned \| passed \| failed \| blocked \| noop'
)

$environment = Read-Toml -Path (Join-Path $repoRoot '.codex/environments/environment.toml')
Assert-True ($environment.version -eq 1) 'environment.toml version must be 1.'
Assert-True ($environment.setup.script -match 'scripts/setup.windows.ps1') 'environment.toml setup script must point to scripts/setup.windows.ps1.'

$actions = @($environment.actions)
Assert-True ($actions.Count -ge 3) 'environment.toml must define at least three actions.'
foreach ($requiredAction in @('verify', 'smoke', 'review')) {
    $match = $actions | Where-Object { $_.name -eq $requiredAction } | Select-Object -First 1
    Assert-True ($null -ne $match) "Missing action '$requiredAction' in environment.toml."
    Assert-True ($match.command -match "scripts/$requiredAction\.ps1") "Action '$requiredAction' must point to scripts/$requiredAction.ps1."
    Assert-True ($match.platform -eq 'windows') "Action '$requiredAction' must target windows."
}

$config = Read-SimpleTomlMap -Path (Join-Path $repoRoot '.codex/config.toml')
Assert-True ($config.Contains('approval_policy')) 'config.toml must define a top-level approval_policy.'
Assert-True (@('untrusted', 'on-request', 'never') -contains [string]$config['approval_policy']) 'config.toml approval_policy is invalid.'
Assert-True ($config.Contains('sandbox_mode')) 'config.toml must define a top-level sandbox_mode.'
Assert-True (@('read-only', 'workspace-write', 'danger-full-access') -contains [string]$config['sandbox_mode']) 'config.toml sandbox_mode is invalid.'
Assert-True ($config.Contains('model')) 'config.toml must define a top-level model.'
Assert-True ([string]$config['model'] -eq 'gpt-5.4') 'config.toml model must be gpt-5.4.'
Assert-True ($config.Contains('model_reasoning_effort')) 'config.toml must define a top-level model_reasoning_effort.'
Assert-True ([string]$config['model_reasoning_effort'] -eq 'xhigh') 'config.toml model_reasoning_effort must be xhigh.'
Assert-True ($config.Contains('service_tier')) 'config.toml must define a top-level service_tier.'
Assert-True ([string]$config['service_tier'] -eq 'fast') 'config.toml service_tier must be fast.'
Assert-True ($config.Contains('sandbox_workspace_write.network_access')) 'config.toml must define sandbox_workspace_write.network_access.'
Assert-True ($config['sandbox_workspace_write.network_access'] -is [bool]) 'config.toml sandbox_workspace_write.network_access must be a boolean.'
Assert-True ($config.Contains('windows.sandbox')) 'config.toml must define windows.sandbox.'
Assert-True (@('unelevated', 'elevated') -contains [string]$config['windows.sandbox']) 'config.toml windows.sandbox is invalid.'

Test-StateDocument -Path (Join-Path $repoRoot 'autonomy/state.json')
Test-TaskCollection -Path (Join-Path $repoRoot 'autonomy/tasks.json')
Test-GoalCollection -Path (Join-Path $repoRoot 'autonomy/goals.json')
Test-ProposalCollection -Path (Join-Path $repoRoot 'autonomy/proposals.json')
Test-SettingsDocument -Path (Join-Path $repoRoot 'autonomy/settings.json')
Test-ResultsDocument -Path (Join-Path $repoRoot 'autonomy/results.json')
Test-VerificationDocument -Path (Join-Path $repoRoot 'autonomy/verification.json')
Test-BlockerCollection -Path (Join-Path $repoRoot 'autonomy/blockers.json')

Invoke-CliHarness

Write-Host 'Install verify passed.'
`;
}

export function getEnvironmentTomlTemplate(): string {
  return [
    "# Generated repo environment for Codex app.",
    "version = 1",
    'name = "codex-autonomy"',
    "",
    "[setup]",
    'script = "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1"',
    "",
    "[[actions]]",
    'name = "verify"',
    'icon = "check"',
    'command = "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1"',
    'platform = "windows"',
    "",
    "[[actions]]",
    'name = "smoke"',
    'icon = "play"',
    'command = "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1"',
    'platform = "windows"',
    "",
    "[[actions]]",
    'name = "review"',
    'icon = "eye"',
    'command = "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/review.ps1"',
    'platform = "windows"',
  ].join("\n");
}

export function getConfigTomlTemplate(): string {
  return [
    "#:schema https://developers.openai.com/codex/config-schema.json",
    "",
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'model = "gpt-5.4"',
    'model_reasoning_effort = "xhigh"',
    'service_tier = "fast"',
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[windows]",
    'sandbox = "unelevated"',
  ].join("\n");
}

export function getSetupWindowsScriptTemplate(): string {
  return String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cliDir = Join-Path $repoRoot 'tools/codex-supervisor'

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-ForwardSlashPath {
    param([Parameter(Mandatory)][string]$Path)
    return $Path.Replace('\', '/')
}

function Add-GitSafeDirectory {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        return
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $normalized = Get-ForwardSlashPath -Path ((Resolve-Path -LiteralPath $Path).Path)
    $existing = @(& git config --global --get-all safe.directory 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $existing = @()
    }

    if ($existing -contains $normalized) {
        return
    }

    & git config --global --add safe.directory $normalized
    if ($LASTEXITCODE -ne 0) {
        throw "git config --global --add safe.directory failed for $normalized."
    }
}

Ensure-Directory -Path (Join-Path $repoRoot 'autonomy/locks')
Ensure-Directory -Path (Join-Path $repoRoot '.codex/environments')

if (Test-Path -LiteralPath (Join-Path $repoRoot '.git')) {
    Add-GitSafeDirectory -Path $repoRoot

    $parent = Split-Path -Path $repoRoot -Parent
    $leaf = Split-Path -Path $repoRoot -Leaf
    $backgroundPath = Join-Path $parent ($leaf + '.__codex_bg')
    if (Test-Path -LiteralPath $backgroundPath) {
        Add-GitSafeDirectory -Path $backgroundPath
    }
}

if (Test-Path -LiteralPath (Join-Path $cliDir 'package.json')) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is required to prepare tools/codex-supervisor.'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $cliDir 'node_modules'))) {
        Push-Location $cliDir
        try {
            if (Test-Path -LiteralPath (Join-Path $cliDir 'package-lock.json')) {
                & npm ci
            } else {
                & npm install
            }
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }
    }
}

Write-Host 'setup.windows.ps1 completed successfully.'
`;
}

export function getReadmeManagedSectionMarkdown(): string {
  return [
    "## codex-autonomy",
    "",
    "### install / upgrade / bind / verify / prepare-worktree",
    "",
    "- `codex-autonomy install --target <repo>`：安装 repo-local 控制面，不覆盖现有文件。",
    "- `codex-autonomy upgrade-managed --target <repo> [--apply]`：对齐受管控制面；`README.md` 只托管受限 section。",
    "- `codex-autonomy bind-thread [--report-thread-id <threadId>]`：绑定唯一 `report_thread_id`。",
    "- `codex-autonomy doctor`：检查运行时、schema、Git、Codex 进程与控制面健康。",
    "- `codex-autonomy prepare-worktree`：准备 background worktree；只在 Git 仓库内进入可运行 automation 态。",
    "- `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`：唯一正式验收门。",
    "",
    "### 日常命令入口",
    "",
    "- 标准路径：`codex-autonomy <command>`。",
    "- 机器级自然语言入口支持“把 auto 装进当前项目”“目标是……”“确认提案”“用冲刺模式推进这个目标”“继续当前目标”“汇报当前情况”等表达；router 会先做 install/upgrade/bind，再继续目标流。",
    "- 官方同线程持续推进主路：在已绑定的项目线程内，用 `codex-autonomy emit-automation-prompts --json` 取 `official_thread_automation.prompt`，并先阅读同一条记录里的 `whenToUse` / `whenNotToUse` / `selectionRule`，再交给 Codex thread automation heartbeat。",
    "- 外部 `Task Scheduler -> relay -> 绑定线程` 属于 fallback bridge，不是默认主路。",
    "- `codex-autonomy intake-goal --title <title> --objective <objective> --run-mode <sprint|cruise>`：把自然语言目标转成待确认 goal。",
    "- `codex-autonomy approve-proposal --goal-id <goalId>`：确认提案并物化任务。",
    "- `codex-autonomy status` / `report` / `review`：查看状态、结果与 review gate；`review` 会在可提交时自动完成受控 closeout commit 并立刻对齐 background worktree。",
    "- `codex-autonomy emit-automation-prompts --json`：输出官方 thread automation 主路与 relay fallback 所需的机读 prompt bundle，并附带 `whenToUse` / `whenNotToUse` / `selectionRule`，让 agent 自行判断该选哪条 surface 或 role。",
    "- `codex-autonomy status` 会把调度可唤醒态和执行可进入态拆开表达：`ready_for_automation` 负责“是否该唤醒”，`ready_for_execution` 负责“是否该进执行闭环”，并通过 `goal_supply_state` / `next_automation_step` 指明这轮该执行、规划、等待确认还是停机。",
    "",
    "### 控制面文件入口",
    "",
    "- `AGENTS.md`：硬规则与运行约定。",
    "- `.agents/skills/$autonomy-*`：repo-local skills。",
    "- `.codex/environments/environment.toml`：Windows setup 与 `verify` / `smoke` / `review` actions。",
    "- `.codex/config.toml`：repo 级默认模型与运行配置。",
    "- `autonomy/goals.json`、`proposals.json`、`tasks.json`、`state.json`、`settings.json`、`results.json`、`blockers.json`：自治真源。",
    "",
    "### thread binding / report",
    "",
    "- 原线程是唯一操作入口；`report_thread_id` 是汇总和异常回传锚点。",
    "- 当前线程身份可用时优先运行 `codex-autonomy bind-thread`；如果拿不到公开线程身份，只允许显式 `codex-autonomy bind-thread --report-thread-id <thread-id>`。",
    "- 线程身份不可用或不可信时不要猜测当前线程，也不要静默复用旧绑定。",
    "- relay completion event 要当成状态回传处理，不要误当成新的 goal intake；优先读取 `BEGIN_CODEX_RELAY_CALLBACK_JSON` 到 `END_CODEX_RELAY_CALLBACK_JSON` 之间的机读 payload。",
    "",
    "### 已知限制",
    "",
    "- 自 26.415 起，官方 thread automation 是同线程持续推进的首选路径；它保留线程上下文，适合 repo-local autonomy 的 bounded loop。",
    "- 早期 Windows 实测里，旧的 `heartbeat + MINUTELY` 路径曾出现“时间滚动但不实际投递”的现象。这个结论只覆盖旧路径验证，不应笼统套用到 26.415 的官方 thread automation。",
    "- 当当前线程不是绑定线程，或需要跨线程 / 外部唤醒时，再使用 relay 或外部调度器作为 fallback bridge。",
    "- 默认用 in-app browser 验收未登录的本地/公开页面；只有登录态页面才切到当前浏览器桥或其他 live browser 路径。",
  ].join("\n");
}

export function getReadmeMarkdown(): string {
  return [
    "# codex-autonomy",
    "",
    MANAGED_README_SECTION_START,
    getReadmeManagedSectionMarkdown(),
    MANAGED_README_SECTION_END,
    "",
  ].join("\n");
}

export function getVerifyScriptTemplate(): string {
  return getInstallVerifyScriptTemplate();
}

export function getSmokeScriptTemplate(): string {
  return String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $repoRoot '.codex/environments/environment.toml'

function Assert-Exists {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required path: $Path"
    }
}

Assert-Exists (Join-Path $repoRoot 'AGENTS.md')
Assert-Exists $environmentFile
Assert-Exists (Join-Path $repoRoot 'scripts/verify.ps1')
Assert-Exists (Join-Path $repoRoot 'scripts/setup.windows.ps1')
Assert-Exists (Join-Path $repoRoot 'scripts/review.ps1')

$environmentText = Get-Content -LiteralPath $environmentFile -Raw
if ($environmentText -notmatch 'setup.windows.ps1') {
    throw 'environment.toml does not reference setup.windows.ps1.'
}
if ($environmentText -notmatch 'name = "verify"') {
    throw 'environment.toml is missing the verify action.'
}
if ($environmentText -notmatch 'name = "smoke"') {
    throw 'environment.toml is missing the smoke action.'
}
if ($environmentText -notmatch 'name = "review"') {
    throw 'environment.toml is missing the review action.'
}

Write-Host 'Smoke precheck passed.'
`;
}

export function getReviewScriptTemplate(): string {
  return String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$environmentFile = Join-Path $repoRoot '.codex/environments/environment.toml'

function Assert-Exists {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required path: $Path"
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)

    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 100
    } catch {
        throw "Invalid JSON in $Path. $($_.Exception.Message)"
    }
}

function Get-OptionalString {
    param($Value)

    if ($null -eq $Value) {
        return $null
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    return $text
}

function Assert-EnvironmentContract {
    param([Parameter(Mandatory)][string]$Path)

    Assert-Exists $Path
    $environmentText = Get-Content -LiteralPath $Path -Raw

    if ($environmentText -notmatch '(?m)^\s*version\s*=\s*1\s*$') {
        throw 'environment.toml must define version = 1.'
    }

    if ($environmentText -notmatch '(?ms)^\[setup\]\s*(?:.*?\r?\n)*?script\s*=\s*"pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1"\s*(?:\r?\n|$)') {
        throw 'environment.toml setup script must point to scripts/setup.windows.ps1.'
    }

    $actionMatches = [regex]::Matches($environmentText, '(?ms)^\[\[actions\]\]\s*(.*?)(?=^\[\[actions\]\]|\z)')
    if ($actionMatches.Count -lt 3) {
        throw 'environment.toml must define verify, smoke, and review actions.'
    }

    foreach ($requiredAction in @(
        @{ Name = 'verify'; Command = 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1' },
        @{ Name = 'smoke'; Command = 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1' },
        @{ Name = 'review'; Command = 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/review.ps1' }
    )) {
        $block = $null
        foreach ($candidate in $actionMatches) {
            $text = $candidate.Groups[1].Value
            if ($text -match "(?m)^\s*name\s*=\s*""$([regex]::Escape([string]$requiredAction.Name))""\s*$") {
                $block = $text
                break
            }
        }

        Assert-True ($null -ne $block) "Missing action '$($requiredAction.Name)' in environment.toml."
        Assert-True ($block -match "(?m)^\s*command\s*=\s*""$([regex]::Escape([string]$requiredAction.Command))""\s*$") "Action '$($requiredAction.Name)' must point to scripts/$($requiredAction.Name).ps1."
        Assert-True ($block -match '(?m)^\s*platform\s*=\s*"windows"\s*$') "Action '$($requiredAction.Name)' must target windows."
    }
}

$smokeScript = Join-Path $repoRoot 'scripts/smoke.ps1'
$reviewLocalScript = Join-Path $repoRoot 'scripts/review.local.ps1'
$statePath = Join-Path $repoRoot 'autonomy/state.json'
$resultsPath = Join-Path $repoRoot 'autonomy/results.json'
$verificationPath = Join-Path $repoRoot 'autonomy/verification.json'
$goalsPath = Join-Path $repoRoot 'autonomy/goals.json'
$tasksPath = Join-Path $repoRoot 'autonomy/tasks.json'
$settingsPath = Join-Path $repoRoot 'autonomy/settings.json'

Assert-Exists $smokeScript
Assert-Exists $statePath
Assert-Exists $resultsPath
Assert-Exists $verificationPath
Assert-Exists $goalsPath
Assert-Exists $tasksPath
Assert-Exists $settingsPath

Assert-EnvironmentContract -Path $environmentFile

& $smokeScript
if (-not $?) {
    $exitCodeVar = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
    $exitCode = if ($null -eq $exitCodeVar) { 1 } else { [int]$exitCodeVar.Value }
    throw "smoke.ps1 failed with exit code $exitCode."
}

$state = Read-JsonFile -Path $statePath
$results = Read-JsonFile -Path $resultsPath
$verification = Read-JsonFile -Path $verificationPath
$goalsDoc = Read-JsonFile -Path $goalsPath
$tasksDoc = Read-JsonFile -Path $tasksPath
$settings = Read-JsonFile -Path $settingsPath

if (-not ($goalsDoc.PSObject.Properties.Name -contains 'goals')) {
    throw "Missing required key 'goals' in $goalsPath."
}
if (-not ($tasksDoc.PSObject.Properties.Name -contains 'tasks')) {
    throw "Missing required key 'tasks' in $tasksPath."
}

foreach ($requiredResultKey in @('planner', 'worker', 'review', 'commit', 'reporter')) {
    if (-not ($results.PSObject.Properties.Name -contains $requiredResultKey)) {
        throw "Missing required key '$requiredResultKey' in $resultsPath."
    }
}

if (-not ($verification.PSObject.Properties.Name -contains 'axes')) {
    throw "Missing required key 'axes' in $verificationPath."
}

$goals = @($goalsDoc.goals)
$tasks = @($tasksDoc.tasks)
$activeGoals = @($goals | Where-Object { [string]$_.status -eq 'active' })
if ($activeGoals.Count -gt 1) {
    throw "Found $($activeGoals.Count) active goals in $goalsPath. Expected at most one active goal."
}

$currentGoalId = Get-OptionalString $state.current_goal_id
$currentTaskId = Get-OptionalString $state.current_task_id
$stateRunMode = Get-OptionalString $state.run_mode
$stateAutonomyBranch = Get-OptionalString $state.autonomy_branch
$settingsAutonomyBranch = Get-OptionalString $settings.autonomy_branch

if ($null -ne $stateAutonomyBranch -and $null -ne $settingsAutonomyBranch -and $stateAutonomyBranch -ne $settingsAutonomyBranch) {
    throw "autonomy_branch mismatch between $statePath and $settingsPath."
}

$currentGoal = $null
if ($null -ne $currentGoalId) {
    $currentGoal = @($goals | Where-Object { [string]$_.id -eq $currentGoalId } | Select-Object -First 1)
    if ($currentGoal.Count -eq 0) {
        throw "Current goal '$currentGoalId' from $statePath does not exist in $goalsPath."
    }

    $goalRunMode = Get-OptionalString $currentGoal[0].run_mode
    if ($null -ne $stateRunMode -and $null -ne $goalRunMode -and $stateRunMode -ne $goalRunMode) {
        throw "run_mode mismatch between state '$stateRunMode' and current goal '$goalRunMode'."
    }
}

if ($null -ne $currentTaskId) {
    $currentTask = @($tasks | Where-Object { [string]$_.id -eq $currentTaskId } | Select-Object -First 1)
    if ($currentTask.Count -eq 0) {
        throw "Current task '$currentTaskId' from $statePath does not exist in $tasksPath."
    }

    if ($null -ne $currentGoalId -and [string]$currentTask[0].goal_id -ne $currentGoalId) {
        throw "Current task '$currentTaskId' does not belong to current goal '$currentGoalId'."
    }
}

$goalsRequiringThreadBinding = @($goals | Where-Object {
    @('awaiting_confirmation', 'approved', 'active') -contains [string]$_.status
})

if ($goalsRequiringThreadBinding.Count -gt 0 -and $null -eq (Get-OptionalString $state.report_thread_id)) {
    throw "report_thread_id must be set in $statePath before review can pass for actionable goals."
}

if (Test-Path -LiteralPath $reviewLocalScript) {
    & $reviewLocalScript
    if (-not $?) {
        $exitCodeVar = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
        $exitCode = if ($null -eq $exitCodeVar) { 1 } else { [int]$exitCodeVar.Value }
        throw "review.local.ps1 failed with exit code $exitCode."
    }
}

Write-Host 'Review checks passed.'
`;
}

export function getLegacyReviewScriptTemplates(): string[] {
  return [
    String.raw`[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-Exists {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required path: $Path"
    }
}

Assert-Exists (Join-Path $repoRoot 'scripts/smoke.ps1')

& (Join-Path $repoRoot 'scripts/smoke.ps1')
if (-not $?) {
    $exitCodeVar = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
    $exitCode = if ($null -eq $exitCodeVar) { 1 } else { [int]$exitCodeVar.Value }
    throw "smoke.ps1 failed with exit code $exitCode."
}

Write-Host 'Review precheck passed.'
`,
  ];
}
