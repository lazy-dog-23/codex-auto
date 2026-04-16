[CmdletBinding()]
param(
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

function Get-OptionalPropertyValue {
    param(
        [Parameter(Mandatory)][AllowNull()][object]$InputObject,
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][object]$Default = $null
    )

    if ($null -eq $InputObject) {
        return $Default
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }

    return $property.Value
}

function New-RelayPrompt {
    param([Parameter(Mandatory)][string]$SelectedMode)

    if ($SelectedMode -eq 'status-only') {
        return @'
汇报当前情况。

这是一次外部调度唤醒，来自 Windows Task Scheduler，经由 `thread-relay-mcp` 投递到当前绑定线程。
不要把它当成新 goal、自由执行模式或人工临时加 scope。

请先运行 `codex-autonomy status`，然后停止。

只返回这些字段：
- SCHEDULED_RELAY_MARKER=STATUS_ONLY_OK
- ready_for_automation
- automation_state
- next_automation_reason
- current_goal
- current_task
- report_thread_id
- current_thread_id
- thread_binding_state
- thread_binding_hint

不要修改文件。
不要 intake goal、approve proposal、继续任务、commit、push 或 deploy。
不要新建线程，也不要变更 `report_thread_id`。
'@
    }

    return @'
继续当前目标。

这是一次外部调度唤醒，来自 Windows Task Scheduler，经由 `thread-relay-mcp` 投递到当前绑定线程。
不要把它当成新 goal、自由执行模式或人工临时加 scope。

先运行 `codex-autonomy status`。

如果 `ready_for_automation=false`，原样汇报 `next_automation_reason` 并停止。
如果 `thread_binding_state` 不是 `bound_to_current`，明确报告 mismatch 并停止。

如果允许继续，只推进当前已批准目标的一次有界 sprint 闭环：
- 最多处理一个 task
- 遵守仓库 `AGENTS.md` 和 repo-local autonomy skills
- 必要时命中 verify / review gate
- 遇到 blocker、review_pending、dirty repo 或范围歧义时停止
- 不要新建线程，不要 intake 新 goal，不要 approve proposal，不要变更 `report_thread_id`

结束时请返回：
- SCHEDULED_RELAY_MARKER=BOUNDED_LOOP_OK
- ready_for_automation
- automation_state
- report_thread_id
- current_thread_id
- thread_binding_state
- thread_binding_hint
- current_goal
- current_task
- result_summary

不要 push、deploy、改写历史，也不要扩展到已批准边界之外。
'@
}

function Invoke-RelayCli {
    param(
        [Parameter(Mandatory)][string]$RelayRoot,
        [Parameter(Mandatory)][string]$CommandName,
        [Parameter(Mandatory)][hashtable]$Payload,
        [Parameter(Mandatory)][string]$RunDir
    )

    $node = (Get-Command node -ErrorAction Stop).Source
    $cliPath = Join-Path $RelayRoot 'src\cli.js'
    if (-not (Test-Path -LiteralPath $cliPath)) {
        throw "Relay CLI not found: $cliPath"
    }

    $safeName = ($CommandName -replace '[^A-Za-z0-9._-]+', '-')
    $payloadPath = Join-Path $RunDir ($safeName + '.payload.json')
    $stdoutPath = Join-Path $RunDir ($safeName + '.stdout.json')
    $stderrPath = Join-Path $RunDir ($safeName + '.stderr.txt')

    $Payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $payloadPath -Encoding utf8NoBOM

    & $node $cliPath $CommandName --params-file $payloadPath --json 1> $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE

    $raw = if (Test-Path -LiteralPath $stdoutPath) {
        Get-Content -LiteralPath $stdoutPath -Raw
    } else {
        ''
    }

    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "Relay CLI produced no JSON output for $CommandName. See $stderrPath."
    }

    return [pscustomobject]@{
        ExitCode   = $exitCode
        Payload    = ($raw | ConvertFrom-Json -Depth 20)
        PayloadPath = $payloadPath
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
    }
}

