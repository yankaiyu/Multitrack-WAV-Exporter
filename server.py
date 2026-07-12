#!/usr/bin/env python3
"""Local web UI and conversion backend for multitrack audio exports."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import uuid
import zipfile
from collections import defaultdict
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from audio_tools import (AUDIO_CONTENT_TYPES, INPUT_EXTENSIONS, MAC_BIN_DIRS, OUTPUT_FORMATS,
                         WAV_CODECS, parallel_map, peak_of_audio, peak_of_mp3, tool_path)

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
LOCALES_ROOT = WEB_ROOT / "locales"
SCRIPTS = ROOT / "scripts"
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
WAVEFORM_FILES: dict[str, Path] = {}
AUDIO_FILES: dict[str, Path] = {}
WAVEFORM_RENDER_VERSION = "v2"
SOURCE_LOCKS: dict[str, threading.Lock] = {}
SOURCE_LOCKS_LOCK = threading.Lock()
LOCALE_CACHE: dict[str, dict[str, str]] = {}


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


def localized(language: str | None, key: str, **values: object) -> str:
    """Format a user-facing server message from the same locale files as the UI."""
    code = language or "en"
    if code not in LOCALE_CACHE:
        LOCALE_CACHE[code] = load_locale(code)
    template = LOCALE_CACHE[code].get(key) or LOCALE_CACHE.get("en", {}).get(key) or key
    return template.format_map(defaultdict(str, values))


def load_locale(code: str, seen: set[str] | None = None) -> dict[str, str]:
    """Load a locale and recursively merge its optional base locale."""
    seen = seen or set()
    if code in seen:
        return {}
    seen.add(code)
    try:
        with (LOCALES_ROOT / f"{code}.json").open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    merged = load_locale(data["base"], seen) if data.get("base") else {}
    merged.update(data.get("overrides", data))
    return merged


def job_language(job_id: str) -> str:
    with JOBS_LOCK:
        return JOBS.get(job_id, {}).get("language", "en")


def append_localized_log(job_id: str, key: str, **values: object) -> None:
    append_log(job_id, localized(job_language(job_id), key, **values))


def set_localized_progress(job_id: str, value: int, key: str, **values: object) -> None:
    set_progress(job_id, value, localized(job_language(job_id), key, **values))


def append_log(job_id: str, line: str) -> None:
    with JOBS_LOCK:
        JOBS[job_id]["log"] += line


def set_progress(job_id: str, value: int, label: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job["progress"] = max(0, min(100, value))
            job["progressLabel"] = label


def source_lock(source: Path) -> threading.Lock:
    """Return a stable lock so two browser tasks cannot write one output folder."""
    key = str(source.resolve())
    with SOURCE_LOCKS_LOCK:
        return SOURCE_LOCKS.setdefault(key, threading.Lock())


def run_process(job_id: str, command: list[str], cwd: Path | None = None) -> int:
    env = os.environ.copy()
    env["PATH"] = ":".join([str(Path.home() / ".local/bin"), *(str(folder) for folder in MAC_BIN_DIRS), env.get("PATH", "")])
    try:
        process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, bufsize=1, env=env)
    except FileNotFoundError as error:
        raise RuntimeError(localized(job_language(job_id), "couldNotStartProgram", program=command[0] if command else "?")) from error
    assert process.stdout
    with process.stdout:
        for line in process.stdout:
            append_log(job_id, line)
    return process.wait()


def audio_channel_count(path: Path, language: str = "en") -> int:
    ffprobe = tool_path("ffprobe")
    if not ffprobe:
        raise ValueError(localized(language, "missingFfmpegProbe"))
    result = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                             "-of", "default=nokey=1:noprint_wrappers=1", str(path)], capture_output=True, text=True)
    try:
        return int(result.stdout.strip())
    except ValueError as error:
        raise RuntimeError(localized(language, "couldNotReadChannels", file=path.name)) from error


def split_stereo_sources(job_id: str, files: list[Path], workspace: Path, enabled: bool) -> list[Path]:
    """Create temporary mono sources for stereo files when independent tracks are enabled."""
    if not enabled:
        return files
    ffmpeg = tool_path("ffmpeg")
    if not ffmpeg:
        raise ValueError(localized(job_language(job_id), "missingFfmpeg"))
    workspace.mkdir(parents=True, exist_ok=True)
    expanded: list[Path] = []
    for source in files:
        if audio_channel_count(source, job_language(job_id)) != 2:
            expanded.append(source)
            continue
        for channel, suffix in enumerate(("L", "R")):
            mono = workspace / f"{source.stem}_{suffix}.wav"
            command = [ffmpeg, "-hide_banner", "-y", "-i", str(source), "-af", f"pan=mono|c0=c{channel}",
                       "-c:a", "pcm_f32le", str(mono)]
            if run_process(job_id, command) != 0:
                raise RuntimeError(localized(job_language(job_id), "couldNotSplitStereo", file=source.name))
            expanded.append(mono)
    return expanded


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
        raise ValueError(localized(job_language(job_id), "missingFfmpegProbe"))
    workspace.mkdir(parents=True, exist_ok=True)
    track_trims = track_trims or {}
    def sanitize_one(source: Path) -> tuple[Path, Path, float | None]:
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                                "-of", "default=nokey=1:noprint_wrappers=1", str(source)], capture_output=True, text=True)
        try:
            channels = int(probe.stdout.strip())
        except ValueError:
            raise RuntimeError(localized(job_language(job_id), "couldNotReadChannels", file=source.name))
        expressions = "|".join(f"if(isnan(val({channel}))+isinf(val({channel})),0,val({channel}))" for channel in range(channels))
        # Working files are always WAV. Retaining an MP3/M4A input extension here
        # would make FFmpeg select the wrong container for float PCM.
        cleaned = workspace / f"{uuid.uuid4().hex}.wav"
        per_track = track_trims.get(source.name, {})
        source_start = float(per_track.get("start", trim_start))
        raw_end = per_track.get("end", trim_end)
        source_end = float(raw_end) if raw_end not in (None, "") else None
        if source_start < 0 or (source_end is not None and source_end <= source_start):
            raise ValueError(localized(job_language(job_id), "trimEndMustFollowStart", file=source.name))
        trim = f"atrim=start={source_start}" + (f":end={source_end}" if source_end is not None else "")
        command = [ffmpeg, "-hide_banner", "-y", "-i", str(source), "-af", f"{trim},aeval=exprs='{expressions}':c=same",
                   "-c:a", "pcm_f32le", str(cleaned)]
        if run_process(job_id, command) != 0:
            raise RuntimeError(localized(job_language(job_id), "couldNotSanitizeFloat", file=source.name))
        return source, cleaned, peak_of_audio(cleaned)

    finite: dict[Path, Path] = {}
    blank: set[Path] = set()
    for source, cleaned, peak in parallel_map(files, workers, sanitize_one):
        finite[source] = cleaned
        # Unused float channels can contain low-level numeric residue. Do not raise
        # that residue to full scale: only material above the user-set threshold is active.
        if peak is None or peak <= silence_threshold:
            blank.add(source)
            append_localized_log(job_id, "silentTrackConverted", file=source.name,
                                 peak=peak if peak is not None else localized(job_language(job_id), "unknown"),
                                 threshold=f"{silence_threshold:.0f}")
    return finite, blank


def waveform_job(job_id: str, source_text: str, language: str = "zh", split_stereo: bool = False) -> None:
    """Generate compact cached waveform PNGs for the trimming UI."""
    try:
        source = Path(source_text).expanduser().resolve()
        files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() in INPUT_EXTENSIONS)
        ffmpeg, ffprobe = tool_path("ffmpeg"), tool_path("ffprobe")
        if not files:
            raise ValueError(localized(language, "noSupportedAudioFiles"))
        if not ffmpeg or not ffprobe:
            raise ValueError(localized(language, "missingFfmpegProbe"))
        cache = source / ".multitrack-audio-exporter-preview"
        cache.mkdir(exist_ok=True)
        preview_files: list[Path] = []
        for file in files:
            if split_stereo and audio_channel_count(file, language) == 2:
                for channel, suffix in enumerate(("L", "R")):
                    mono = cache / f"{file.stem}_{suffix}.wav"
                    if not mono.exists() or mono.stat().st_mtime_ns < file.stat().st_mtime_ns:
                        command = [ffmpeg, "-hide_banner", "-y", "-i", str(file), "-af", f"pan=mono|c0=c{channel}",
                                   "-c:a", "pcm_f32le", str(mono)]
                        if run_process(job_id, command) != 0:
                            raise RuntimeError(localized(language, "couldNotSplitStereo", file=file.name))
                    preview_files.append(mono)
            else:
                preview_files.append(file)
        previews = []
        for index, file in enumerate(preview_files):
            probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                                    "-of", "default=nokey=1:noprint_wrappers=1", str(file)], capture_output=True, text=True)
            channels = int(probe.stdout.strip())
            duration_result = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                              "-of", "default=nokey=1:noprint_wrappers=1", str(file)], capture_output=True, text=True)
            duration = float(duration_result.stdout.strip())
            image = cache / f"{WAVEFORM_RENDER_VERSION}-{file.name}.png"
            # Regenerate only when the source changed. The aeval stage removes non-finite
            # float samples before showwavespic draws the visual preview.
            if not image.exists() or image.stat().st_mtime_ns < file.stat().st_mtime_ns:
                expressions = "|".join(f"if(isnan(val({channel}))+isinf(val({channel})),0,val({channel}))" for channel in range(channels))
                channel_layout = ":split_channels=1" if channels == 2 else ""
                filter_graph = f"[0:a]aeval=exprs='{expressions}':c=same,showwavespic=s=1400x128:colors=0xD2F26C{channel_layout}[wave]"
                temporary_image = cache / f".{file.stem}.{uuid.uuid4().hex}.png"
                command = [ffmpeg, "-hide_banner", "-y", "-i", str(file), "-filter_complex", filter_graph,
                           "-map", "[wave]", "-frames:v", "1", str(temporary_image)]
                if run_process(job_id, command) != 0:
                    raise RuntimeError(localized(language, "couldNotGenerateWaveform", file=file.name))
                os.replace(temporary_image, image)
            token = uuid.uuid4().hex
            WAVEFORM_FILES[token] = image
            audio_token = uuid.uuid4().hex
            AUDIO_FILES[audio_token] = file
            # Use the same peak measurement used by export decisions, so the UI can
            # optionally deselect tracks below its empty-track threshold.
            previews.append({"name": file.name, "duration": duration, "peak": peak_of_audio(file), "stereo": channels == 2,
                             "image": f"/api/waveform/{token}", "audio": f"/api/audio/{audio_token}"})
            append_localized_log(job_id, "waveformProgress", current=index + 1, total=len(files), file=file.name)
            set_localized_progress(job_id, round((index + 1) / len(files) * 100), "generatingWaveforms", current=index + 1, total=len(files))
        with JOBS_LOCK:
            JOBS[job_id].update(status="done", preview=previews)
    except Exception as error:
        append_localized_log(job_id, "errorLog", error=error)
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
        raise RuntimeError(localized(job_language(job_id), "conversionFailed", file=input_file.name))


def convert_job(job_id: str, options: dict) -> None:
    """Serialize jobs targeting the same source folder while allowing other folders through."""
    try:
        lock = source_lock(Path(options["source"]).expanduser())
    except (KeyError, TypeError):
        _convert_job(job_id, options)
        return
    if not lock.acquire(blocking=False):
        append_localized_log(job_id, "waitingForSourceLock")
        lock.acquire()
    try:
        _convert_job(job_id, options)
    finally:
        lock.release()


def _convert_job(job_id: str, options: dict) -> None:
    split_workspace = None
    try:
        source = Path(options["source"]).expanduser().resolve()
        if not source.is_dir():
            raise ValueError(localized(job_language(job_id), "sourceFolderMissing"))
        files = sorted([p for p in source.iterdir() if p.is_file() and p.suffix.lower() in INPUT_EXTENSIONS])
        if not files:
            raise ValueError(localized(job_language(job_id), "noSupportedAudioFiles"))
        split_stereo = options.get("splitStereo") in {True, "on", "true", "1"}
        if split_stereo:
            split_workspace = tempfile.TemporaryDirectory(prefix="multitrack-audio-split-")
            files = split_stereo_sources(job_id, files, Path(split_workspace.name), True)
        selected = options.get("selectedFiles")
        if selected is not None:
            if isinstance(selected, str):
                selected = [selected]
            selected_names = set(selected)
            files = [file for file in files if file.name in selected_names]
            if not files:
                raise ValueError(localized(job_language(job_id), "selectAtLeastOneTrack"))
        mode = options["mode"]
        output_format = options.get("outputFormat", "mp3")
        if output_format not in OUTPUT_FORMATS:
            raise ValueError(localized(job_language(job_id), "invalidOutputFormat"))
        wav_depth = options.get("wavDepth", "float32")
        if wav_depth not in WAV_CODECS:
            raise ValueError(localized(job_language(job_id), "invalidWavDepth"))
        bitrate = int(options["bitrate"])
        sample_rate = options.get("sampleRate")
        sample_rate = int(sample_rate) if sample_rate else None
        ceiling = float(options["ceiling"])
        silence_threshold = float(options.get("silenceThreshold", "-40"))
        workers = int(options.get("workers", "2"))
        if workers not in {1, 2, 4}:
            raise ValueError(localized(job_language(job_id), "invalidWorkers"))
        trim_start = float(options.get("trimStart") or 0)
        trim_end = float(options["trimEnd"]) if options.get("trimEnd") else None
        track_trims = options.get("trackTrims") or {}
        if not isinstance(track_trims, dict):
            raise ValueError(localized(job_language(job_id), "invalidTrackTrims"))
        if trim_start < 0 or (trim_end is not None and trim_end <= trim_start):
            raise ValueError(localized(job_language(job_id), "trimEndMustFollowStart"))
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
        append_localized_log(job_id, "convertingFiles", count=len(files), output=output)
        set_localized_progress(job_id, 2, "preparingTracks", count=len(files))

        ffmpeg = tool_path("ffmpeg")
        if not ffmpeg:
            raise ValueError(localized(job_language(job_id), "missingFfmpeg"))
        with tempfile.TemporaryDirectory(prefix="multitrack-audio-export-") as temp:
            set_localized_progress(job_id, 5, "sanitizingAndMeasuring")
            cleaned, blank = sanitized_inputs(job_id, files, Path(temp), silence_threshold, trim_start, trim_end, workers, track_trims)
            set_localized_progress(job_id, 20, "sanitizingComplete")
            active = [file for file in files if file not in blank]
            # Empty recorder channels are still included in the share package, but they stay silent.
            completed = 0
            completed_lock = threading.Lock()
            total_tracks = len(files)

            def mark_encoded(file: Path) -> None:
                nonlocal completed
                with completed_lock:
                    completed += 1
                    set_localized_progress(job_id, 20 + round(65 * completed / total_tracks), "encodedTracks", current=completed, total=total_tracks)

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
                        raise RuntimeError(localized(job_language(job_id), "couldNotMeasurePeak", file=file.name))
                    # Keep the original level unless the float source already exceeds the
                    # output ceiling. Measuring before encoding avoids hidden clipping.
                    gain = min(0.0, target - input_peak)
                    encode_audio(job_id, ffmpeg, cleaned[file], output_file, output_format, bitrate, wav_depth, sample_rate, gain)
                    for _ in range(3):
                        peak = peak_of_mp3(output_file)
                        if peak is None or peak <= ceiling:
                            break
                        attenuation = (peak - ceiling) + 0.2
                        append_localized_log(job_id, "reencodingForPeak", file=file.name, peak=f"{peak:.2f}", attenuation=f"{attenuation:.2f}")
                        gain -= attenuation
                        encode_audio(job_id, ffmpeg, cleaned[file], output_file, output_format, bitrate, wav_depth, sample_rate, gain)
                    else:
                        raise RuntimeError(localized(job_language(job_id), "couldNotMeetCeiling", file=file.name))
                    mark_encoded(file)
                parallel_map(active, workers, convert_safely)
            elif active:
                # Peak scanners can mis-handle NaN-bearing float WAVs.
                # Measure the cleaned PCM with FFmpeg itself and apply a deterministic linear gain.
                target = ceiling - 0.2
                input_peaks = {file: peak_of_audio(cleaned[file]) for file in active}
                if any(peak is None for peak in input_peaks.values()):
                    raise RuntimeError(localized(job_language(job_id), "couldNotMeasurePeak"))
                if mode == "preserve":
                    common_gain = target - max(input_peaks.values())
                    gains = {file: common_gain for file in active}
                else:
                    gains = {file: target - input_peaks[file] for file in active}
                append_localized_log(job_id, "normalizationGains", gains=", ".join(f"{file.name} {gain:+.2f} dB" for file, gain in gains.items()))
                for _ in range(3):
                    def encode_normalized(file: Path) -> None:
                        encode_audio(job_id, ffmpeg, cleaned[file], output_files[file], output_format, bitrate, wav_depth, sample_rate, gains[file])
                        mark_encoded(file)
                    parallel_map(active, workers, encode_normalized)
                    measured = dict(parallel_map(active, workers, lambda file: (file, peak_of_audio(output_files[file]))))
                    overs = {file: peak - ceiling for file, peak in measured.items() if peak is not None and peak > ceiling}
                    append_localized_log(job_id, "encodedPeaks", peaks=", ".join(f"{file.name} {peak:.2f} dBFS" for file, peak in measured.items() if peak is not None))
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
                    append_localized_log(job_id, "retryingForCeiling")
                else:
                    raise RuntimeError(localized(job_language(job_id), "couldNotMeetCeilingAfterRetries"))

        # Final report is intentionally based on generated files rather than sources.
        set_localized_progress(job_id, 90, "verifyingFinalPeaks")
        final_peaks = {p.name: peak_of_audio(output_files[p]) for p in files}
        failed = [name for name, peak in final_peaks.items() if peak is not None and peak > ceiling]
        if failed:
            raise RuntimeError(localized(job_language(job_id), "finalPeakVerificationFailed", files=", ".join(failed)))
        append_localized_log(job_id, "finalPeakVerificationPassed")
        zip_path = None
        if options.get("packageZip"):
            set_localized_progress(job_id, 96, "creatingZip")
            zip_path = str(source / f"{source.name}_normalized_audio.zip")
            # Package only tracks selected for this job, never stale prior exports.
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for source_file in files:
                    exported = output_files[source_file]
                    if exported.is_file():
                        archive.write(exported, exported.name)
            append_localized_log(job_id, "zipCreated", path=zip_path)

        done_label = localized(job_language(job_id), "done")
        if split_workspace:
            split_workspace.cleanup()
        with JOBS_LOCK:
            JOBS[job_id].update(status="done", output=str(output), zip=zip_path, progress=100, progressLabel=done_label)
    except Exception as error:
        if split_workspace:
            split_workspace.cleanup()
        append_localized_log(job_id, "errorLog", error=error)
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
            data = self.read_json()
            if self.path == "/api/convert":
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "progress": 0,
                                    "progressLabel": localized(data.get("language"), "waitingToStart"), "language": data.get("language", "en")}
                threading.Thread(target=convert_job, args=(job_id, data), daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/waveforms":
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "preview": None, "progress": 0,
                                    "progressLabel": localized(data.get("language"), "waitingToStart"), "language": data.get("language", "en")}
                threading.Thread(target=waveform_job, args=(job_id, data["source"], data.get("language", "zh"),
                                                             data.get("splitStereo") in {True, "on", "true", "1"}), daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/dependencies":
                action = data.get("action")
                if action not in {"install", "uninstall"}:
                    raise ValueError(localized(data.get("language"), "invalidDependencyAction"))
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None, "progress": 0,
                                    "progressLabel": localized(data.get("language"), "waitingToStart"), "language": data.get("language", "en")}
                def dependencies():
                    code = run_process(job_id, ["/bin/bash", str(SCRIPTS / f"{action}_dependencies.sh")], ROOT)
                    with JOBS_LOCK:
                        JOBS[job_id]["status"] = "done" if code == 0 else "error"
                threading.Thread(target=dependencies, daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/select-folder":
                # This is intentionally macOS-only. The server is bound to 127.0.0.1.
                prompt = localized(data.get("language"), "selectSourceFolderPrompt")
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
                    raise ValueError(localized(data.get("language"), "folderMissing"))
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
    httpd.serve_forever()
