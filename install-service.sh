#!/usr/bin/env bash
# VIADUCT — Cross-Platform Background Service Installer (macOS + Windows WSL / Linux)
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${VIADUCT_PORT:-8420}"
PYTHON_BIN="$(command -v python3)"
LOG_DIR="$APP_DIR/.viaduct"
mkdir -p "$LOG_DIR"

OS_TYPE="$(uname -s)"
IS_WSL=0
if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
  IS_WSL=1
fi

echo "========================================================"
echo " VIADUCT // Auto-Start Background Service Installer"
echo "========================================================"
echo "App Directory : $APP_DIR"
echo "Python Binary : $PYTHON_BIN"
echo "Port          : $PORT"

if [ "$OS_TYPE" = "Darwin" ]; then
  echo "Platform      : macOS (LaunchAgent)"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/scot.bdm.viaduct.plist"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>scot.bdm.viaduct</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_BIN</string>
    <string>$APP_DIR/server.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VIADUCT_PORT</key>
    <string>$PORT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/viaduct.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/viaduct.err.log</string>
</dict>
</plist>
EOF

  # Reload LaunchAgent if already loaded
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH" 2>/dev/null || true

  echo ""
  echo "✅ macOS LaunchAgent installed at:"
  echo "   $PLIST_PATH"
  echo "   Viaduct will now start automatically whenever you log into your Mac!"
  echo "   Open: http://127.0.0.1:$PORT"

else
  if [ "$IS_WSL" -eq 1 ]; then
    echo "Platform      : Windows WSL (Linux)"
  else
    echo "Platform      : Linux"
  fi

  # 1. If systemd user manager is active (WSL2 with systemd=true or standard Linux)
  if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    SERVICE_DIR="$HOME/.config/systemd/user"
    SERVICE_PATH="$SERVICE_DIR/viaduct.service"
    mkdir -p "$SERVICE_DIR"

    cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=Viaduct Local Markdown Knowledge Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=VIADUCT_PORT=$PORT
ExecStart=$PYTHON_BIN $APP_DIR/server.py
Restart=always
RestartSec=2
StandardOutput=append:$LOG_DIR/viaduct.log
StandardError=append:$LOG_DIR/viaduct.err.log

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable --now viaduct.service
    echo "✅ Installed & started systemd user service: $SERVICE_PATH"
  fi

  # 2. Also add lightweight auto-start hook for WSL shell login (works even without systemd)
  HOOK_MARKER="# >>> viaduct-autostart >>>"
  HOOK_END="# <<< viaduct-autostart <<<"
  HOOK_BLOCK="$HOOK_MARKER
if ! pgrep -f \"$APP_DIR/server.py\" >/dev/null 2>&1; then
  (cd \"$APP_DIR\" && nohup \"$PYTHON_BIN\" \"$APP_DIR/server.py\" >> \"$LOG_DIR/viaduct.log\" 2>&1 &)
fi
$HOOK_END"

  for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC_FILE" ]; then
      if ! grep -q "$HOOK_MARKER" "$RC_FILE"; then
        printf "\n%s\n" "$HOOK_BLOCK" >> "$RC_FILE"
        echo "✅ Added WSL auto-start hook to $RC_FILE"
      fi
    fi
  done

  # Ensure it is running right now
  if ! pgrep -f "$APP_DIR/server.py" >/dev/null 2>&1; then
    (cd "$APP_DIR" && nohup "$PYTHON_BIN" "$APP_DIR/server.py" >> "$LOG_DIR/viaduct.log" 2>&1 &)
  fi

  echo ""
  echo "✅ Viaduct background service is active on http://127.0.0.1:$PORT"
  echo "   (Accessible from your Windows browser at http://localhost:$PORT)"
fi
