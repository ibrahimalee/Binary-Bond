@echo off
echo Starting BinaryBond...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js 20+ is required: https://nodejs.org/
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install --omit=dev
)
echo.
echo Open http://localhost:3000 in your browser. Press Ctrl+C to stop.
echo.
npm start
