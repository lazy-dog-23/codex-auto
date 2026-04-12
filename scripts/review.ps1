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

Assert-Exists (Join-Path $repoRoot 'scripts/smoke.ps1')

& (Join-Path $repoRoot 'scripts/smoke.ps1')
if (-not $?) {
    $exitCodeVar = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
    $exitCode = if ($null -eq $exitCodeVar) { 1 } else { [int]$exitCodeVar.Value }
    throw "smoke.ps1 failed with exit code $exitCode."
}

Write-Host 'Review precheck passed.'
