@echo off
setlocal
cd /d "%~dp0"
title Workana Assistant - apply update

if not exist "update\WorkanaAssistant.exe" (
  echo No update found: the "update" folder is missing or empty.
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq WorkanaAssistant.exe" 2>nul | find /I "WorkanaAssistant.exe" >nul
if not errorlevel 1 (
  echo WorkanaAssistant is still running.
  echo Close its black window first ^(that stops the app^), then run this file again.
  pause
  exit /b 1
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set STAMP=%%i
if "%STAMP%"=="" set STAMP=backup

echo [1/3] Backing up your data and the current version to backups\%STAMP% ...
if not exist "backups\%STAMP%" mkdir "backups\%STAMP%"
xcopy /E /I /Y /Q "WorkanaAssistant\data" "backups\%STAMP%\data" >nul || goto fail
copy /Y "WorkanaAssistant\WorkanaAssistant.exe" "backups\%STAMP%\WorkanaAssistant.exe" >nul || goto fail

echo [2/3] Installing the new WorkanaAssistant.exe ...
copy /Y "update\WorkanaAssistant.exe" "WorkanaAssistant\WorkanaAssistant.exe" >nul || goto fail

echo [3/3] Updating the extension files ...
xcopy /E /I /Y /Q "update\extensions\ext-chatgpt" "extensions\ext-chatgpt" >nul || goto fail
xcopy /E /I /Y /Q "update\extensions\ext-workana" "extensions\ext-workana" >nul || goto fail

rmdir /S /Q "update"
echo.
echo Update installed. Now:
echo   1. Start WorkanaAssistant\WorkanaAssistant.exe
echo   2. In EVERY browser profile: chrome://extensions  -^>  click the reload arrow on the Workana Assistant extension(s)
echo      (if a profile loads the extension from another folder, copy the files from "extensions" there first)
echo   3. Reload the dashboard tab with Ctrl+F5
echo.
echo Your previous version and data are kept in backups\%STAMP%
pause
exit /b 0

:fail
echo.
echo Something went wrong - nothing important was deleted. Your backup is in backups\%STAMP%
pause
exit /b 1
