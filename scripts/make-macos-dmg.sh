#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <target-triple> [volume-name]" >&2
  exit 1
fi

target_triple=$1
volume_name=${2-StudyMind}

if [[ -z "$volume_name" || "$volume_name" == "." || "$volume_name" == ".." || "$volume_name" == */* || "$volume_name" == *\\* ]]; then
  echo "invalid volume name: $volume_name" >&2
  exit 1
fi

case "$target_triple" in
  x86_64-apple-darwin) suffix=x64; expected_arch=x86_64 ;;
  aarch64-apple-darwin) suffix=aarch64; expected_arch=arm64 ;;
  *)
    echo "unsupported macOS target triple: $target_triple" >&2
    exit 1
    ;;
esac

repo_root=${STUDYMIND_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
app_path="$repo_root/app/src-tauri/target/$target_triple/release/bundle/macos/StudyMind.app"
resources_path="$app_path/Contents/Resources/resources"
main_executable="$app_path/Contents/MacOS/StudyMind"

if [[ ! -d "$app_path" ]]; then
  echo "application bundle not found: $app_path" >&2
  exit 1
fi

if [[ ! -f "$main_executable" ]]; then
  echo "application main executable not found: $main_executable" >&2
  exit 1
fi

architecture_info=$(lipo -info "$main_executable" 2>&1) || {
  echo "unable to inspect application architecture: $architecture_info" >&2
  exit 1
}
if ! printf '%s\n' "$architecture_info" | grep -Eq "(^|[^[:alnum:]_])${expected_arch}([^[:alnum:]_]|$)"; then
  echo "wrong application architecture: expected $expected_arch; lipo reported: $architecture_info" >&2
  exit 1
fi

if [[ -d "$resources_path" ]] && {
  find "$resources_path" -type d -name '__pycache__' -print -quit | grep -q . ||
  find "$resources_path" -type f -name '*.pyc' -print -quit | grep -q .
}; then
  echo "Python cache files are not allowed in the application bundle: $resources_path" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=4 "$app_path"

version=$(node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(config.version);
' "$repo_root/app/src-tauri/tauri.conf.json")

staging=$(mktemp -d "${TMPDIR:-/tmp}/studymind-dmg.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT

mkdir -p "$staging"
ditto "$app_path" "$staging/StudyMind.app"
ln -s /Applications "$staging/Applications"

output_dir="$repo_root/app/src-tauri/target/$target_triple/release/bundle/dmg"
output_path="$output_dir/StudyMind_${version}_${suffix}.dmg"
mkdir -p "$output_dir"
hdiutil create \
  -volname "$volume_name" \
  -srcfolder "$staging" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$output_path"