function Write-Summary {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Summary
    )

    ($Summary.GetEnumerator() | Sort-Object Name | ForEach-Object {
        '{0}={1}' -f $_.Name, $_.Value
    }) | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

$resolvedTargetRepoRoot = Resolve-AbsolutePath -Path $TargetRepoRoot
$resolvedRelayRepoRoot = Resolve-AbsolutePath -Path $RelayRepoRoot

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Get-DefaultExternalLogDir -RepoRoot $resolvedTargetRepoRoot -BucketName 'scheduled-relay-runs'
}

$resolvedLogDir = [System.IO.Path]::GetFullPath($LogDir)
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $resolvedLogDir $timestamp
$prompt = New-RelayPrompt -SelectedMode $Mode
$promptPath = Join-Path $runDir 'prompt.md'
$summaryPath = Join-Path $runDir 'summary.txt'
$metadataPath = Join-Path $runDir 'metadata.json'

if ($PreviewOnly) {
    Write-Host "Preview prepared."
    Write-Host "Run directory: $runDir"
    Write-Host "Log directory: $resolvedLogDir"
    Write-Host "Prompt file: $promptPath"
    Write-Host "Target thread: $TargetThreadId"
    exit 0
}

Ensure-Directory -Path $resolvedLogDir
Ensure-Directory -Path $runDir
Set-Content -LiteralPath $promptPath -Value $prompt -Encoding utf8NoBOM

$metadata = [ordered]@{
    target_repo_root = $resolvedTargetRepoRoot
    target_thread_id = $TargetThreadId
    relay_repo_root = $resolvedRelayRepoRoot
    log_dir = $resolvedLogDir
    mode = $Mode
    timeout_sec = $TimeoutSec
    status_poll_attempts = $StatusPollAttempts
    status_poll_interval_sec = $StatusPollIntervalSec
    recover_on_timeout = [bool]$RecoverOnTimeout
    run_dir = $runDir
    prompt_path = $promptPath
    started_at = (Get-Date).ToUniversalTime().ToString('o')
    preview_only = [bool]$PreviewOnly
}

$dispatchResult = Invoke-RelayCli -RelayRoot $resolvedRelayRepoRoot -CommandName 'relay_dispatch_async' -Payload @{
    projectId = $resolvedTargetRepoRoot
    threadId = $TargetThreadId
    message = $prompt
    timeoutSec = $TimeoutSec
} -RunDir $runDir

$summary = [ordered]@{
    mode = $Mode
    target_thread_id = $TargetThreadId
    outcome = ''
    relay_code = ''
    dispatch_id = ''
    recovery_dispatch_id = ''
    reply = ''
    detail = ''
}

