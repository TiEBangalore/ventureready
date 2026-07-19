#!/bin/bash
# Double-click this file to start the VentureReady demo app.
cd "$(dirname "$0")"
echo "Starting VentureReady…"
echo "When you see the 'running' message below, open your browser to:  http://localhost:8000"
echo "Leave this window open during your demo. Close it (or press Ctrl+C) to stop."
echo ""
# open the browser automatically after a moment
( sleep 2 && open "http://localhost:8000" ) &
python3 server.py
