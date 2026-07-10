<#
.SYNOPSIS
  一键启动 Router 知识问答服务（Weaviate + PostgreSQL + Express）

.DESCRIPTION
  默认「生产」模式：构建前端 dist 后单端口启动，访问 http://localhost:8002
  开发模式（-Dev）：Vite :5173 热更新 + API :8002，访问 http://localhost:5173

.PARAMETER Dev
  开发模式：npm run dev（前后端双进程，改代码即时生效）

.PARAMETER SkipBuild
  生产模式下跳过 npm run build（仅在你确认 dist 已是最新时使用）

.PARAMETER SkipWeaviate
  跳过 Docker 启动 Weaviate（将使用 MOCK_WEAVIATE 或 .env 中的配置）

.EXAMPLE
  .\start-knowledge-server.ps1

.EXAMPLE
  .\start-knowledge-server.ps1 -Dev
#>

# 用法：
#   .\start-knowledge-server.ps1          # 生产：build + 单端口 8002
#   .\start-knowledge-server.ps1 -Dev     # 开发：5173 热更新 + 8002 API
#   .\start-knowledge-server.ps1 -SkipBuild -SkipWeaviate

[CmdletBinding()]
param(
    [switch]$Dev,           # 开发模式（Vite + 后端 watch）
    [switch]$SkipBuild,     # 生产模式跳过前端构建
    [switch]$SkipWeaviate   # 不启动 Docker Weaviate
)

$ErrorActionPreference = "Stop"

# 路径
$Root = $PSScriptRoot
$RouterDir = Join-Path $Root "Router"
$ComposeFile = Join-Path $RouterDir "docker-compose.weaviate.yml"

# 打印步骤标题
function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

# 调用 npm（Windows 用 npm.cmd；-w 等参数须用数组传入，避免被 PowerShell 误解析）
function Invoke-Npm {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Command
    )
    if ($Command.Count -eq 0) {
        throw "Invoke-Npm: missing npm arguments"
    }
    $npmExe = if ($IsWindows -or $env:OS -eq "Windows_NT") { "npm.cmd" } else { "npm" }
    Write-Host "> $npmExe $($Command -join ' ')" -ForegroundColor DarkGray
    & $npmExe @Command
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Command -join ' ') failed (exit $LASTEXITCODE)"
    }
}

# 检测端口是否有服务在监听（2 秒超时）
function Test-TcpPort([int]$Port) {
    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $connect.AsyncWaitHandle.WaitOne(2000, $false)
        if (-not $ok) { return $false }
        $client.EndConnect($connect)
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) { $client.Close() }
    }
}

# 查找占用端口的进程 PID
function Get-ListenPids([int]$Port) {
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        Where-Object { $_ -gt 0 })
}

# 启动前释放端口（避免 EADDRINUSE）
function Stop-PortListeners([int]$Port, [string]$Label) {
    $pids = Get-ListenPids $Port
    if (-not $pids.Count) { return }
    Write-Warning "Port $Port in use ($Label) — stopping PID: $($pids -join ', ')"
    foreach ($procId in $pids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
        }
        catch {
            throw "Cannot free port $Port (PID $procId). Close the process manually and retry."
        }
    }
    Start-Sleep -Milliseconds 400
}

# 从 Router/.env 读取 PORT，默认 8002
function Get-ServerPort {
    $envFile = Join-Path $RouterDir ".env"
    if (-not (Test-Path $envFile)) { return 8002 }
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)') { return [int]$Matches[1] }
    }
    return 8002
}

# ── 主流程 ──────────────────────────────────────────────

if (-not (Test-Path $RouterDir)) {
    throw "Router directory not found: $RouterDir"
}

Set-Location $RouterDir

Write-Host ""
Write-Host "Router Knowledge Server" -ForegroundColor White
Write-Host ("Mode: " + ($(if ($Dev) { "Dev (Vite + API)" } else { "Prod (build + single port)" }))) -ForegroundColor DarkGray

# 1. 环境：.env、依赖
Write-Step "Preparing environment"
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Warning "Created .env from .env.example — review DATABASE_URL and restart if needed"
    }
    else {
        Write-Warning "No .env file — copy Router/.env.example to Router/.env"
    }
}

if (-not (Test-Path "node_modules")) {
    Write-Host "First run: npm install..." -ForegroundColor Yellow
    Invoke-Npm -Command @("install")
}

# 2. 检查 PostgreSQL（Router 必填）
Write-Step "Checking PostgreSQL (127.0.0.1:5432)"
if (-not (Test-TcpPort 5432)) {
    Write-Warning "PostgreSQL not reachable at 127.0.0.1:5432 — server may fail to start"
    Write-Warning "Create DB first: npm run db:setup -w server"
}
else {
    Write-Host "PostgreSQL: OK" -ForegroundColor Green
}

# 3. 启动 Weaviate（RAG 向量库，失败则降级 mock）
if (-not $SkipWeaviate) {
    Write-Step "Starting Weaviate (Docker)"
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        try {
            docker info 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Docker daemon not ready" }
            if (-not (Test-Path $ComposeFile)) { throw "Missing compose file: $ComposeFile" }
            Push-Location $RouterDir
            try {
                docker compose -f docker-compose.weaviate.yml up -d
                if ($LASTEXITCODE -ne 0) { throw "docker compose failed" }
            }
            finally {
                Pop-Location
            }
            Write-Host "Weaviate: http://localhost:8080" -ForegroundColor Green
        }
        catch {
            Write-Warning "Weaviate skipped: $_"
            Write-Warning "RAG will use in-memory mock vectors unless WEAVIATE_URL is set in Router/.env"
        }
    }
    else {
        Write-Warning "Docker not found, skipping Weaviate"
    }
}

# 4. 启动应用
if ($Dev) {
    # 开发：concurrently 同时跑 server + Vite
    Write-Step "Starting dev stack (API :8002 + Vite :5173)"
    Stop-PortListeners -Port 8002 -Label "Router API"
    Stop-PortListeners -Port 5173 -Label "Vite dev"
    Write-Host ""
    Write-Host "  UI   http://localhost:5173  (recommended)" -ForegroundColor Yellow
    Write-Host "  API  http://localhost:8002" -ForegroundColor Yellow
    Write-Host "  Ctrl+C to stop both processes" -ForegroundColor DarkGray
    Write-Host ""
    Invoke-Npm -Command @("run", "dev")
}
else {
    # 生产：先 build 前端，再由 Express 托管 dist + API
    if (-not $SkipBuild) {
        Write-Step "Building client (fresh dist)"
        Invoke-Npm -Command @("run", "build", "-w", "client")
    }
    else {
        Write-Warning "SkipBuild: using existing client/dist"
    }

    $serverPort = Get-ServerPort
    Write-Step "Starting production server (:$serverPort)"
    Stop-PortListeners -Port $serverPort -Label "Router server"

    Write-Host ""
    Write-Host "  App  http://localhost:$serverPort" -ForegroundColor Yellow
    Write-Host "  Ctrl+C to stop" -ForegroundColor DarkGray
    Write-Host ""
    Invoke-Npm -Command @("run", "start", "-w", "server")
}
