[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$VaultPath
)

$ErrorActionPreference = 'Stop'
$pluginId = 'obsidian-deepharness-bridge'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vaultRoot = [System.IO.Path]::GetFullPath($VaultPath)
$configRoot = Join-Path $vaultRoot '.obsidian'
$pluginsRoot = Join-Path $configRoot 'plugins'
$targetRoot = Join-Path $pluginsRoot $pluginId
$backupRoot = Join-Path $configRoot 'plugin-backups'

if (-not (Test-Path -LiteralPath $configRoot -PathType Container)) {
  throw "Obsidian configuration directory was not found: $configRoot"
}

foreach ($name in @('main.js', 'manifest.json', 'styles.css', 'versions.json')) {
  $artifact = Join-Path $sourceRoot $name
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Build artifact was not found: $artifact"
  }
}

if (-not (Test-Path -LiteralPath $pluginsRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $pluginsRoot | Out-Null
}
if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $backupRoot | Out-Null
}

if (Test-Path -LiteralPath $targetRoot -PathType Container) {
  $installedVersion = 'unknown'
  $installedManifest = Join-Path $targetRoot 'manifest.json'
  if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
    $installedVersion = (Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json).version
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $backupRoot "$pluginId-$installedVersion-$stamp"
  Copy-Item -LiteralPath $targetRoot -Destination $backup -Recurse
} else {
  New-Item -ItemType Directory -Path $targetRoot | Out-Null
}

foreach ($name in @('main.js', 'manifest.json', 'styles.css', 'versions.json')) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $targetRoot $name) -Force
}

$installed = Get-Content -LiteralPath (Join-Path $targetRoot 'manifest.json') -Raw | ConvertFrom-Json
Write-Output "Installed $($installed.id) $($installed.version) to $targetRoot"
Write-Output "Backups are stored outside the plugin scan directory: $backupRoot"
