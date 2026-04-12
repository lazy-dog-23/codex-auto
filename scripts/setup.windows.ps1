[CmdletBinding()]
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

Ensure-Directory -Path (Join-Path $repoRoot 'autonomy/locks')
Ensure-Directory -Path (Join-Path $repoRoot '.codex/environments')

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
