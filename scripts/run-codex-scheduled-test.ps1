[CmdletBinding()]
param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
    [string]$LogDir,
    [ValidateSet('npx', 'direct')]
    [string]$CodexLauncher = 'npx',
    [string]$CodexCommand = 'codex',
    [ValidateSet('status-only', 'bounded-loop')]
    [string]$Mode = 'bounded-loop',
    [switch]$PreviewOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-CodexInvocation {
    param(
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][string]$DirectCommand
    )

    if ($Launcher -eq 'npx') {
        return @{
            Command = 'npx'
            PrefixArgs = @('-y', '@openai/codex')
            Display = 'npx -y @openai/codex'
        }
    }

    return @{
        Command = $DirectCommand
        PrefixArgs = @()
        Display = $DirectCommand
    }
}

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

function New-RunPrompt {
    param([Parameter(Mandatory)][string]$SelectedMode)

    if ($SelectedMode -eq 'status-only') {
        return @'
Run `codex-autonomy status` from the repository root and stop.

Return a compact report that includes:
- ready_for_automation
- automation_state
- next_automation_reason
- current_goal
- current_task
- next_task

Do not modify files.
Do not commit, push, or deploy.
'@
    }

    return @'
Start by running `codex-autonomy status`.

If `ready_for_automation` is not `yes`, stop after reporting `next_automation_reason`.

If `ready_for_automation` is `yes`, continue the current approved goal for exactly one bounded loop.

Rules:
- Follow the repository `AGENTS.md` instructions and repo-local autonomy skills.
- Work on at most one task in this run.
- Run the required verify/review gates before closeout when the task needs them.
- Do not push, deploy, rewrite history, or broaden scope.
- If you hit a blocker, record it in the control plane and stop.
- End with a short result summary.
'@
}

$resolvedRepoRoot = Resolve-AbsolutePath -Path $RepoRoot

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Get-DefaultExternalLogDir -RepoRoot $resolvedRepoRoot -BucketName 'scheduled-runs'
}

$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
Ensure-Directory -Path $resolvedLogDir

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $resolvedLogDir $timestamp
Ensure-Directory -Path $runDir

$prompt = New-RunPrompt -SelectedMode $Mode
$promptPath = Join-Path $runDir 'prompt.md'
$stdoutPath = Join-Path $runDir 'stdout.txt'
$stderrPath = Join-Path $runDir 'stderr.txt'
$summaryPath = Join-Path $runDir 'summary.txt'
$metadataPath = Join-Path $runDir 'metadata.json'

Set-Content -LiteralPath $promptPath -Value $prompt -Encoding utf8NoBOM

$codexInvocation = Resolve-CodexInvocation -Launcher $CodexLauncher -DirectCommand $CodexCommand
$codexArgs = @(
    $codexInvocation.PrefixArgs
    'exec',
    '-C', $resolvedRepoRoot,
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy=never',
    '--output-last-message', $summaryPath,
    $prompt
)

$metadata = [ordered]@{
    repo_root = $resolvedRepoRoot
    log_dir = $resolvedLogDir
    run_dir = $runDir
    mode = $Mode
    codex_launcher = $CodexLauncher
    codex_command = $codexInvocation.Command
    codex_display = $codexInvocation.Display
    codex_args = $codexArgs
    prompt_path = $promptPath
    stdout_path = $stdoutPath
    stderr_path = $stderrPath
    summary_path = $summaryPath
    started_at = (Get-Date).ToUniversalTime().ToString('o')
    preview_only = [bool]$PreviewOnly
}

if ($PreviewOnly) {
    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
    Write-Host "Preview prepared."
    Write-Host "Run directory: $runDir"
    Write-Host "Prompt file: $promptPath"
    Write-Host "Codex command: $($codexInvocation.Command) $($codexArgs -join ' ')"
    exit 0
}

Push-Location $resolvedRepoRoot
try {
    & $codexInvocation.Command @codexArgs 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

$metadata.exit_code = $exitCode
$metadata.completed_at = (Get-Date).ToUniversalTime().ToString('o')
$metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM

if ($exitCode -ne 0) {
    throw "codex exec failed with exit code $exitCode. See $stderrPath and $stdoutPath."
}

Write-Host "Scheduled Codex test run completed."
Write-Host "Run directory: $runDir"
Write-Host "Summary file: $summaryPath"
