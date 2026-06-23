Set-Location $PSScriptRoot\knowledge_router
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
