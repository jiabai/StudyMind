#!/bin/bash
# PROTOTYPE — verify upgraded toolchain then re-run the feasibility harness.
# Run AFTER installing the new CommandLineTools dmg.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== current toolchain =="
echo "SDK:   $(xcrun --sdk macosx --show-sdk-version 2>&1)"
echo "Swift: $(swift --version 2>&1 | head -1)"
echo "Rust:  $(rustc --version 2>&1)"

SDK=$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)
MAJOR=${SDK%%.*}
if [ "$MAJOR" -lt 13 ]; then
  echo "FAIL: SDK major $MAJOR < 13 — screencapturekit macos_13_0 still unavailable. Reinstall CLT and retry."
  exit 1
fi
if ! swift --version 2>/dev/null | grep -qE "Swift version (5\.[7-9]|[6-9]|10)"; then
  echo "FAIL: Swift too old (need >= 5.7 for swift build --scratch-path)."
  exit 1
fi
echo "OK: toolchain satisfies screencapturekit 8.0.1 requirements."

echo
echo "== re-run feasibility harness (F-01 build + audio-only probe) =="
exec "$DIR/run.sh"
