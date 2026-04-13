[CmdletBinding()]
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
