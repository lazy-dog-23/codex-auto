[CmdletBinding()]
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
    Assert-True $hasProperty "Missing required key '$Name' in ${prefix}$Path."
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
                throw "Unsupported TOML line in ${Path}: $line"
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
    '绝不自动 `commit`、`push` 或 `deploy`'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-plan/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-plan',
    'queued',
    'Keep at most 5 tasks in `ready`'
)

Test-RequiredText -Path (Join-Path $repoRoot '.agents/skills/$autonomy-work/SKILL.md') -Patterns @(
    '(?m)^---',
    '(?m)^name:\s*autonomy-work',
    'Select exactly one `ready` task',
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

Test-StateDocument -Path (Join-Path $repoRoot 'autonomy/state.json')
Test-TaskCollection -Path (Join-Path $repoRoot 'autonomy/tasks.json')
Test-BlockerCollection -Path (Join-Path $repoRoot 'autonomy/blockers.json')

Invoke-CliHarness

Write-Host 'verify.ps1 completed successfully.'
