@echo off
echo =========================================
echo  WinKeyServer Diagnostics
echo =========================================

echo.
echo [1] File in bin folder:
dir "C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\bin\"

echo.
echo [2] File size check:
powershell -Command "Get-Item 'C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\bin\WinKeyServer.exe' | Select-Object Name, Length"

echo.
echo [3] MZ header check (must say True):
powershell -Command "$b=[System.IO.File]::ReadAllBytes('C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\bin\WinKeyServer.exe'); Write-Host ('MZ header valid: ' + ($b[0] -eq 77 -and $b[1] -eq 90))"

echo.
echo [4] Source file check:
powershell -Command "Get-Item 'C:\Users\YY\WinKeyServer64.exe' | Select-Object Name, Length"

echo.
echo [5] Source file MZ header:
powershell -Command "$b=[System.IO.File]::ReadAllBytes('C:\Users\YY\WinKeyServer64.exe'); Write-Host ('MZ header valid: ' + ($b[0] -eq 77 -and $b[1] -eq 90))"

echo.
echo [6] What path does the package actually use:
type "C:\Users\YY\RebitMqtt\node_modules\node-global-key-listener\build\ts\WinKeyServer.js"

echo.
pause