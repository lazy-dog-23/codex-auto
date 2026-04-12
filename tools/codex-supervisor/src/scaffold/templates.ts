export function getAgentsMarkdown(): string {
  return [
    "# Repo Control Surface",
    "",
    "这份仓库把控制面收口在 repo 内。任何自动化工作都必须先读这里，再读对应 skill 和 `autonomy/*` 状态文件。",
    "",
    "## 硬规则",
    "",
    "1. 一次只处理一个任务，禁止并行拿多个任务。",
    "2. 唯一验收门是 `scripts/verify.ps1`。",
    "3. 只改必要源文件和 `autonomy/*`，不要扩散到无关区域。",
    "4. 遇到歧义、冲突、缺失上下文时，先写 blocker，再停止。",
    "5. 绝不自动 `commit`、`push` 或 `deploy`。",
    "6. 所有写入 `autonomy/*` 的动作，先拿 `autonomy/locks/cycle.lock`。",
    "7. `autonomy/*` 下的 JSON 必须原子写入，时间统一用 UTC ISO 8601，路径统一用 repo-relative forward-slash。",
    "",
    "## 运行约定",
    "",
    "- Planner 只维护 `queued` / `ready` 窗口，最多保留 5 个 `ready` 任务，不修改业务代码。",
    "- Worker 每轮只拿一个 `ready` 任务，做最小改动，跑验证，更新状态后停止。",
    "- 第一次验证失败记为 `verify_failed`；第二次失败或真实歧义记为 `blocked` 并新增 blocker。",
    "- dirty background worktree 立即置为 `review_pending` 并停机。",
    "- 非 Git 目录允许 `bootstrap`，但不允许进入可运行 automation 态。",
    "",
    "## Skills",
    "",
    "- `.agents/skills/$autonomy-plan/SKILL.md`",
    "- `.agents/skills/$autonomy-work/SKILL.md`",
    "",
    "## Shared Environment",
    "",
    "- `.codex/environments/environment.toml` 由 repo 共享，包含 Windows setup script，以及 `verify` 和 `smoke` 两个 actions。",
  ].join("\n");
}

