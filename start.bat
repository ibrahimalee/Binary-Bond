@echo off
echo Starting BinaryBond...
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Start the server
echo Starting BinaryBond server...
echo.
echo Once started, open http://localhost:3000 in your browser
echo.
echo To create a connection:
echo 1. One person clicks "Create Room" and shares the room code
echo 2. The other person enters the room code and clicks "Join Room"
echo.
echo Press Ctrl+C to stop the server
echo.
npm start