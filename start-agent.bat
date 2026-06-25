@echo off
REM ============================================================
REM  RVM Agent launcher  (run as Administrator)
REM  - locks English (US) input so a Japanese IME can't swallow
REM    scanner keystrokes (manufacturer point 4)
REM  - sweeps orphan WinKeyServer.exe from a previous run
REM  - restores the node-global-key-listener BAT if Defender ate it
REM  - then starts the agent
REM ============================================================

echo ============================================================
echo  RVM AGENT STARTUP
echo ============================================================

REM --- 1. Lock keyboard input to English (US) for this session ---
echo [1/4] Locking input method to English (US)...
powershell -NoProfile -Command "Set-WinUserLanguageList -LanguageList en-US -Force" 2>nul
echo       done.

REM --- 2. Sweep any orphan WinKeyServer.exe left from a crash ---
echo [2/4] Sweeping orphan WinKeyServer.exe ...
taskkill /F /IM WinKeyServer.exe /T >nul 2>&1
echo       done.

REM --- 3. (Optional) restore node-global-key-listener server if quarantined ---
REM  Adjust the path below to YOUR project if you keep a restore step.
REM  Leave commented out if you already handle this elsewhere.
REM echo [3/4] Restoring key listener server...
REM copy /Y "C:\Users\YY\RebitMqtt\backup\WinKeyServer.exe" "C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\bin\WinKeyServer.exe" >nul 2>&1
echo [3/4] (key-server restore step skipped)

REM --- 4. Start the agent ---
echo [4/4] Starting agent...
echo ============================================================
cd /d "C:\Users\YY\RebitMqtt"
node agent-production.js

REM keep window open if node exits so you can read the error
echo.
echo Agent process exited. Press any key to close.
pause >nul