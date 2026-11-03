#!/usr/bin/env bash
# VIADUCT — Cross-Platform Background Service Uninstaller
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
OS_TYPE="$(uname -s)"

if [ "$OS_TYPE" = "Darwin" ]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/scot.bdm.viaduct.plist"
  if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✅ Removed macOS LaunchAgent: $PLIST_PATH"
  else
    echo "No macOS LaunchAgent found."
  fi
else
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now viaduct.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/viaduct.service"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC_FILE" ]; then
      sed -i '/# >>> viaduct-autostart >>>/,/# <<< viaduct-autostart <<</d' "$RC_FILE" 2>/dev/null || true
    fi
  done
  pkill -f "$APP_DIR/server.py" 2>/dev/null || true
  echo "✅ Removed WSL/Linux background service hooks."
fi
