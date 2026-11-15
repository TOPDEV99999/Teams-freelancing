@echo off
rem Start the Workana Assistant hub (dashboard at http://localhost:8766 unless HUB_PORT is changed in .env)
cd /d "%~dp0"
if not exist .venv (
  py -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python -m hub %*