if ($dispatchResult.Payload.ok) {
    $dispatchPayload = $dispatchResult.Payload.payload
    $dispatchId = [string](Get-OptionalPropertyValue -InputObject $dispatchPayload -Name 'dispatchId' -Default '')
    $summary.dispatch_id = $dispatchId
    $summary.outcome = 'dispatched_async'

    for ($attempt = 1; $attempt -le $StatusPollAttempts; $attempt += 1) {
        Start-Sleep -Seconds $StatusPollIntervalSec
        $statusResult = Invoke-RelayCli -RelayRoot $resolvedRelayRepoRoot -CommandName 'relay_dispatch_status' -Payload @{
            dispatchId = $dispatchId
        } -RunDir $runDir

        if (-not $statusResult.Payload.ok) {
            continue
        }

        $statusPayload = $statusResult.Payload.payload
        $statusDispatchId = [string](Get-OptionalPropertyValue -InputObject $statusPayload -Name 'dispatchId' -Default $dispatchId)
        $statusDispatchStatus = [string](Get-OptionalPropertyValue -InputObject $statusPayload -Name 'dispatchStatus' -Default 'unknown')
        $statusReply = Get-OptionalPropertyValue -InputObject $statusPayload -Name 'replyText' -Default ''
        $statusErrorCode = [string](Get-OptionalPropertyValue -InputObject $statusPayload -Name 'errorCode' -Default '')
        $statusErrorMessage = [string](Get-OptionalPropertyValue -InputObject $statusPayload -Name 'errorMessage' -Default '')
        $recoverySuggested = [string](Get-OptionalPropertyValue -InputObject $statusPayload -Name 'recoverySuggested' -Default '')

        $summary.dispatch_id = $statusDispatchId
        $detailParts = @("dispatch_status=$statusDispatchStatus")
        if ($statusErrorCode) {
            $detailParts += "error_code=$statusErrorCode"
        }
        if ($recoverySuggested) {
            $detailParts += "recovery=$recoverySuggested"
        }
        $summary.detail = ($detailParts -join '; ')

        if (-not [string]::IsNullOrWhiteSpace([string]$statusReply)) {
            $summary.reply = [string]$statusReply
        }

        if ($statusDispatchStatus -eq 'succeeded') {
            $summary.outcome = 'succeeded_after_status'
            break
        }

        if ($statusDispatchStatus -eq 'failed') {
            $summary.outcome = 'failed'
            $summary.relay_code = if ($statusErrorCode) { $statusErrorCode } else { 'target_turn_failed' }
            if ($statusErrorMessage) {
                $summary.detail = $statusErrorMessage
            }
            break
        }

        if ($statusDispatchStatus -eq 'timed_out') {
            $summary.outcome = 'timeout_pending'
            $summary.relay_code = if ($statusErrorCode) { $statusErrorCode } else { 'turn_timeout' }

            if ($RecoverOnTimeout) {
                $recoverResult = Invoke-RelayCli -RelayRoot $resolvedRelayRepoRoot -CommandName 'relay_dispatch_recover' -Payload @{
                    dispatchId = $dispatchId
                } -RunDir $runDir

                if ($recoverResult.Payload.ok) {
                    $recoverPayload = $recoverResult.Payload.payload
                    $recoverDispatchId = [string](Get-OptionalPropertyValue -InputObject $recoverPayload -Name 'dispatchId' -Default $dispatchId)
                    $recoverAction = [string](Get-OptionalPropertyValue -InputObject $recoverPayload -Name 'recoveryAction' -Default 'unknown')
                    $recoverReply = Get-OptionalPropertyValue -InputObject $recoverPayload -Name 'replyText' -Default ''
                    $recoverDispatchStatus = [string](Get-OptionalPropertyValue -InputObject $recoverPayload -Name 'dispatchStatus' -Default 'unknown')
                    $summary.recovery_dispatch_id = $recoverDispatchId
                    $summary.detail = "recovery_action=$recoverAction"
                    if (-not [string]::IsNullOrWhiteSpace([string]$recoverReply)) {
                        $summary.reply = [string]$recoverReply
                    }
                    if ($recoverDispatchStatus -eq 'succeeded') {
                        $summary.outcome = 'succeeded_after_recover'
                    }
                }
            }
            break
        }
    }

    if ($summary.outcome -eq 'dispatched_async') {
        $summary.outcome = 'running_after_status_poll'
    }
} else {
    $summary.relay_code = [string]$dispatchResult.Payload.relayCode
    $summary.detail = [string]$dispatchResult.Payload.message
    $summary.outcome = 'failed'
}

$metadata.completed_at = (Get-Date).ToUniversalTime().ToString('o')
$metadata.summary = $summary
$metadata | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $metadataPath -Encoding utf8NoBOM
Write-Summary -Path $summaryPath -Summary $summary

if ($summary.outcome -eq 'failed') {
    throw "Relay scheduled test failed. See $summaryPath and $metadataPath."
}

Write-Host "Relay scheduled test completed."
Write-Host "Run directory: $runDir"
Write-Host "Summary file: $summaryPath"
