@echo off
echo Starting Project Nexus...

REM Start the Compose stack in detached mode
docker compose up -d

REM Give containers a few seconds to initialize
timeout /t 4 /nobreak >nul

REM Open the frontend in the default browser
start "" "http://localhost"

exit /b 0
