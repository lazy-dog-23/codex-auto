[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$templateRoot = Join-Path $repoRoot 'tools\skill-templates'

$codexHome = if ($env:CODEX_HOME) {
    $env:CODEX_HOME
} elseif ($env:USERPROFILE) {
    Join-Path $env:USERPROFILE '.codex'
} else {
    Join-Path $HOME '.codex'
}

$skillsRoot = Join-Path $codexHome 'skills\personal'
$installGlobalScript = Join-Path $repoRoot 'scripts\install-global.ps1'
$templateDirectories = Get-ChildItem -LiteralPath $templateRoot -Directory | Sort-Object Name

if ($templateDirectories.Count -eq 0) {
    throw "No skill templates found under $templateRoot"
}

function Assert-WithinPersonalSkillsRoot {
    param(
        [Parameter(Mandatory)][string]$TargetRoot
    )

    $resolvedSkillsRoot = [System.IO.Path]::GetFullPath($skillsRoot)
    $resolvedTargetRoot = if (Test-Path -LiteralPath $TargetRoot) {
        (Resolve-Path -LiteralPath $TargetRoot).Path
    } else {
        [System.IO.Path]::GetFullPath($TargetRoot)
    }

    if (-not $resolvedTargetRoot.StartsWith($resolvedSkillsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace skill outside CODEX_HOME personal skills root: $resolvedTargetRoot"
    }
}

New-Item -ItemType Directory -Path $skillsRoot -Force | Out-Null

$installedSkills = @()
foreach ($templateDirectory in $templateDirectories) {
    $templateFile = Join-Path $templateDirectory.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $templateFile)) {
        throw "Skill template not found: $templateFile"
    }

    $targetRoot = Join-Path $skillsRoot $templateDirectory.Name
    $targetFile = Join-Path $targetRoot 'SKILL.md'
    Assert-WithinPersonalSkillsRoot -TargetRoot $targetRoot

    if (Test-Path -LiteralPath $targetRoot) {
        Remove-Item -LiteralPath $targetRoot -Recurse -Force
    }

    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

    $template = Get-Content -LiteralPath $templateFile -Raw
    $rendered = $template.Replace('{{SOURCE_REPO}}', ($repoRoot -replace '\\', '/'))
    $rendered = $rendered.Replace('{{INSTALL_GLOBAL_SCRIPT}}', ($installGlobalScript -replace '\\', '/'))

    Set-Content -LiteralPath $targetFile -Value $rendered -Encoding UTF8NoBOM
    $installedSkills += $templateDirectory.Name
}

Write-Host "Installed global Codex skills: $($installedSkills -join ', ')"
