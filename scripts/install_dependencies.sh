#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

STATE_DIR="$HOME/.zoom-track-exporter"
STATE_FILE="$STATE_DIR/managed-dependencies"
mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

if ! command -v brew >/dev/null 2>&1; then
  echo "需要 Homebrew 才能安装 FFmpeg。请先安装 Homebrew：https://brew.sh/"
  exit 1
fi

# `brew --version` does not load Homebrew's Ruby code. Run a harmless Ruby-backed
# command first, so a corrupt/obsolete installation fails with an actionable note.
if ! brew config >/dev/null 2>&1; then
  echo ""
  echo "当前 Homebrew 无法运行（通常是 Ruby / portable-ruby 缺失或 Homebrew 仓库损坏）。"
  echo "Apple Silicon Mac 请在 Terminal 使用 Homebrew 官方安装器安装到 /opt/homebrew："
  echo '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "安装完成后，重新打开本工具并点击“安装 / 修复依赖”。"
  echo "本工具不会自动修改或删除已有的 Homebrew 安装。"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "安装 FFmpeg…"
  brew install ffmpeg
  echo "ffmpeg" >> "$STATE_FILE"
else
  echo "FFmpeg 已存在，保留原有安装。"
fi

if ! command -v pipx >/dev/null 2>&1; then
  echo "安装 pipx…"
  brew install pipx
  echo "pipx" >> "$STATE_FILE"
fi

if ! command -v ffmpeg-normalize >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/ffmpeg-normalize" ]; then
  echo "安装 ffmpeg-normalize…"
  pipx install ffmpeg-normalize
  echo "ffmpeg-normalize" >> "$STATE_FILE"
else
  echo "ffmpeg-normalize 已存在，保留原有安装。"
fi

echo "依赖检查完成。若刚安装 pipx，请重开本工具以刷新环境。"
