#!/bin/bash

echo "Starting BinaryBond..."
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo
fi

# Start the server
echo "Starting BinaryBond server..."
echo
echo "Once started, open http://localhost:3000 in your browser"
echo
echo "To create a connection:"
echo "1. One person clicks 'Create Room' and shares the room code"
echo "2. The other person enters the room code and clicks 'Join Room'"
echo
echo "Press Ctrl+C to stop the server"
echo

npm start