#!/usr/bin/env bash
# Signs WebDriverAgentRunner.ipa with your Apple Account (the one Impactor.app is signed into)
# and installs it on the iPhone. Re-run every 7 days with a free account. No Xcode needed.
#
#   ./install-wda.sh [path/to/WebDriverAgentRunner.ipa]
#
# Plug the iPhone in by USB first.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IPA="${1:-$HERE/../dist/WebDriverAgentRunner.ipa}"
PLUMESIGN="${PLUMESIGN:-$HERE/../dist/plumesign}"
UDID="${IPHONE_UDID:-00008110-000870C036EB801E}"
# App IDs on free accounts must be globally unique; keep the .xctrunner suffix XCTest runners use.
BUNDLE_ID="${WDA_BUNDLE_ID:-dev.raygen.WebDriverAgentRunner.xctrunner}"

xattr -d com.apple.quarantine "$PLUMESIGN" 2>/dev/null || true
# plumesign shares ~/.config/PlumeImpactor with Impactor.app, so it reuses that login and certificate.
if ! "$PLUMESIGN" account list 2>&1 | grep -q "(selected)"; then
  read -rp "Not signed in to Impactor. Apple Account email: " EMAIL
  "$PLUMESIGN" account login -u "$EMAIL"   # prompts for the password and 2FA code
fi

# plumesign's --udid takes usbmuxd's numeric device ID, not the UDID; look up the USB connection's ID
# with pymobiledevice3's own Python.
PMD3_PY="$(dirname "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v pymobiledevice3)")")/python"
DEVID="$("$PMD3_PY" - "$UDID" <<'EOF'
import asyncio, sys
from pymobiledevice3 import usbmux
devs = [d for d in asyncio.run(usbmux.list_devices()) if d.matches_udid(sys.argv[1])]
devs.sort(key=lambda d: not d.is_usb)  # prefer USB over Wi-Fi
print(devs[0].devid if devs else "")
EOF
)"
[ -n "$DEVID" ] || { echo "iPhone $UDID not found by usbmuxd; plug it in and unlock it"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$IPA" "$TMP/WebDriverAgentRunner.ipa"  # signing rewrites the package; keep the original unsigned
"$PLUMESIGN" sign --apple-id --register-and-install --udid "$DEVID" \
  --custom-identifier "$BUNDLE_ID" -p "$TMP/WebDriverAgentRunner.ipa"

echo "Installed $BUNDLE_ID. First install only: on the iPhone open Settings > General > VPN & Device"
echo "Management, tap your Apple Account under Developer App, and tap Trust."
