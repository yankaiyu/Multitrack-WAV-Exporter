#!/usr/bin/env python3
"""Local web UI and conversion backend for multitrack audio exports."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
LOCALES_ROOT = WEB_ROOT / "locales"
SCRIPTS = ROOT / "scripts"
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAC_BIN_DIRS = [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
WAVEFORM_FILES: dict[str, Path] = {}
AUDIO_FILES: dict[str, Path] = {}
SOURCE_LOCKS: dict[str, threading.Lock] = {}
SOURCE_LOCKS_LOCK = threading.Lock()
LAST_CLIENT_ACTIVITY = time.monotonic()
IDLE_SHUTDOWN_SECONDS = 60
INPUT_EXTENSIONS = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac"}
OUTPUT_FORMATS = {
    "mp3": {"extension": ".mp3", "codec": "libmp3lame"},
    "m4a": {"extension": ".m4a", "codec": "aac"},
    "wav": {"extension": ".wav", "codec": None},
}
WAV_CODECS = {"float32": "pcm_f32le", "pcm24": "pcm_s24le", "pcm16": "pcm_s16le"}
AUDIO_CONTENT_TYPES = {
    ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".flac": "audio/flac",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
}


def tool_path(name: str) -> str | None:
    """Find tools installed by Homebrew, pipx, or normally available on PATH."""
    candidates = [shutil.which(name), *(str(folder / name) for folder in MAC_BIN_DIRS)]
    for item in candidates:
        if item and Path(item).is_file() and os.access(item, os.X_OK):
            return item
    return None


def available_locales() -> list[dict[str, str]]:
    """Discover locale files so adding one JSON file adds one UI language."""
    locales = []
    for file in sorted(LOCALES_ROOT.glob("*.json")):
        try:
            with file.open(encoding="utf-8") as handle:
                locale = json.load(handle)
            name = locale.get("languageName")
            if isinstance(name, str) and name:
                locales.append({"code": file.stem, "name": name})
        except (OSError, json.JSONDecodeError):
            continue
    return locales


def append_log(job_id: str, line: str) -> None:
    with JOBS_LOCK:
        JOBS[job_id]["log"] += line


def set_progress(job_id: str, value: int, label: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job["progress"] = max(0, min(100, value))
            job["progressLabel"] = label


def mark_client_activity() -> None:
    global LAST_CLIENT_ACTIVITY
    LAST_CLIENT_ACTIVITY = time.monotonic()


def source_lock(source: Path) -> threading.Lock:
    """Return a stable lock so two browser tasks cannot write one output folder."""
    key = str(source.resolve())
    with SOURCE_LOCKS_LOCK:
        return SOURCE_LOCKS.setdefault(key, threading.Lock())


def idle_shutdown_monitor(httpd: ThreadingHTTPServer) -> None:
    """Stop the local-only server after its last browser page has gone away."""
    while True:
        time.sleep(2)
        with JOBS_LOCK:
            processing = any(job.get("status") == "running" for job in JOBS.values())
        if not processing and time.monotonic() - LAST_CLIENT_ACTIVITY >= IDLE_SHUTDOWN_SECONDS:
            print("No browser activity detected; stopping local server.")
            httpd.shutdown()
            return


def run_process(job_id: str, command: list[str], cwd: Path | None = None) -> int:
    env = os.environ.copy()
    env["PATH"] = ":".join([str(Path.home() / ".local/bin"), *(str(folder) for folder in MAC_BIN_DIRS), env.get("PATH", "")])
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1, env=env)
    assert process.stdout
    with process.stdout:
        for line in process.stdout:
            append_log(job_id, line)
    return process.wait()


def parallel_map(items: list, workers: int, action) -> list:
    """Run independent per-track actions with a small, caller-selected limit."""
    if workers <= 1 or len(items) <= 1:
        return [action(item) for item in items]
    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(action, items))


def peak_of_audio(path: Path) -> float | None:
    """Return decoded sample peak in dBFS, including float values above 0 dBFS."""
    ffmpeg = tool_path("ffmpeg")
    if not ffmpeg:
        return None
    # volumedetect clamps its report at 0 dBFS. 32-bit float WAV and decoded MP3
    # samples can exceed it, so use astats and take the largest channel/overall peak.
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-af", "astats=metadata=0:reset=0", "-f", "null", "-"],
                            capture_output=True, text=True)
    levels = []
    for value in re.findall(r"Peak level dB:\s*([-+\d.]+|-inf|inf)", result.stderr):
        try:
            level = float(value)
            if level != float("inf") and level != float("-inf"):
                levels.append(level)
        except ValueError:
            continue
    return max(levels) if levels else None


def peak_of_mp3(path: Path) -> float | None:
    return peak_of_audio(path)


def sanitized_inputs(job_id: str, files: list[Path], workspace: Path,
                     silence_threshold: float, trim_start: float, trim_end: float | None, workers: int,
                     track_trims: dict[str, dict] | None = None) -> tuple[dict[Path, Path], set[Path]]:
    """Make finite 32-bit float working WAVs and identify blank input channels.

    Some float recorders write NaN/Inf samples in unused channels. Those samples make
    peak analyzers return NaN/Inf and can crash lossy encoders, so never pass them on.
    """
    ffmpeg = tool_path("ffmpeg")
    ffprobe = tool_path("ffprobe")
    if not ffmpeg or not ffprobe:
        raise ValueError("找不到 FFmpeg / FFprobe，请先安装依赖。")
    workspace.mkdir(parents=True, exist_ok=True)
    track_trims = track_trims or {}
    def sanitize_one(source: Path) -> tuple[Path, Path, float | None]:
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                                "-of", "default=nokey=1:noprint_wrappers=1", str(source)], capture_output=True, text=True)
        try:
            channels = int(probe.stdout.strip())
        except ValueError:
            raise RuntimeError(f"无法读取声道数：{source.name}")
        expressions = "|".join(f"if(isnan(val({channel}))+isinf(val({channel})),0,val({channel}))" for channel in range(channels))
        # Working files are always WAV. Retaining an MP3/M4A input extension here
        # would make FFmpeg select the wrong container for float PCM.
        cleaned = workspace / f"{uuid.uuid4().hex}.wav"
        per_track = track_trims.get(source.name, {})
        source_start = float(per_track.get("start", trim_start))
        raw_end = per_track.get("end", trim_end)
        source_end = float(raw_end) if raw_end not in (None, "") else None
        if source_start < 0 or (source_end is not None and source_end <= source_start):
            raise ValueError(f"{source.name} 的裁剪结束时间必须大于开始时间。")
        trim = f"atrim=start={source_start}" + (f":end={source_end}" if source_end is not None else "")
        command = [ffmpeg, "-hide_banner", "-y", "-i", str(source), "-af", f"{trim},aeval=exprs='{expressions}':c=same",
                   "-c:a", "pcm_f32le", str(cleaned)]
        if run_process(job_id, command) != 0:
            raise RuntimeError(f"无法清洗浮点样本：{source.name}")
        return source, cleaned, peak_of_audio(cleaned)

    finite: dict[Path, Path] = {}
    blank: set[Path] = set()
    for source, cleaned, peak in parallel_map(files, workers, sanitize_one):
        finite[source] = cleaned
        # Unused float channels can contain low-level numeric residue. Do not raise
        # that residue to full scale: only material above the user-set threshold is active.
        if peak is None or peak <= silence_threshold:
            blank.add(source)
            append_log(job_id, f"{source.name} 峰值 {peak if peak is not None else '未知'} dBFS，低于无输入阈值 {silence_threshold:.0f} dBFS：仅转换，不归一化。\n")
    return finite, blank


def waveform_job(job_id: str, source_text: str, language: str = "zh") -> None:
    """Generate compact cached waveform PNGs for the trimming UI."""
    english = language == "en"
    def text(en: str, zh: str) -> str:
        return en if english else zh
    try:
        source = Path(source_text).expanduser().resolve()
        files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() in INPUT_EXTENSIONS)
        ffmpeg, ffprobe = tool_path("ffmpeg"), tool_path("ffprobe")
        if not files:
            raise ValueError(text("No supported audio files were found in this folder.", "该文件夹中没有支持的音频文件。"))
        if not ffmpeg or not ffprobe:
            raise ValueError(text("FFmpeg / FFprobe is not available. Install dependencies first.", "找不到 FFmpeg / FFprobe，请先安装依赖。"))
        cache = source / ".multitrack-audio-exporter-preview"
        cache.mkdir(exist_ok=True)
        previews = []
        for index, file in enumerate(files):
            probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                                    "-of", "default=nokey=1:noprint_wrappers=1", str(file)], capture_output=True, text=True)
            channels = int(probe.stdout.strip())
            duration_result = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                              "-of", "default=nokey=1:noprint_wrappers=1", str(file)], capture_output=True, text=True)
            duration = float(duration_result.stdout.strip())
            image = cache / f"{file.name}.png"
            # Regenerate only when the source changed. The aeval stage removes non-finite
            # float samples before showwavespic draws the visual preview.
            if not image.exists() or image.stat().st_mtime_ns < file.stat().st_mtime_ns:
                expressions = "|".join(f"if(isnan(val({channel}))+isinf(val({channel})),0,val({channel}))" for channel in range(channels))
                filter_graph = f"[0:a]aeval=exprs='{expressions}':c=same,showwavespic=s=1400x128:colors=0xD2F26C[wave]"
                temporary_image = cache / f".{file.stem}.{uuid.uuid4().hex}.png"
                command = [ffmpeg, "-hide_banner", "-y", "-i", str(file), "-filter_complex", filter_graph,
                           "-map", "[wave]", "-frames:v", "1", str(temporary_image)]
                if run_process(job_id, command) != 0:
                    raise RuntimeError(text(f"Could not generate waveform: {file.name}", f"无法生成波形：{file.name}"))
                os.replace(temporary_image, image)
            token = uuid.uuid4().hex
            WAVEFORM_FILES[token] = image
            audio_token = uuid.uuid4().hex
            AUDIO_FILES[audio_token] = file
            # Use the same peak measurement used by export decisions, so the UI can
            # optionally deselect tracks below its empty-track threshold.
            previews.append({"name": file.name, "duration": duration, "peak": peak_of_audio(file),
                             "image": f"/api/waveform/{token}", "audio": f"/api/audio/{audio_token}"})
            append_log(job_id, text(f"Waveform {index + 1}/{len(files)}: {file.name}\n", f"波形 {index + 1}/{len(files)}：{file.name}\n"))
            set_progress(job_id, round((index + 1) / len(files) * 100), text(f"Generating waveforms {index + 1}/{len(files)}", f"生成波形 {index + 1}/{len(files)}"))
        with JOBS_LOCK:
            JOBS[job_id].update(status="done", preview=previews)
    except Exception as error:
        append_log(job_id, text(f"\nError: {error}\n", f"\n错误：{error}\n"))
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"


def encode_audio(job_id: str, ffmpeg: str, input_file: Path, output_file: Path, output_format: str,
                 bitrate: int, wav_depth: str, sample_rate: int | None, gain_db: float | None = None) -> None:
    command = [ffmpeg, "-y", "-threads", "1", "-i", str(input_file)]
    if gain_db is not None:
        command += ["-af", f"volume={gain_db:.4f}dB"]
    if output_format == "wav":
        command += ["-c:a", WAV_CODECS[wav_depth]]
    else:
        command += ["-c:a", OUTPUT_FORMATS[output_format]["codec"], "-b:a", f"{bitrate}k"]
    if sample_rate:
        command += ["-ar", str(sample_rate)]
    command.append(str(output_file))
    if run_process(job_id, command) != 0:
        raise RuntimeError(f"转换失败：{input_file.name}")


def convert_job(job_id: str, options: dict) -> None:
    """Serialize jobs targeting the same source folder while allowing other folders through."""
    try:
        lock = source_lock(Path(options["source"]).expanduser())
    except (KeyError, TypeError):
        _convert_job(job_id, options)
        return
    if not lock.acquire(blocking=False):
        append_log(job_id, "同一源文件夹已有任务在运行；本任务正在等待输出目录锁。\n")
        lock.acquire()
    try:
        _convert_job(job_id, options)
    finally:
        lock.release()


def _convert_job(job_id: str, options: dict) -> None:
    try:
        source = Path(options["source"]).expanduser().resolve()
        if not source.is_dir():
            raise ValueError("源文件夹不存在。")
        files = sorted([p for p in source.iterdir() if p.is_file() and p.suffix.lower() in INPUT_EXTENSIONS])
        if not files:
            raise ValueError("该文件夹中没有支持的音频文件。")
        selected = options.get("selectedFiles")
        if selected is not None:
            if isinstance(selected, str):
                selected = [selected]
            selected_names = set(selected)
            files = [file for file in files if file.name in selected_names]
            if not files:
                raise ValueError("请至少选择一条要转换的轨道。")
        mode = options["mode"]
        output_format = options.get("outputFormat", "mp3")
        if output_format not in OUTPUT_FORMATS:
            raise ValueError("无效的输出格式。")
        wav_depth = options.get("wavDepth", "float32")
        if wav_depth not in WAV_CODECS:
            raise ValueError("无效的 WAV 位深。")
        bitrate = int(options["bitrate"])
        sample_rate = options.get("sampleRate")
        sample_rate = int(sample_rate) if sample_rate else None
        ceiling = float(options["ceiling"])
        silence_threshold = float(options.get("silenceThreshold", "-40"))
        workers = int(options.get("workers", "2"))
        if workers not in {1, 2, 4}:
            raise ValueError("无效的并发轨道数。")
        trim_start = float(options.get("trimStart") or 0)
        trim_end = float(options["trimEnd"]) if options.get("trimEnd") else None
        track_trims = options.get("trackTrims") or {}
        if not isinstance(track_trims, dict):
            raise ValueError("逐轨裁剪数据无效。")
        if trim_start < 0 or (trim_end is not None and trim_end <= trim_start):
            raise ValueError("裁剪结束时间必须大于开始时间。")
        output = source / "normalized_audio"
        output.mkdir(exist_ok=True)
        output_extension = OUTPUT_FORMATS[output_format]["extension"]
        used_names: set[str] = set()
        output_files: dict[Path, Path] = {}
        for source_file in files:
            stem = source_file.stem
            if stem in used_names:
                stem = f"{stem}_{source_file.suffix.lstrip('.')}"
            used_names.add(stem)
            output_files[source_file] = output / f"{stem}{output_extension}"
        append_log(job_id, f"将转换 {len(files)} 个音频文件，输出：{output}\n")
        set_progress(job_id, 2, f"准备处理 {len(files)} 条轨道")

        ffmpeg = tool_path("ffmpeg")
        if not ffmpeg:
            raise ValueError("找不到 FFmpeg，请先安装依赖。")
        with tempfile.TemporaryDirectory(prefix="multitrack-audio-export-") as temp:
            set_progress(job_id, 5, "清洗浮点样本并测量峰值")
            cleaned, blank = sanitized_inputs(job_id, files, Path(temp), silence_threshold, trim_start, trim_end, workers, track_trims)
            set_progress(job_id, 20, "浮点样本清洗完成")
            active = [file for file in files if file not in blank]
            # Empty recorder channels are still included in the share package, but they stay silent.
            completed = 0
            completed_lock = threading.Lock()
            total_tracks = len(files)

            def mark_encoded(file: Path) -> None:
                nonlocal completed
                with completed_lock:
                    completed += 1
                    set_progress(job_id, 20 + round(65 * completed / total_tracks), f"已编码 {completed}/{total_tracks} 条轨道")

            def encode_blank(file: Path) -> None:
                encode_audio(job_id, ffmpeg, cleaned[file], output_files[file], output_format, bitrate, wav_depth, sample_rate)
                mark_encoded(file)

            parallel_map(list(blank), workers, encode_blank)

            if mode == "convert":
                target = ceiling - 0.2
                def convert_safely(file: Path) -> None:
                    output_file = output_files[file]
                    input_peak = peak_of_audio(cleaned[file])
                    if input_peak is None:
                        raise RuntimeError(f"无法测量清洗后轨道的峰值：{file.name}")
                    # Keep the original level unless the float source already exceeds the
                    # output ceiling. Measuring before encoding avoids hidden clipping.
                    gain = min(0.0, target - input_peak)
                    encode_audio(job_id, ffmpeg, cleaned[file], output_file, output_format, bitrate, wav_depth, sample_rate, gain)
                    for _ in range(3):
                        peak = peak_of_mp3(output_file)
                        if peak is None or peak <= ceiling:
                            break
                        attenuation = (peak - ceiling) + 0.2
                        append_log(job_id, f"{file.name} 编码后峰值 {peak:.2f} dBFS，降低 {attenuation:.2f} dB 后重编码。\n")
                        gain -= attenuation
                        encode_audio(job_id, ffmpeg, cleaned[file], output_file, output_format, bitrate, wav_depth, sample_rate, gain)
                    else:
                        raise RuntimeError(f"无法让 {file.name} 满足安全峰值上限。")
                    mark_encoded(file)
                parallel_map(active, workers, convert_safely)
            elif active:
                # Peak scanners can mis-handle NaN-bearing float WAVs.
                # Measure the cleaned PCM with FFmpeg itself and apply a deterministic linear gain.
                target = ceiling - 0.2
                input_peaks = {file: peak_of_audio(cleaned[file]) for file in active}
                if any(peak is None for peak in input_peaks.values()):
                    raise RuntimeError("无法测量清洗后轨道的峰值。")
                if mode == "preserve":
                    common_gain = target - max(input_peaks.values())
                    gains = {file: common_gain for file in active}
                else:
                    gains = {file: target - input_peaks[file] for file in active}
                append_log(job_id, "归一化增益：" + ", ".join(f"{file.name} {gain:+.2f} dB" for file, gain in gains.items()) + "\n")
                for _ in range(3):
                    def encode_normalized(file: Path) -> None:
                        encode_audio(job_id, ffmpeg, cleaned[file], output_files[file], output_format, bitrate, wav_depth, sample_rate, gains[file])
                        mark_encoded(file)
                    parallel_map(active, workers, encode_normalized)
                    measured = dict(parallel_map(active, workers, lambda file: (file, peak_of_audio(output_files[file]))))
                    overs = {file: peak - ceiling for file, peak in measured.items() if peak is not None and peak > ceiling}
                    append_log(job_id, "编码后峰值：" + ", ".join(f"{file.name} {peak:.2f} dBFS" for file, peak in measured.items() if peak is not None) + "\n")
                    if not overs:
                        break
                    # A safety retry re-encodes selected tracks; do not advance the
                    # track counter again, but keep the UI in the encoding phase.
                    completed = max(0, completed - len(active))
                    if mode == "preserve":
                        reduction = max(overs.values()) + 0.2
                        gains = {file: gain - reduction for file, gain in gains.items()}
                    else:
                        for file, amount in overs.items():
                            gains[file] -= amount + 0.2
                    append_log(job_id, "峰值高于安全上限，降低增益后从清洗音频重新编码。\n")
                else:
                    raise RuntimeError("三次安全验证后仍无法满足输出峰值上限。")

        # Final report is intentionally based on generated files rather than sources.
        set_progress(job_id, 90, "验证最终输出峰值")
        final_peaks = {p.name: peak_of_audio(output_files[p]) for p in files}
        failed = [name for name, peak in final_peaks.items() if peak is not None and peak > ceiling]
        if failed:
            raise RuntimeError("最终安全验证失败：" + "、".join(failed))
        append_log(job_id, "最终输出峰值验证通过。\n")
        zip_path = None
        if options.get("packageZip"):
            set_progress(job_id, 96, "创建分享 ZIP")
            zip_path = str(source / f"{source.name}_normalized_audio.zip")
            # Package only tracks selected for this job, never stale prior exports.
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for source_file in files:
                    exported = output_files[source_file]
                    if exported.is_file():
                        archive.write(exported, exported.name)
            append_log(job_id, f"已创建分享 ZIP：{zip_path}\n")

        with JOBS_LOCK:
            JOBS[job_id].update(status="done", output=str(output), zip=zip_path, progress=100, progressLabel="完成")
    except Exception as error:
        append_log(job_id, f"\n错误：{error}\n")
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        # This is a local development-style app: always serve the newest UI.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        path = urlparse(path).path
        return str(WEB_ROOT / ("index.html" if path == "/" else path.lstrip("/")))

    def json_response(self, data: dict, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length))

    def stream_audio(self, audio: Path, send_body: bool = True) -> None:
        """Stream one approved local source file, including browser byte-range seeks."""
        total = audio.stat().st_size
        start, end = 0, total - 1
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            start_text, end_text = match.groups()
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else end
            elif end_text:
                start = max(0, total - int(end_text))
            else:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            if start >= total or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{total}")
                self.end_headers()
                return
            end = min(end, total - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        content_type = AUDIO_CONTENT_TYPES.get(audio.suffix.lower(), mimetypes.guess_type(str(audio))[0] or "application/octet-stream")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        if not send_body:
            return
        with audio.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_GET(self) -> None:
        mark_client_activity()
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.json_response({"ffmpeg": bool(tool_path("ffmpeg"))})
        elif parsed.path == "/api/locales":
            self.json_response({"locales": available_locales()})
        elif parsed.path.startswith("/api/job/"):
            with JOBS_LOCK:
                job = JOBS.get(parsed.path.rsplit("/", 1)[-1])
                self.json_response(job or {"status": "missing"}, 404 if not job else 200)
        elif parsed.path.startswith("/api/waveform/"):
            image = WAVEFORM_FILES.get(parsed.path.rsplit("/", 1)[-1])
            if not image or not image.is_file():
                self.send_error(404)
                return
            body = image.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path.startswith("/api/audio/"):
            audio = AUDIO_FILES.get(parsed.path.rsplit("/", 1)[-1])
            if not audio or not audio.is_file():
                self.send_error(404)
                return
            self.stream_audio(audio)
        else:
            super().do_GET()

    def do_HEAD(self) -> None:
        mark_client_activity()
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/audio/"):
            audio = AUDIO_FILES.get(parsed.path.rsplit("/", 1)[-1])
            if not audio or not audio.is_file():
                self.send_error(404)
                return
            self.stream_audio(audio, send_body=False)
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        try:
            mark_client_activity()
            data = self.read_json()
            if self.path == "/api/convert":
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "progress": 0, "progressLabel": "等待开始"}
                threading.Thread(target=convert_job, args=(job_id, data), daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/heartbeat":
                self.json_response({"ok": True})
            elif self.path == "/api/waveforms":
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "preview": None, "progress": 0, "progressLabel": "等待开始"}
                threading.Thread(target=waveform_job, args=(job_id, data["source"], data.get("language", "zh")), daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/dependencies":
                action = data.get("action")
                if action not in {"install", "uninstall"}:
                    raise ValueError("无效的依赖操作。")
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "progress": 0, "progressLabel": "等待开始"}
                def dependencies():
                    code = run_process(job_id, ["/bin/bash", str(SCRIPTS / f"{action}_dependencies.sh")], ROOT)
                    with JOBS_LOCK:
                        JOBS[job_id]["status"] = "done" if code == 0 else "error"
                threading.Thread(target=dependencies, daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/select-folder":
                # This is intentionally macOS-only. The server is bound to 127.0.0.1.
                prompt = "Select the folder containing audio tracks" if data.get("language") == "en" else "选择包含多轨音频的歌曲文件夹"
                # Do not JSON-escape this string: AppleScript does not interpret \uXXXX escapes.
                apple_prompt = prompt.replace('"', '\\"')
                result = subprocess.run(["/usr/bin/osascript", "-e", f"POSIX path of (choose folder with prompt \"{apple_prompt}\")"],
                                        capture_output=True, text=True)
                if result.returncode != 0:
                    self.json_response({"cancelled": True, "error": result.stderr.strip()})
                else:
                    self.json_response({"path": result.stdout.strip()})
            elif self.path == "/api/open-folder":
                folder = Path(data["path"]).expanduser().resolve()
                if not folder.is_dir():
                    raise ValueError("文件夹不存在。")
                subprocess.Popen(["/usr/bin/open", str(folder)])
                self.json_response({"ok": True})
            else:
                self.json_response({"error": "Not found"}, 404)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)


if __name__ == "__main__":
    port = 8765
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Multitrack Audio Exporter is running at http://127.0.0.1:{port}")
    threading.Thread(target=idle_shutdown_monitor, args=(httpd,), daemon=True).start()
    httpd.serve_forever()
