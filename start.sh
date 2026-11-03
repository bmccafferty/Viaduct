#!/bin/zsh
cd "$(dirname "$0")"
echo "Starting VIADUCT on http://127.0.0.1:8420 ..."
(sleep 1 && open "http://127.0.0.1:8420" 2>/dev/null || true) &
exec python3 server.py
