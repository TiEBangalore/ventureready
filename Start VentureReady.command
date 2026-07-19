#!/bin/bash
# Double-click this file to start the VentureReady demo app.
cd "$(dirname "$0")"
echo "Starting VentureReady…"
echo "When you see the 'running' message below, open your browser to:  http://localhost:8000"
echo "Leave this window open during your demo. Close it (or press Ctrl+C) to stop."
echo ""
# First run only: install the Node dependencies if they're not there yet.
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies (this can take a minute)…"
  npm install
fi
# open the browser automatically after a moment
( sleep 2 && open "http://localhost:8000" ) &
node server.js
