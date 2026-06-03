@echo off
echo =========================================
echo  ReBit RVM Agent - Startup
echo =========================================

cd C:\Users\YY\RebitMqtt

echo [1/3] Restoring WinKeyServer.exe...
copy /Y "C:\Users\YY\WinKeyServer64.exe" "node_modules\node-global-key-listener\bin\WinKeyServer.exe" >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Could not copy WinKeyServer64.exe
    echo Make sure C:\Users\YY\WinKeyServer64.exe exists
    pause
    exit /b 1
)
echo WinKeyServer.exe restored OK

echo [2/3] Unblocking WinKeyServer.exe...
powershell -Command "Unblock-File 'C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\bin\WinKeyServer.exe'" >nul 2>&1
echo Unblock done

echo [3/3] Starting RVM Agent...
echo =========================================
node agent1.js