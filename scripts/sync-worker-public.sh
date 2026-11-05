#!/usr/bin/env bash
# 将 export-pages 产物同步到 signal-worker/public/inkmesh（供 Wrangler assets 部署）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/pages"
DEST="$ROOT/packages/ink-net/signal-worker/public/inkmesh"

if [[ ! -d "$SRC" ]]; then
  echo "missing $SRC — run: python3 scripts/export-pages.py" >&2
  exit 1
fi

PUBLIC_ROOT="$ROOT/packages/ink-net/signal-worker/public"
rm -rf "$PUBLIC_ROOT"
mkdir -p "$DEST"
# 不用 cp -a：避免把源目录 ACL/扩展属性带进产物，Wrangler 上传时会报
# 「Could not read file … due to unexpected error」并跳过文件导致 404。
tar -C "$SRC" -cf - . | tar -C "$DEST" -xf -
# 占位，避免空 public 根被忽略；并保留可提交的 .gitkeep
: > "$PUBLIC_ROOT/.assetskeep"
: > "$PUBLIC_ROOT/.gitkeep"
echo "Synced $SRC → $DEST"
