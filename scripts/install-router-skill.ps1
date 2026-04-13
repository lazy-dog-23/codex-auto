[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$templateRoot = Join-Path $repoRoot 'tools\skill-templates\codex-autonomy-router'
$templateFile = Join-Path $templateRoot 'SKILL.md'

if (-not (Test-Path -LiteralPath $templateFile)) {
    throw "Router skill template not found: $templateFile"
}

$codexHome = if ($env:CODEX_HOME) {
    $env:CODEX_HOME
} elseif ($env:USERPROFILE) {
    Join-Path $env:USERPROFILE '.codex'
} else {
    Join-Path $HOME '.codex'
}

$targetRoot = Join-Path $codexHome 'skills\personal\codex-autonomy-router'
$targetFile = Join-Path $targetRoot 'SKILL.md'
$installGlobalScript = Join-Path $repoRoot 'scripts\install-global.ps1'

if (Test-Path -LiteralPath $targetRoot) {
    $resolvedTargetRoot = (Resolve-Path -LiteralPath $targetRoot).Path
    $resolvedSkillsRoot = [System.IO.Path]::GetFullPath((Join-Path $codexHome 'skills\personal'))
    if (-not $resolvedTargetRoot.StartsWith($resolvedSkillsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace skill outside CODEX_HOME personal skills root: $resolvedTargetRoot"
    }

    Remove-Item -LiteralPath $targetRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

$template = Get-Content -LiteralPath $templateFile -Raw
$rendered = $template.Replace('{{SOURCE_REPO}}', ($repoRoot -replace '\\', '/'))
$rendered = $rendered.Replace('{{INSTALL_GLOBAL_SCRIPT}}', ($installGlobalScript -replace '\\', '/'))

Set-Content -LiteralPath $targetFile -Value $rendered -Encoding UTF8NoBOM

Write-Host "Installed global Codex skill: $targetRoot"
