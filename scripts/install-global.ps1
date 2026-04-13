[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageRoot = Join-Path $repoRoot 'tools/codex-supervisor'

function Invoke-Npm {
    param(
        [Parameter(Mandatory)][string[]]$Arguments
    )

    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm is required to install codex-autonomy globally.'
}

Write-Host 'Building tools/codex-supervisor...'
Invoke-Npm -Arguments @('--prefix', $packageRoot, 'run', 'build')

$globalPrefix = (& npm prefix -g).Trim()
if ([string]::IsNullOrWhiteSpace($globalPrefix)) {
    throw 'Could not determine the global npm prefix.'
}

Write-Host "Installing codex-autonomy into global prefix: $globalPrefix"
Invoke-Npm -Arguments @('install', '-g', '--prefix', $globalPrefix, $packageRoot)

Write-Host "codex-autonomy is ready at the global npm prefix: $globalPrefix"
