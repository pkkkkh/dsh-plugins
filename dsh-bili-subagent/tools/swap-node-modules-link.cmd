@echo off
rem =====================================================================
rem Start-half for the restart that turns dsh-bili-subagent into a
rem junction into our repo copy (2026-11-11).
rem
rem Runs in its OWN scheduled task while DSH is DOWN (the kill half already
rem fired). Renaming a loaded package under a live DSH triggers HMR churn and
rem wipes the tool-prefix cache, so the swap must happen here, not while it runs.
rem
rem Steps: swap node_modules\dsh-bili-subagent -> junction to repo copy,
rem        then start DSH (same explorer launch + retry as maint-start).
rem ASCII only.
rem =====================================================================
setlocal
set LOG=C:\Users\kh006\.dsh\im\logs\bili-subagent-swap.log
set PROFILE=D:\dsh-home\profiles\desktop
set TARGET=C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-bili-subagent
set SWAPPED=%PROFILE%\node_modules\dsh-bili-subagent.upstream-0.9.8

echo [%date% %time%] swap-start fired >> "%LOG%"

tasklist /fi "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [%date% %time%] SKIP swap: DSH still running >> "%LOG%"
  goto :end
)

if not exist "%TARGET%\package.json" (
  echo [%date% %time%] FATAL: repo copy missing at %TARGET% >> "%LOG%"
  goto :ensure_up
)

rem already a junction? verify by checking for the real dir flag via dir output
dir /al "%PROFILE%\node_modules" 2>nul | find /i "dsh-bili-subagent" >nul
if not errorlevel 1 (
  echo [%date% %time%] already a junction, nothing to swap >> "%LOG%"
  goto :ensure_up
)

if exist "%SWAPPED%" (
  echo [%date% %time%] backup already exists, removing current dir >> "%LOG%"
  rmdir /s /q "%PROFILE%\node_modules\dsh-bili-subagent" >> "%LOG%" 2>&1
) else (
  echo [%date% %time%] renaming upstream copy to backup >> "%LOG%"
  move /y "%PROFILE%\node_modules\dsh-bili-subagent" "%SWAPPED%" >> "%LOG%" 2>&1
)
echo [%date% %time%] move rc=%errorlevel% >> "%LOG%"

mklink /J "%PROFILE%\node_modules\dsh-bili-subagent" "%TARGET%" >> "%LOG%" 2>&1
echo [%date% %time%] mklink rc=%errorlevel% >> "%LOG%"

dir /al "%PROFILE%\node_modules" 2>nul | find /i "dsh-bili-subagent" >> "%LOG%" 2>&1

:ensure_up
tasklist /fi "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [%date% %time%] DSH already up, nothing to start >> "%LOG%"
  goto :end
)
echo [%date% %time%] starting DSH >> "%LOG%"
if exist "C:\Users\kh006\.dsh\im\logs\announce-text.txt" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\kh006\.dsh\im\scripts\write-announce-marker.ps1" -TextFile "C:\Users\kh006\.dsh\im\logs\announce-text.txt" -OutFile "C:\Users\kh006\.dsh\im\logs\restart-announce.json" >> "%LOG%" 2>&1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\kh006\.dsh\im\scripts\restart-dsh-start.ps1" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [%date% %time%] start failed, retrying once >> "%LOG%"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\kh006\.dsh\im\scripts\restart-dsh-start.ps1" >> "%LOG%" 2>&1
  echo [%date% %time%] retry rc=%errorlevel% >> "%LOG%"
)

:end
echo [%date% %time%] swap-start done >> "%LOG%"
endlocal
