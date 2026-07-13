# Changelog

## Unreleased

### Added

- Support for WAV, AIFF, FLAC, MP3, M4A, and AAC input.
- MP3, M4A (AAC), and selectable 32-bit float, 24-bit PCM, or 16-bit PCM WAV output.
- Waveform preview, direct waveform-marker dragging for shared and individual trim, single-track trim audition, track selection, and audible-track selection.
- ZIP share packages, per-job progress, and selectable per-job track concurrency.
- English, Simplified Chinese, Traditional Chinese, Japanese, Spanish, French, and Korean interface.
- Locale files are discovered automatically, so a new complete JSON locale adds a UI language.
- Optional stereo-to-independent-mono splitting with separate waveform preview, trim, and export for left/right channels.
- Per-track preview volume from −60 dB to +12 dB and an optional playback limiter for safer 32-bit float auditioning. The limiter is enabled on first launch and remembers the last choice.
- Original-level export mode skips normalization and can apply each track’s preview volume gain.
- Replaced the standalone safe-level mode with independent toggles for applying preview gains and enforcing the safety ceiling.
- Added −0.1 dBFS and −0.3 dBFS final output safety-ceiling options for WAV, MP3, and M4A exports.
- Added an abort button for running exports and a remembered option to open the output folder in Finder when complete.
- Added linked or independent preview playheads, synchronized multi-track playback, and playhead reset controls.
- Added per-track preview mute/unmute controls; muted preview tracks are exported muted only when preview-volume export is enabled.

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
- 提供英文、简体中文、繁体中文、日文、西班牙语、法语与韩文界面。
- 支持每轨 −60 dB 至 +12 dB 的试听音量，以及可选试听限幅器，方便安全试听 32-bit float 音频。首次打开时默认开启，并记住上次选择。
- 增加“不做标准化”导出模式：跳过标准化，并可将每轨试听增益应用到导出文件。
- 将单独的安全音量模式改为两个独立选项：是否应用试听增益，以及是否确保通过安全峰值检测。
- 明确安全峰值选项适用于所有标准化模式：关闭时仍使用所选峰值作为初始目标，仅跳过最终复检和重试。
- 增加 −0.1 dBFS 和 −0.3 dBFS 最终输出安全峰值选项，适用于 WAV、MP3 和 M4A 导出。
- 增加转换中的取消按钮，以及完成后自动在 Finder 中打开输出文件夹的记忆选项。
- 增加联动或独立试听播放头、同步多轨试听和播放头重置控制。
- 增加每轨试听静音/取消静音按钮；只有启用“将试听音量应用到导出”时，试听静音状态才会影响导出。

### 安全与行为

- 会测量高于 0 dBFS 的 32-bit float 信号，并在编码前安全降低。
- 在分析或导出前替换 NaN 与 Infinity 样本。
- 对生成文件检查峰值；必要时以更低增益重新编码。
- 同一源文件夹的任务会串行处理，保护输出文件。
