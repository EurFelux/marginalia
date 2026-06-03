#!/usr/bin/env bash
# 从 assets/icon.svg 生成 macOS .icns(零外部依赖:sips + iconutil,均为 macOS 自带)。
# 用法:scripts/make-icons.sh
# 产物:assets/icons/icon.icns(forge.config.ts packagerConfig.icon 引用,提交进 git)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/icon.svg"
OUT_DIR="$ROOT/assets/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$SRC" ] || { echo "缺少源文件:$SRC" >&2; exit 1; }
mkdir -p "$OUT_DIR"

# SVG → 1024 PNG(sips 经 CoreSVG 栅格化,保留透明通道)
sips -s format png -z 1024 1024 "$SRC" --out "$TMP/icon-1024.png" >/dev/null

# iconset:Apple 规定的 10 个尺寸(5 档 × @1x/@2x)
ICONSET="$TMP/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$TMP/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$OUT_DIR/icon.icns"
echo "生成完毕:$OUT_DIR/icon.icns"
