# Changelog

## Unreleased

### Added

- Support for WAV, AIFF, FLAC, MP3, M4A, and AAC input.
- MP3, M4A (AAC), and selectable 32-bit float, 24-bit PCM, or 16-bit PCM WAV output.
- Waveform preview, direct waveform-marker dragging for shared and individual trim, single-track trim audition, track selection, and audible-track selection.
- ZIP share packages, per-job progress, and selectable per-job track concurrency.
- English and Simplified Chinese interface.
- Locale files are discovered automatically, so a new complete JSON locale adds a UI language.

### Safety and behavior

- 32-bit float samples above 0 dBFS are measured and safely reduced before encoding.
- NaN and Infinity samples are replaced before analysis or export.
- Generated outputs are peak-checked and retried at a lower gain when necessary.
- Exports from the same source folder are serialized to protect output files.

---

# 更新日志

## 未发布

### 新增

- 支持 WAV、AIFF、FLAC、MP3、M4A、AAC 输入。
- 支持 MP3、M4A（AAC）输出，以及可选 32-bit float、24-bit PCM、16-bit PCM WAV 输出。
- 支持波形预览、直接拖动波形标记进行裁剪、轨道选择和只选择有声轨道。
- 支持 ZIP 分享包、任务进度和单任务内轨道并发设置。
- 提供英文与简体中文界面。

### 安全与行为

- 会测量高于 0 dBFS 的 32-bit float 信号，并在编码前安全降低。
- 在分析或导出前替换 NaN 与 Infinity 样本。
- 对生成文件检查峰值；必要时以更低增益重新编码。
- 同一源文件夹的任务会串行处理，保护输出文件。
