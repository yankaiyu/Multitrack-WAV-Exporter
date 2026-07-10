# Multitrack WAV Exporter

A macOS-local web app for batch-exporting aligned multitrack 32-bit float WAV recordings as safe, shareable MP3 files. It is designed for rehearsal stems and other recordings that need to be imported into a browser-based DAW or shared with collaborators.

All processing happens on your Mac. No audio is uploaded anywhere.

> macOS only. The interface is available in English and Simplified Chinese. On first launch it follows the system language when it is Chinese; otherwise it starts in English. The choice is remembered by the browser.

## Features

- Batch-process WAV files directly inside a selected folder.
- Export MP3 at 128–320 kbps and retain or select the output sample rate.
- Create a ZIP share package alongside the output folder.
- Optionally generate cached waveform previews, trim every aligned track with one shared dual-handle range, and select the tracks to export.
- Choose per-track peak normalization, group-relative normalization, or minimal level adjustment.
- Safely handle 32-bit float WAV files: non-finite samples (NaN / Infinity) are converted to silence before measurement or encoding.
- Measure the actual cleaned signal peak, including float signals above 0 dBFS, then apply a correct linear gain before MP3 encoding.
- Treat low-level unused channels as empty tracks by default (≤ -40 dBFS), avoiding amplified numeric residue. This threshold is adjustable in the interface.
- Decode and validate final MP3 peaks. If needed, the app re-encodes from the cleaned WAV at a lower gain to meet the selected safety ceiling.

## Quick start

1. Double-click `start.command`.
2. Your default browser opens at <http://127.0.0.1:8765>.
3. On first use, click **Install / Repair** to install FFmpeg through Homebrew.
4. Select a folder containing WAV files. Optionally click **Load waveforms**, select the tracks to export, and set a shared trim range.
5. Adjust export settings and click **Start export**.

The MP3 files are written to `normalized_mp3` inside the selected source folder. A ZIP file is also created by default for easy sharing.

## Starting and stopping

Only one local service runs at a time. Opening `start.command` again reuses an existing app service and opens it in the browser instead of causing a port conflict.

To stop the app, press `Control+C` in its Terminal window or close that window. The launcher automatically stops its local server. If the window was closed but a service remains running, execute this in Terminal:

```bash
kill "$(lsof -t -nP -iTCP:8765 -sTCP:LISTEN)"
```

Then open `start.command` again to start the latest version.

## Requirements and troubleshooting

- A macOS-provided or separately installed Python 3 is required to run the local web server.
- If macOS asks you to accept the Xcode Command Line Tools license, run `sudo xcodebuild -license` once in Terminal and follow the prompts.
- If Homebrew reports Ruby syntax errors, repair Homebrew before installing FFmpeg. On Apple Silicon, Homebrew's default location is `/opt/homebrew`. The official installer shows the planned changes and asks for confirmation:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Do not manually remove an existing `/usr/local/Homebrew` installation unless you have confirmed that no other software relies on it.

## Dependency removal

The red **Uninstall app-managed dependencies** button removes only FFmpeg that this app itself installed and recorded in `~/.multitrack-wav-exporter/managed-dependencies`. It does not remove a pre-existing FFmpeg installation.

## Tests

The included tests generate synthetic 32-bit float WAV data only; no recording files are used. With FFmpeg installed, run:

```bash
python3 -m unittest discover -s tests
```

---

# 多轨 WAV 批量导出

这是一个仅在 macOS 本机运行的网页工具，用于将同一文件夹中的对齐多轨 32-bit float WAV 批量导出为安全、便于分享的 MP3。适合乐队排练分轨、导入浏览器 DAW 或发送给合作者。

全部音频处理都在本机完成，不会上传任何文件。

> 仅支持 macOS。界面提供英文和简体中文。首次启动时，若系统语言为中文则默认中文，否则默认英文；之后浏览器会记住选择。

## 功能

- 批量处理所选文件夹第一层中的 WAV 文件。
- 支持 128–320 kbps MP3，采样率可保持原始或自行选择。
- 默认同时生成 ZIP 分享包。
- 可选生成缓存波形预览；加载后可选择要导出的轨道，并用同一条双端滑块裁剪所有对齐轨道。
- 支持每轨峰值归一化、整组保持相对音量、或尽量保持原音量三种模式。
- 专门处理 32-bit float WAV：NaN / Infinity 非有限样本会先变为静音，不会进入测量或编码流程。
- 测量清洗后的实际峰值；即使浮点信号高于 0 dBFS，也会在 MP3 编码前施加正确的线性增益。
- 默认将不高于 -40 dBFS 的低电平无输入/底噪轨道视为静音，不归一化；该阈值可在界面调整。
- MP3 生成后会解码检查峰值；若高于所选安全上限，会从清洗后的 WAV 以更低增益重新编码。

## 快速开始

1. 双击 `start.command`。
2. 默认浏览器会打开 <http://127.0.0.1:8765>。
3. 首次使用时，点击 **安装 / 修复依赖**，工具会通过 Homebrew 安装 FFmpeg。
4. 选择包含 WAV 的文件夹；如需裁剪或选择部分轨道，可点击 **加载波形**，再设定全局裁剪范围。
5. 调整导出设置后点击 **开始转换**。

MP3 会写入所选源文件夹中的 `normalized_mp3`；默认还会生成一个便于发送的 ZIP 文件。

## 启动与停止

一次只能运行一个本地服务。再次双击 `start.command` 时，工具会复用已运行的服务并打开浏览器，不会产生端口冲突。

在其 Terminal 窗口中按 `Control+C` 或直接关闭窗口，即可停止服务；启动脚本会自动终止本次运行的本地服务。若窗口关闭后服务仍在运行，可在 Terminal 执行：

```bash
kill "$(lsof -t -nP -iTCP:8765 -sTCP:LISTEN)"
```

之后重新双击 `start.command`，即可启动最新版本。

## 环境与排错

- 本地网页服务需要 macOS 自带或另行安装的 Python 3。
- 如果系统提示尚未接受 Xcode Command Line Tools 许可，请在 Terminal 运行一次 `sudo xcodebuild -license` 并按提示操作。
- 如果 Homebrew 出现 Ruby 语法错误，请先修复 Homebrew 再安装 FFmpeg。Apple Silicon 的默认 Homebrew 路径是 `/opt/homebrew`；官方安装器会展示操作并要求确认：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

除非已确认没有其他软件依赖，否则不要手动删除已有的 `/usr/local/Homebrew`。

## 卸载依赖

红色的 **卸载本工具安装的依赖** 按钮只会删除本工具安装并记录在 `~/.multitrack-wav-exporter/managed-dependencies` 中的 FFmpeg，不会删除原本已有的 FFmpeg。

## 测试

项目自带的测试只会生成合成的 32-bit float WAV 数据，不会读取或使用任何真实录音文件。安装 FFmpeg 后可运行：

```bash
python3 -m unittest discover -s tests
```
