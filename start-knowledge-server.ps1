# Start Router (Weaviate + Express :8002 + Vite :5173)
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$RouterDir = Join-Path $Root "Router"
$ComposeFile = Join-Path $RouterDir "docker-compose.weaviate.yml"

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

Write-Step "Starting Weaviate (Docker)"
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Docker not ready" }
        if (-not (Test-Path $ComposeFile)) { throw "Missing compose file: $ComposeFile" }
        Push-Location $RouterDir
        docker compose -f docker-compose.weaviate.yml up -d
        if ($LASTEXITCODE -ne 0) { throw "docker compose failed" }
        Pop-Location
        Write-Host "Weaviate: http://localhost:8080" -ForegroundColor Green
    }
    catch {
        Write-Warning "Weaviate skipped: $_"
    }
}
else {
    Write-Warning "Docker not found, skipping Weaviate"
}

Write-Step "Checking PostgreSQL"
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -WarningAction SilentlyContinue -InformationLevel Quiet)) {
    Write-Warning "PostgreSQL not reachable at 127.0.0.1:5432"
}

Write-Step "Starting Router dev server"
if (-not (Test-Path $RouterDir)) {
    Write-Error "Router directory not found: $RouterDir"
}
Set-Location $RouterDir

if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Warning "Created .env from .env.example - review and restart if needed"
    }
    else {
        Write-Warning "No .env file - see Router/.env.example"
    }
}

if (-not (Test-Path "node_modules")) {
    Write-Host "First run: npm install..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "  UI   http://localhost:5173" -ForegroundColor Yellow
Write-Host "  API  http://localhost:8002" -ForegroundColor Yellow
Write-Host "  Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

npm run dev
