#!/usr/bin/env bash
# Installs two launchd jobs so wireless control survives logouts, reboots and phone restarts:
#   - LaunchDaemon dev.raygen.pmd3-tunneld (root): keeps the iOS 17+ tunnel to the phone up over Wi-Fi/USB
#   - LaunchAgent  dev.raygen.iphone-wda (you): keeps WebDriverAgent running and relaunches it when it dies
# Remove with: ./install-services.sh uninstall
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PMD3="$(command -v pymobiledevice3 || true)"
UV="$(command -v uv)"
DAEMON=/Library/LaunchDaemons/dev.raygen.pmd3-tunneld.plist
AGENT="$HOME/Library/LaunchAgents/dev.raygen.iphone-wda.plist"
LOGS="$HOME/.iphone-wda"

if [ "${1:-}" = uninstall ]; then
  launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
  sudo launchctl bootout system "$DAEMON" 2>/dev/null || true
  rm -f "$AGENT"; sudo rm -f "$DAEMON"
  echo "removed"; exit 0
fi
[ -n "$PMD3" ] || { echo "install pymobiledevice3 first: uv tool install --python 3.13 pymobiledevice3==11.63.1"; exit 1; }
mkdir -p "$LOGS" "$(dirname "$AGENT")"

sudo tee "$DAEMON" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.raygen.pmd3-tunneld</string>
  <key>ProgramArguments</key><array>
    <string>$PMD3</string><string>remote</string><string>tunneld</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/pmd3-tunneld.log</string>
  <key>StandardErrorPath</key><string>/var/log/pmd3-tunneld.log</string>
</dict></plist>
EOF
sudo launchctl bootout system "$DAEMON" 2>/dev/null || true
sudo launchctl bootstrap system "$DAEMON"

cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.raygen.iphone-wda</string>
  <key>ProgramArguments</key><array>
    <string>$UV</string><string>run</string><string>--quiet</string><string>--script</string>
    <string>$HERE/iphone.py</string><string>up</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$PMD3"):$(dirname "$UV"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/up.log</string>
  <key>StandardErrorPath</key><string>$LOGS/up.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
echo "installed; follow with: tail -f $LOGS/up.log"
