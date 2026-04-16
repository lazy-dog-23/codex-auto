[CmdletBinding()]
param(
    [string]$TaskName = 'Codex Relay Scheduled Test',
    [ValidateRange(1, 1439)]
    [int]$EveryMinutes = 15,
    [string]$RunnerPath = (Join-Path $PSScriptRoot 'run-codex-relay-scheduled-test.ps1'),
    [Parameter(Mandatory)][string]$TargetRepoRoot,
    [Parameter(Mandatory)][string]$TargetThreadId,
    [Parameter(Mandatory)][string]$RelayRepoRoot,
    [string]$LogDir,
    [ValidateSet('status-only', 'bounded-loop')]
    [string]$Mode = 'bounded-loop',
    [ValidateRange(1, 3600)]
    [int]$TimeoutSec = 45,
    [ValidateRange(1, 60)]
    [int]$StatusPollAttempts = 6,
    [ValidateRange(1, 300)]
    [int]$StatusPollIntervalSec = 10,
    [switch]$RecoverOnTimeout,
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
        return 'codex-relay-scheduled-test'
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
$resolvedTargetRepoRoot = Resolve-AbsolutePath -Path $TargetRepoRoot
$resolvedRelayRepoRoot = Resolve-AbsolutePath -Path $RelayRepoRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Get-DefaultExternalLogDir -RepoRoot $resolvedTargetRepoRoot -BucketName 'scheduled-relay-runs'
}
$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$launcherDir = Join-Path $PSScriptRoot 'scheduler-launchers'
$launcherStem = Convert-ToSafeFileStem -Value $TaskName
$launcherPath = Join-Path $launcherDir ($launcherStem + '.cmd')

$launcherParts = @(
    ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $pwsh, $resolvedRunnerPath)
    ('-TargetRepoRoot "{0}"' -f $resolvedTargetRepoRoot)
    ('-TargetThreadId "{0}"' -f $TargetThreadId)
    ('-RelayRepoRoot "{0}"' -f $resolvedRelayRepoRoot)
    ('-LogDir "{0}"' -f $resolvedLogDir)
    ('-Mode {0}' -f $Mode)
    ('-TimeoutSec {0}' -f $TimeoutSec)
    ('-StatusPollAttempts {0}' -f $StatusPollAttempts)
    ('-StatusPollIntervalSec {0}' -f $StatusPollIntervalSec)
)

if ($RecoverOnTimeout) {
    $launcherParts += '-RecoverOnTimeout'
}

$launcherContent = "@echo off`r`n" + ($launcherParts -join ' ')
$taskCommand = '"' + $launcherPath + '"'

if ($PreviewOnly) {
    Write-Host "Launcher path: $launcherPath"
    Write-Host "Launcher command:"
    Write-Host $launcherContent
    Write-Host "Log directory: $resolvedLogDir"
    Write-Host "schtasks /create /tn `"$TaskName`" /sc minute /mo $EveryMinutes /tr `"$taskCommand`" /f"
    exit 0
}

Ensure-Directory -Path $launcherDir
Set-Content -LiteralPath $launcherPath -Value $launcherContent -Encoding ascii
& schtasks /create /tn $TaskName /sc minute /mo $EveryMinutes /tr $taskCommand /f | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /create failed with exit code $LASTEXITCODE."
}

Write-Host "Scheduled relay task created."
Write-Host "Task name: $TaskName"
Write-Host "Interval: every $EveryMinutes minute(s)"
Write-Host "Runner: $resolvedRunnerPath"
Write-Host "Log directory: $resolvedLogDir"
Write-Host "Launcher: $launcherPath"
