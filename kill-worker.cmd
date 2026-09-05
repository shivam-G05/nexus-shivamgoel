@echo off
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*worker.js*' } | ForEach-Object { Write-Host ('Killing worker PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
