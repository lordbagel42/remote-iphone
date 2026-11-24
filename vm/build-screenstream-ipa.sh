#!/usr/bin/env bash
# Builds an unsigned ScreenStream.ipa (the app plus its Broadcast Upload extension) for real iPhones.
# Run on a Mac with Xcode and XcodeGen (brew install xcodegen). Sign and install it like WDA (plumesign).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
XCODE="${XCODE:-/Applications/Xcode_16.4.app}"
WORK="${WORK:-$PWD/screenstream-build}"
OUT="${OUT:-$PWD/dist}"
export DEVELOPER_DIR="$XCODE/Contents/Developer"
mkdir -p "$WORK" "$OUT"
OUT="$(cd "$OUT" && pwd)"
rsync -a --delete "$HERE/screenstream/" "$WORK/src/"
cd "$WORK/src"
xcodegen generate --quiet
xcodebuild build -project ScreenStream.xcodeproj -scheme ScreenStream -configuration Release \
  -destination generic/platform=iOS -derivedDataPath "$WORK/dd" CODE_SIGNING_ALLOWED=NO ARCHS=arm64 \
  > "$WORK/build.log" 2>&1 || { grep -E "error:|warning: .*SampleHandler" "$WORK/build.log" | head -40; tail -20 "$WORK/build.log"; exit 1; }
APP="$WORK/dd/Build/Products/Release-iphoneos/ScreenStream.app"
STAGE="$(mktemp -d)"
mkdir "$STAGE/Payload"
ditto "$APP" "$STAGE/Payload/ScreenStream.app"
rm -f "$OUT/ScreenStream.ipa"
(cd "$STAGE" && zip -qry "$OUT/ScreenStream.ipa" Payload)
rm -rf "$STAGE"
echo "IPA: $OUT/ScreenStream.ipa"
(cd "$OUT" && unzip -l ScreenStream.ipa | grep -E "\.appex/|ScreenStream$" | head; shasum -a 256 ScreenStream.ipa)
