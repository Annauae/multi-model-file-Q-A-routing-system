@echo off
cd /d "%~dp0model_router"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
