#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

STATE_FILE="$HOME/.zoom-track-exporter/managed-dependencies"
if [ ! -f "$STATE_FILE" ]; then
  echo "未发现由本工具安装的依赖，因此没有删除任何内容。"
  exit 0
fi

if grep -qx "ffmpeg-normalize" "$STATE_FILE" && command -v pipx >/dev/null 2>&1; then
  echo "卸载由本工具安装的 ffmpeg-normalize…"
  pipx uninstall ffmpeg-normalize || true
fi
if grep -qx "ffmpeg" "$STATE_FILE" && command -v brew >/dev/null 2>&1; then
  echo "卸载由本工具安装的 FFmpeg…"
  brew uninstall ffmpeg || true
fi
if grep -qx "pipx" "$STATE_FILE" && command -v brew >/dev/null 2>&1; then
  echo "保留 pipx：它可能已被其他工具使用；请在 Homebrew 中自行卸载，如确有需要。"
fi
rm -f "$STATE_FILE"
echo "完成。未触碰本工具安装前就已存在的依赖。"
