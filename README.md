# Multitrack Audio Exporter

A macOS-local app for batch-exporting multitrack recordings as safe, shareable files. All processing stays on your Mac.

> macOS only. The interface is available in English and Simplified Chinese.

## Highlights

- **32-bit float WAV input** with safe handling of signals above 0 dBFS.
- **Input:** WAV, AIFF, FLAC, MP3, M4A, and AAC.
- **Output:** MP3, M4A (AAC), or WAV at 32-bit float, 24-bit PCM, or 16-bit PCM.
- **Flexible preparation:** waveform preview, track selection, shared or individual trim, and three level-processing modes.
- **Easy sharing:** optional ZIP package and a local-only workflow.

## Quick start

1. Double-click `start.command`.
2. Open <http://127.0.0.1:8765> if your browser does not open automatically.
3. Click **Install / Repair** on first use to install FFmpeg through Homebrew.
4. Choose an audio folder, adjust the export settings, and start the export.

Files are written to `normalized_audio` inside the source folder.

## Requirements

- macOS with Python 3.
- FFmpeg. The app can install it through Homebrew.

The red **Uninstall app-managed dependencies** button removes only FFmpeg that this app recorded as its own installation. Homebrew’s shared dependencies are retained.

## Tests

Tests generate synthetic audio only; no recordings are used.

```bash
python3 -m unittest discover -s tests
```

See [CHANGELOG.md](CHANGELOG.md) for detailed behavior and release notes.

---

# 多轨音频批量导出

这是一个仅在 macOS 本机运行的多轨音频批量导出工具，可生成安全、便于分享的文件。全部处理都在你的 Mac 上完成。

> 仅支持 macOS；界面提供英文和简体中文。

## 主要功能

- **重点支持 32-bit float WAV 输入**，可安全处理高于 0 dBFS 的信号。
- **输入：**WAV、AIFF、FLAC、MP3、M4A、AAC。
- **输出：**MP3、M4A（AAC），或 32-bit float、24-bit PCM、16-bit PCM WAV。
- **灵活准备：**波形预览、轨道选择、统一或逐轨裁剪，以及三种音量处理模式。
- **方便分享：**可选 ZIP 分享包，全部本机处理。

## 快速开始

1. 双击 `start.command`。
2. 若浏览器未自动打开，访问 <http://127.0.0.1:8765>。
3. 首次使用时点击 **安装 / 修复依赖**，通过 Homebrew 安装 FFmpeg。
4. 选择音频文件夹，调整导出设置后开始转换。

输出文件会写入源文件夹内的 `normalized_audio`。

## 环境要求

- 安装 Python 3 的 macOS。
- FFmpeg；可由本工具通过 Homebrew 安装。

红色的 **卸载本工具安装的依赖** 按钮只会删除本工具记录为自身安装的 FFmpeg；Homebrew 的共享间接依赖会保留。

## 测试

测试只生成合成音频，不会读取或使用任何真实录音文件。

```bash
python3 -m unittest discover -s tests
```

具体行为与版本记录见 [CHANGELOG.md](CHANGELOG.md)。
