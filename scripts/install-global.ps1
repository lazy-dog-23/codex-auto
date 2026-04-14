[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageRoot = Join-Path $repoRoot 'tools/codex-supervisor'
$routerSkillInstaller = Join-Path $repoRoot 'scripts/install-router-skill.ps1'

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
Invoke-Npm -Arguments @('install', '-g', '--force', '--prefix', $globalPrefix, $packageRoot)

if (Test-Path -LiteralPath $routerSkillInstaller) {
    Write-Host 'Installing global codex-autonomy skills...'
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $routerSkillInstaller
    if ($LASTEXITCODE -ne 0) {
        throw "Global skill install failed with exit code $LASTEXITCODE."
    }
}

Write-Host "codex-autonomy is ready at the global npm prefix: $globalPrefix"
