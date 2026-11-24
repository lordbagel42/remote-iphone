#!/usr/bin/env bash
# Builds `plumesign` (the CLI half of PlumeImpactor) with impactor-sign-xctest.patch applied,
# for Apple Silicon Macs. Needs only Rust (rustup), not Xcode. Output: dist/plumesign
set -euo pipefail

IMPACTOR_REF="${IMPACTOR_REF:-v2.7.3}"   # same version as the Impactor.app on the host Mac
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$PWD/impactor-build}"
OUT="${OUT:-$PWD/dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [ ! -d "$WORK" ]; then
  git clone --quiet --depth 1 --branch "$IMPACTOR_REF" https://github.com/khcrysalis/Impactor.git "$WORK"
  git -C "$WORK" apply "$HERE/impactor-sign-xctest.patch"
fi
cd "$WORK"
cargo build --release -p plumesign
cp target/release/plumesign "$OUT/plumesign"
echo "built $OUT/plumesign ($IMPACTOR_REF + xctest signing patch)"
