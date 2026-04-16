[CmdletBinding()]
param(
    [string]$TaskName = 'Codex Scheduled Test',
    [ValidateRange(1, 1439)]
    [int]$EveryMinutes = 15,
    [string]$RunnerPath = (Join-Path $PSScriptRoot 'run-codex-scheduled-test.ps1'),
    [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
    [string]$LogDir,
    [ValidateSet('npx', 'direct')]
    [string]$CodexLauncher = 'npx',
    [ValidateSet('status-only', 'bounded-loop')]
    [string]$Mode = 'bounded-loop',
    [switch]$PreviewOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    return (Resolve-Path -LiteralPath $Path).Path
}

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Convert-ToSafeFileStem {
    param([Parameter(Mandatory)][string]$Value)
    $safe = ($Value -replace '[^A-Za-z0-9._-]+', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return 'codex-scheduled-test'
    }

    return $safe
}

function Convert-ToSafePathSegment {
    param([Parameter(Mandatory)][string]$Value)
    $safe = ($Value -replace '[^A-Za-z0-9._-]+', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return 'repo'
    }

    return $safe
}

function Get-CodexHomeRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        return $env:CODEX_HOME
    }

    return (Join-Path $HOME '.codex')
}

function Get-DefaultExternalLogDir {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$BucketName
    )

    $repoName = Split-Path -Leaf $RepoRoot
    $safeRepoName = Convert-ToSafePathSegment -Value $repoName
    return (Join-Path (Join-Path (Get-CodexHomeRoot) $BucketName) $safeRepoName)
}

$resolvedRunnerPath = Resolve-AbsolutePath -Path $RunnerPath
$resolvedRepoRoot = Resolve-AbsolutePath -Path $RepoRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Get-DefaultExternalLogDir -RepoRoot $resolvedRepoRoot -BucketName 'scheduled-runs'
}
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$launcherDir = Join-Path $PSScriptRoot 'scheduler-launchers'
Ensure-Directory -Path $launcherDir
$launcherStem = Convert-ToSafeFileStem -Value $TaskName
$launcherPath = Join-Path $launcherDir ($launcherStem + '.cmd')

$launcherCommandLine = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -RepoRoot "{2}" -LogDir "{3}" -CodexLauncher {4} -Mode {5}' -f `
    $pwsh, $resolvedRunnerPath, $resolvedRepoRoot, $resolvedLogDir, $CodexLauncher, $Mode
$launcherContent = "@echo off`r`n$launcherCommandLine"

$taskCommand = '"' + $launcherPath + '"'

if ($PreviewOnly) {
    Write-Host "Launcher path: $launcherPath"
    Write-Host "Launcher command:"
    Write-Host $launcherContent
    Write-Host "Log directory: $resolvedLogDir"
    Write-Host "schtasks /create /tn `"$TaskName`" /sc minute /mo $EveryMinutes /tr `"$taskCommand`" /f"
    exit 0
}

Set-Content -LiteralPath $launcherPath -Value $launcherContent -Encoding ascii
& schtasks /create /tn $TaskName /sc minute /mo $EveryMinutes /tr $taskCommand /f | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /create failed with exit code $LASTEXITCODE."
}

Write-Host "Scheduled task created."
Write-Host "Task name: $TaskName"
Write-Host "Interval: every $EveryMinutes minute(s)"
Write-Host "Runner: $resolvedRunnerPath"
Write-Host "Log directory: $resolvedLogDir"
Write-Host "Launcher: $launcherPath"
