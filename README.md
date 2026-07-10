# Multitrack WAV Exporter

本地网页工具，将多个 32-bit float WAV 多轨批量导出为适合分享和导入 BandLab 的 MP3。

## 启动

双击 `start.command`，或在 Terminal 中运行：

```bash
python3 server.py
```

打开 <http://127.0.0.1:8765>。点击「选择…」将调用 macOS 原生文件夹选择器。首次使用请在网页「依赖」区域点击安装；它使用 Homebrew 安装 FFmpeg。

## 启动与停止

一次只能运行一个本地服务。再次双击 `start.command` 时，它会自动复用已运行的服务并打开浏览器，不会发生端口冲突。

若要完全停止服务，请关闭其 Terminal 窗口；如果窗口已经关闭但服务仍在运行，可在 Terminal 执行：

```bash
kill "$(lsof -t -nP -iTCP:8765 -sTCP:LISTEN)"
```

之后再次双击 `start.command`，即可启动最新版本。

运行网页服务需要 macOS 自带或已安装的 Python 3。若系统提示尚未接受 Xcode Command Line Tools 许可，请在 Terminal 运行一次 `sudo xcodebuild -license` 并按提示接受；之后重新双击 `start.command`。

如果依赖安装提示 Homebrew Ruby 语法错误，请先修复 Homebrew 本身。Apple Silicon Mac 的官方默认 Homebrew 位置是 `/opt/homebrew`；官方安装脚本会先展示将执行的操作并要求确认：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

完成后重新打开本工具并再次点击安装。不要为此手动删除已有的 `/usr/local/Homebrew`，除非你已确认其中没有其他软件依赖。

## 安全与卸载

- 所有音频处理只发生在本机；没有上传功能。
- 输出在所选歌曲文件夹内的 `normalized_mp3`。默认也会在同一位置生成可直接分享的 ZIP 包。
- 所有 32-bit float WAV 会先将 NaN / Infinity 样本清为静音，再测量实际峰值。即使源文件峰值超过 0 dBFS，也会先施加正确的线性增益。
- 默认将峰值不高于 -40 dBFS 的轨道视为无输入/底噪，只转码、不归一化；可在界面调整此阈值。
- 已归一化的 MP3 会解码检查峰值；若高于设定安全上限，会从清洗后的 WAV 自动以更低目标重新编码。
- 卸载按钮只会删除本工具首次安装、并记录在 `~/.multitrack-wav-exporter/managed-dependencies` 中的 FFmpeg。原本已有的依赖不会删除。