export function getAutonomyPlanSkillMarkdown(): string {
  return [
    "---",
    "name: autonomy-plan",
    "description: Read the autonomy goal and state, keep the queued/ready window within policy, and update autonomy files without touching business code.",
    "---",
    "",
    "# autonomy-plan",
    "",
    "Use this skill when you need to plan the next automation cycle for the repo control plane.",
    "",
    "## Responsibilities",
    "",
    "- Read `autonomy/goal.md`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, and any directly relevant source hints.",
    "- Decide which eligible tasks should be `ready` and which should stay `queued`.",
    "- Keep at most 5 tasks in `ready`.",
    "- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.",
    "- Write `autonomy/*.json` via atomic temp-file then rename semantics.",
    "- Update only autonomy state and journal entries.",
    "",
    "## Guardrails",
    "",
    "- Do not edit business code.",
    "- Do not take implementation ownership of a worker task.",
    "- Do not bypass blockers or dependencies.",
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
    "description: Pick one ready task, make the smallest change that satisfies it, verify the result, and stop.",
    "---",
    "",
    "# autonomy-work",
    "",
    "Use this skill when you are executing a single ready task in a dedicated worktree.",
    "",
    "## Responsibilities",
    "",
    "- Read `autonomy/goal.md`, `autonomy/tasks.json`, `autonomy/state.json`, and `autonomy/blockers.json`.",
    "- Select exactly one `ready` task.",
    "- Make the smallest possible change for that task.",
    "- Run `scripts/verify.ps1`.",
    "- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.",
    "- Write `autonomy/*.json` via atomic temp-file then rename semantics.",
    "- Update task status and append one journal entry.",
    "",
    "## Guardrails",
    "",
    "- Do not pick a second task in the same run.",
    "- Do not auto commit, push, or deploy.",
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

export function getDefaultGoalMarkdown(): string {
  return [
    "# Objective",
    "",
    "建立一个 Windows 原生 Codex 自治项目控制面，所有自治状态都由 repo 内文件驱动，所有运行规则都明确、可校验、可恢复。",
    "",
    "## Success Criteria",
    "",
    "- Codex app 能读取 repo 级 `AGENTS.md` 和 repo skills。",
    "- `.codex/environments/environment.toml` 能定义 Windows setup script，以及 `verify` 和 `smoke` 两个 actions。",
    "- `scripts/setup.windows.ps1` 可重复执行且不覆盖已有内容。",
    "- `scripts/verify.ps1` 是唯一正式验收门。",
    "",
    "## Constraints",
    "",
    "- 不触碰 Codex 内部数据库、automation TOML、SQLite 或其他未公开接口。",
    "- 不自动 `commit`、`push` 或 `deploy`。",
    "- 所有写入 `autonomy/*` 的动作都必须先拿 `autonomy/locks/cycle.lock`。",
    "- 时间统一为 UTC ISO 8601，路径统一为 repo-relative forward-slash。",
    "",
    "## Out of Scope",
    "",
    "- GUI dashboard。",
    "- 自动提交、自动推送、自动部署。",
    "- Windows hooks。",
    "- 直接操控 Codex app 内部状态。",
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

export function getEnvironmentTomlTemplate(): string {
  return [
    "# Generated repo environment for Codex app.",
    "version = 1",
    'name = "codex-auto"',
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
  ].join("\n");
}

export function getConfigTomlTemplate(): string {
  return [
    "#:schema https://developers.openai.com/codex/config-schema.json",
    "",
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
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

export function getReadmeMarkdown(): string {
  return [
    "# codex-auto",
    "",
    "Windows 原生 Codex 自治项目，控制面全部放在 repo 内，`codex-supervisor` 只负责初始化、体检、worktree 准备、状态汇总和 prompt 输出。",
    "",
    "## 快速开始",
    "",
    "1. 确认本机有 Node.js 22、npm、Git、PowerShell 7。",
    "2. 在仓库根目录运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/setup.windows.ps1`。",
    "3. 运行 `npm --prefix tools/codex-supervisor run build` 生成 `dist/cli.js`。",
    "4. 运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1`，这是唯一正式验收门。",
    "5. 运行 `node tools/codex-supervisor/dist/cli.js doctor` 查看环境与控制面健康状况。",
    "6. 目录已经是 Git 仓库后，再运行 `node tools/codex-supervisor/dist/cli.js prepare-worktree` 创建专用 background worktree。",
    "",
    "## 日常命令",
    "",
    "- `node tools/codex-supervisor/dist/cli.js bootstrap`：补齐缺失控制面文件；非 Git 目录允许执行，但不会进入可运行 automation 态。",
    "- `node tools/codex-supervisor/dist/cli.js doctor`：检查 Node、Git、PowerShell、Codex 进程、关键文件、schema、锁、worktree 健康。",
    "- `node tools/codex-supervisor/dist/cli.js status`：汇总任务数量、当前状态、blockers、上次结果、是否适合下一轮 automation。",
    "- `node tools/codex-supervisor/dist/cli.js prepare-worktree`：创建或校验专用 background worktree；主仓库或 background worktree dirty 时会拒绝继续。",
    "- `node tools/codex-supervisor/dist/cli.js emit-automation-prompts`：输出 Planner / Worker prompt 与建议 cadence。",
    "- `node tools/codex-supervisor/dist/cli.js unblock <task-id>`：关闭对应 blocker，并按依赖与 ready 窗口策略恢复任务到 `ready` 或 `queued`。",
    "",
    "## Repo 控制面",
    "",
    "- `AGENTS.md`：硬规则与运行约定。",
    "- `.agents/skills/$autonomy-plan`、`.agents/skills/$autonomy-work`：Planner / Worker repo skill。",
    "- `.codex/environments/environment.toml`：Windows setup 与 `verify` / `smoke` actions。",
    "- `autonomy/tasks.json`、`autonomy/state.json`、`autonomy/blockers.json`：任务、状态、blocker 真源。",
    "- `autonomy/journal.md`：每次 run 只追加一条记录。",
    "- `scripts/verify.ps1`：唯一验收门。",
    "",
    "## Background Worktree",
    "",
    "- 默认路径：仓库同级目录下的 `<repo-name>.__codex_bg`。",
    "- 默认分支：`codex/background`。",
    "- supervisor 只准备和校验 worktree，不会自动 `commit`、`push` 或 `deploy`。",
    "",
    "## Git safe.directory",
    "",
    "`scripts/setup.windows.ps1` 会在检测到当前目录是 Git 仓库时，幂等地把主仓库和已存在的 background worktree 写入全局 `safe.directory`。`prepare-worktree` 在创建或校验 background worktree 后，也会自动补齐主仓库和 background worktree 的 `safe.directory`，避免 Windows 上的 dubious ownership 阻塞 Git 命令。",
    "",
    "## 任务样例",
    "",
    "```json",
    "{",
    '  "version": 1,',
    '  "tasks": [',
    "    {",
    '      "id": "task-example",',
    '      "title": "Add a minimal smoke assertion",',
    '      "status": "queued",',
    '      "priority": "P1",',
    '      "depends_on": [],',
    '      "acceptance": ["smoke script passes"],',
    '      "file_hints": ["scripts/smoke.ps1"],',
    '      "retry_count": 0,',
    '      "last_error": null,',
    '      "updated_at": "2026-04-12T00:00:00Z"',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "## 运行边界",
    "",
    "- 第一版允许改代码和跑验证，但禁止自动 `commit`、`push`、`deploy`。",
    "- 非 Git 目录允许 `bootstrap`，但 `status` 不会给出可运行 automation 的结论。",
    "- `ready_for_automation=false` 常见原因包括：没有任务、存在 blocker、仓库 dirty、background worktree 缺失或 dirty、Codex app 未运行、cycle lock 正在占用。",
  ].join("\n");
}

export function getVerifyScriptTemplate(): string {
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
    $prefix = if ([string]::IsNullOrWhiteSpace($Context)) { '' } else { "$Context " }
    Assert-True $hasProperty "Missing required key '$Name' in $prefix$Path."
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
                throw "Unsupported TOML line in $Path: $line"
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
            throw "Unsupported TOML array-of-tables in \${Path}: $line"
        }

        if ($line -notmatch '^(?<key>[A-Za-z0-9_.:-]+)\s*=\s*(?<value>.+)$') {
            throw "Unsupported TOML line in \${Path}: $line"
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
            throw "Unsupported TOML value in \${Path}: $line"
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
        'current_task_id',
        'cycle_status',
        'last_planner_run_at',
        'last_worker_run_at',
        'last_result',
        'consecutive_worker_failures',
        'needs_human_review',
        'open_blocker_count'
    )) {
        Assert-PropertyExists -Item $state -Name $key -Path $Path
    }
}

function Test-TaskCollection {
    param([Parameter(Mandatory)][string]$Path)
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-PropertyExists -Item $doc -Name 'version' -Path $Path
    Assert-PropertyExists -Item $doc -Name 'tasks' -Path $Path
    foreach ($task in @($doc.tasks)) {
        foreach ($key in @(
            'id',
            'title',
            'status',
            'priority',
            'depends_on',
            'acceptance',
            'file_hints',
            'retry_count',
            'last_error',
            'updated_at'
        )) {
            Assert-PropertyExists -Item $task -Name $key -Path $Path -Context 'a task from'
        }
        Assert-True (@('queued','ready','in_progress','verify_failed','blocked','done') -contains $task.status) "Invalid task status in $Path."
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
        Assert-True (@('open','resolved') -contains $blocker.status) "Invalid blocker status in $Path."
    }
}

function Invoke-CliHarness {
    $cliDir = Join-Path $repoRoot 'tools/codex-supervisor'
    $packageJson = Join-Path $cliDir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        return
    }

    $tsc = Join-Path $cliDir 'node_modules/.bin/tsc.cmd'
    $vitest = Join-Path $cliDir 'node_modules/.bin/vitest.cmd'
    Assert-True (Test-Path -LiteralPath $tsc) 'Missing local TypeScript CLI. Run scripts/setup.windows.ps1 first.'
    Assert-True (Test-Path -LiteralPath $vitest) 'Missing local Vitest CLI. Run scripts/setup.windows.ps1 first.'

    Push-Location $cliDir
    try {
        & $tsc -p tsconfig.json --noEmit
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript validation failed with exit code $LASTEXITCODE."
        }

        & $vitest run
        if ($LASTEXITCODE -ne 0) {
            throw "vitest failed with exit code $LASTEXITCODE."
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
    '.codex/environments/environment.toml',
    '.codex/config.toml',
    'scripts/setup.windows.ps1',
    'scripts/smoke.ps1',
    'scripts/verify.ps1',
    'autonomy/goal.md',
    'autonomy/journal.md',
    'autonomy/tasks.json',
    'autonomy/state.json',
    'autonomy/blockers.json',
    'autonomy/schema/tasks.schema.json',
    'autonomy/schema/state.schema.json',
    'autonomy/schema/blockers.schema.json'
)) {
    Assert-True (Test-Path -LiteralPath (Join-Path $repoRoot $requiredPath)) "Missing required path: $requiredPath"
}

Test-RequiredText -Path (Join-Path $repoRoot 'AGENTS.md') -Patterns @(
    '一次只处理一个任务',
    'scripts/verify.ps1',
    'autonomy/\*',
    'cycle\.lock',
    'UTC ISO 8601',
    'repo-relative forward-slash',
    '绝不自动 \`commit\`、\`push\` 或 \`deploy\`'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-plan/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-plan',
    'queued',
    'Keep at most 5 tasks in \`ready\`'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-work/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-work',
    'Select exactly one \`ready\` task',
    'review_pending'
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
Assert-True ($actions.Count -ge 2) 'environment.toml must define at least two actions.'
foreach ($requiredAction in @('verify', 'smoke')) {
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
Assert-True ($config.Contains('sandbox_workspace_write.network_access')) 'config.toml must define sandbox_workspace_write.network_access.'
Assert-True ($config['sandbox_workspace_write.network_access'] -is [bool]) 'config.toml sandbox_workspace_write.network_access must be a boolean.'
Assert-True ($config.Contains('windows.sandbox')) 'config.toml must define windows.sandbox.'
Assert-True (@('unelevated', 'elevated') -contains [string]$config['windows.sandbox']) 'config.toml windows.sandbox is invalid.'

Test-StateDocument -Path (Join-Path $repoRoot 'autonomy/state.json')
Test-TaskCollection -Path (Join-Path $repoRoot 'autonomy/tasks.json')
Test-BlockerCollection -Path (Join-Path $repoRoot 'autonomy/blockers.json')

Invoke-CliHarness

Write-Host 'verify.ps1 completed successfully.'
`;
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

Write-Host 'Smoke precheck passed.'
`;
}
