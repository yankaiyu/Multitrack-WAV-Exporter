#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

STATE_FILE="$HOME/.multitrack-audio-exporter/managed-dependencies"
if [ ! -f "$STATE_FILE" ]; then
  echo "未发现由本工具安装的依赖，因此没有删除任何内容。"
  exit 0
fi

FORMULA="$(sed -n 's/^formula=//p' "$STATE_FILE")"
RECORDED_BREW="$(sed -n 's/^brew_bin=//p' "$STATE_FILE")"
RECORDED_BREW_PREFIX="$(sed -n 's/^brew_prefix=//p' "$STATE_FILE")"
RECORDED_FFMPEG_PREFIX="$(sed -n 's/^ffmpeg_prefix=//p' "$STATE_FILE")"

if [ "$FORMULA" != "ffmpeg" ] || [ -z "$RECORDED_BREW" ] || [ -z "$RECORDED_BREW_PREFIX" ] || [ -z "$RECORDED_FFMPEG_PREFIX" ]; then
  echo "依赖记录格式无效或过旧；为安全起见，没有删除任何内容。"
  echo "如确认要移除 FFmpeg，请自行在 Terminal 运行：brew uninstall ffmpeg"
  exit 1
fi

if [ ! -x "$RECORDED_BREW" ]; then
  echo "记录的 Homebrew 不存在：$RECORDED_BREW。为安全起见，没有删除任何内容。"
  exit 1
fi
CURRENT_BREW_PREFIX="$($RECORDED_BREW --prefix 2>/dev/null || true)"
if [ "$CURRENT_BREW_PREFIX" != "$RECORDED_BREW_PREFIX" ]; then
  echo "Homebrew 前缀与安装记录不匹配；为安全起见，没有删除任何内容。"
  exit 1
fi
CURRENT_FFMPEG_PREFIX="$($RECORDED_BREW --prefix ffmpeg 2>/dev/null || true)"
if [ "$CURRENT_FFMPEG_PREFIX" != "$RECORDED_FFMPEG_PREFIX" ]; then
  echo "FFmpeg 安装位置与记录不匹配；为安全起见，没有删除任何内容。"
  exit 1
fi

echo "已验证本工具管理的 FFmpeg：$RECORDED_FFMPEG_PREFIX"
echo "正在通过记录的 Homebrew 卸载 FFmpeg…"
"$RECORDED_BREW" uninstall ffmpeg
rm -f "$STATE_FILE"
echo "完成。Homebrew 的间接依赖会保留，避免影响其他工具。"
