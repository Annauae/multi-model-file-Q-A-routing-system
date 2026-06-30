# Copy knowledge_router data into Router for independent deployment.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path (Split-Path -Parent $root) "knowledge_router"

if (-not (Test-Path $src)) {
    Write-Error "Source not found: $src"
}

foreach ($dir in @("config", "files")) {
    $from = Join-Path $src $dir
    $to = Join-Path $root $dir
    if (-not (Test-Path $from)) {
        Write-Warning "Skip missing: $from"
        continue
    }
    if (Test-Path $to) {
        Write-Host "Already exists, skip: $to"
    } else {
        Copy-Item -Recurse $from $to
        Write-Host "Copied $from -> $to"
    }
}

$logsDir = Join-Path $root "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
    Write-Host "Created $logsDir"
}

Write-Host "Done. Copy .env.example to .env and set PORT=8002 if needed."
