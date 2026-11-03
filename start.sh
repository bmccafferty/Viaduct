#!/usr/bin/env bash
# Portable launcher for macOS, Windows WSL, and Linux
cd "$(dirname "$0")"
PORT="${VIADUCT_PORT:-8420}"
URL="http://127.0.0.1:${PORT}"

echo "Starting VIADUCT on ${URL} ..."

(
  sleep 1
  if command -v open >/dev/null 2>&1; then
    open "${URL}" 2>/dev/null || true
  elif command -v wslview >/dev/null 2>&1; then
    wslview "${URL}" 2>/dev/null || true
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '${URL}'" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${URL}" 2>/dev/null || true
  fi
) &

exec python3 server.py
