#!/bin/bash
# PROTOTYPE — macOS recording feasibility harness (throwaway).
# Compiles and runs the Rust probe (screencapturekit binding) for evidence collection.
# NEVER writes user audio to disk.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== build probe crate (F-01: binding compiles/links on this arch) =="
(cd "$DIR/probe-crate" && cargo build --release)

BIN="$DIR/probe-crate/target/release/scprobe-crate"
# Swift runtime lives in the system shared cache; cargo relinking drops the rpath.
install_name_tool -add_rpath /usr/lib/swift "$BIN" 2>/dev/null || true

echo
echo "== run A: audio-only, excludesCurrentProcessAudio=TRUE (default product stance) =="
"$BIN" --exclude-self --seconds 8

echo
echo "== run B: audio-only + self-tone playing, NO exclusion (F-06 contrast, expect higher rms) =="
"$BIN" --play-self-audio --seconds 8

echo
echo "== run C: audio-only + self-tone playing + exclusion (F-06, expect rms ~0) =="
"$BIN" --play-self-audio --exclude-self --seconds 8

echo
echo "== done. Evidence captured above; no audio files written. =="
