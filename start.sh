#!/usr/bin/env sh
set -e
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required: https://nodejs.org/"; exit 1; }
[ -d node_modules ] || npm install --omit=dev
echo "Open http://localhost:3000 in your browser. Press Ctrl+C to stop."
exec npm start
