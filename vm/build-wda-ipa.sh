#!/usr/bin/env bash
# Builds an unsigned WebDriverAgentRunner.ipa for real iPhones (arm64) and, optionally,
# a simulator build for local testing. Run on a Mac that has Xcode (the build VM), not the host Mac.
#
#   ./build-wda-ipa.sh            # device IPA -> dist/WebDriverAgentRunner.ipa
#   SIM=1 ./build-wda-ipa.sh      # also build for the iOS Simulator (dist/WebDriverAgentRunner-sim.zip)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

WDA_REF="${WDA_REF:-v16.15.3}"                   # appium/WebDriverAgent release tag
XCODE="${XCODE:-/Applications/Xcode_16.4.app}"   # Xcode 16.4 = iOS 18.5 SDK, the closest match to iOS 18.3.1
WORK="${WORK:-$PWD/wda-build}"
OUT="${OUT:-$PWD/dist}"
export DEVELOPER_DIR="$XCODE/Contents/Developer"

mkdir -p "$WORK" "$OUT"
OUT="$(cd "$OUT" && pwd)"
if [ ! -d "$WORK/src" ]; then
  git clone --quiet --depth 1 --branch "$WDA_REF" https://github.com/appium/WebDriverAgent.git "$WORK/src"
fi
cd "$WORK/src"
# Our WDA change: POST /wda/touch, a touch sent straight to testmanagerd (see the patch).
git checkout -q -- . && git apply "$HERE/wda-raw-touch.patch"
echo "WDA $(git rev-parse HEAD) ($WDA_REF) + wda-raw-touch.patch, $(xcodebuild -version | tr '\n' ' ')"

# Same flags as appium's own real-device CI build (Scripts/ci/build-real.sh): unsigned, arm64 only.
xcodebuild clean build-for-testing \
  -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination generic/platform=iOS \
  -derivedDataPath "$WORK/dd-device" \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 \
  > "$WORK/build-device.log" 2>&1 || { tail -40 "$WORK/build-device.log"; exit 1; }

APP="$WORK/dd-device/Build/Products/Debug-iphoneos/WebDriverAgentRunner-Runner.app"
STAGE="$(mktemp -d)"
mkdir "$STAGE/Payload"
ditto "$APP" "$STAGE/Payload/WebDriverAgentRunner-Runner.app"
# Drop the XCTest libraries Xcode copies into the runner's top-level Frameworks/ (as appium's CI does):
# on iOS 17+ the device loads them from the mounted Developer Disk Image, so they always match iOS.
# WebDriverAgentLib.framework lives in PlugIns/WebDriverAgentRunner.xctest/Frameworks and is kept.
rm -rf "$STAGE/Payload/WebDriverAgentRunner-Runner.app/Frameworks"
rm -f "$OUT/WebDriverAgentRunner.ipa"
(cd "$STAGE" && zip -qry "$OUT/WebDriverAgentRunner.ipa" Payload)
rm -rf "$STAGE"
echo "device IPA: $OUT/WebDriverAgentRunner.ipa"

if [ "${SIM:-0}" = 1 ]; then
  xcodebuild build-for-testing \
    -project WebDriverAgent.xcodeproj \
    -scheme WebDriverAgentRunner \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$WORK/dd-sim" \
    CODE_SIGNING_ALLOWED=NO \
    > "$WORK/build-sim.log" 2>&1 || { tail -40 "$WORK/build-sim.log"; exit 1; }
  (cd "$WORK/dd-sim/Build/Products" && rm -f "$OUT/WebDriverAgentRunner-sim.zip" && zip -qry "$OUT/WebDriverAgentRunner-sim.zip" .)
  echo "simulator build: $OUT/WebDriverAgentRunner-sim.zip"
fi

(cd "$OUT" && shasum -a 256 ./*.ipa ./*.zip 2>/dev/null > SHA256SUMS; cat SHA256SUMS)
