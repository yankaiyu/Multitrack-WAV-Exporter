#!/usr/bin/env python3
"""Local web UI and conversion backend for multitrack WAV exports."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
SCRIPTS = ROOT / "scripts"
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAC_BIN_DIRS = [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]


def tool_path(name: str) -> str | None:
    """Find tools installed by Homebrew, pipx, or normally available on PATH."""
    candidates = [shutil.which(name), *(str(folder / name) for folder in MAC_BIN_DIRS)]
    for item in candidates:
        if item and Path(item).is_file() and os.access(item, os.X_OK):
            return item
    return None


def append_log(job_id: str, line: str) -> None:
    with JOBS_LOCK:
        JOBS[job_id]["log"] += line


def run_process(job_id: str, command: list[str], cwd: Path | None = None) -> int:
    env = os.environ.copy()
    env["PATH"] = ":".join([str(Path.home() / ".local/bin"), *(str(folder) for folder in MAC_BIN_DIRS), env.get("PATH", "")])
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1, env=env)
    assert process.stdout
    for line in process.stdout:
        append_log(job_id, line)
    return process.wait()


def peak_of_audio(path: Path) -> float | None:
    """Return decoded sample peak in dBFS. Lower is quieter; 0 is full scale."""
    ffmpeg = tool_path("ffmpeg")
    if not ffmpeg:
        return None
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
                            capture_output=True, text=True)
    match = re.search(r"max_volume:\s*([-+\d.]+)\s*dB", result.stderr)
    return float(match.group(1)) if match else None


def peak_of_mp3(path: Path) -> float | None:
    return peak_of_audio(path)


def sanitized_inputs(job_id: str, files: list[Path], workspace: Path,
                     silence_threshold: float) -> tuple[dict[Path, Path], set[Path]]:
    """Make finite 32-bit float working WAVs and identify blank input channels.

    Some float recorders write NaN/Inf samples in unused channels. Those samples make
    peak analyzers return NaN/Inf and can crash lossy encoders, so never pass them on.
    """
    ffmpeg = tool_path("ffmpeg")
    ffprobe = tool_path("ffprobe")
    if not ffmpeg or not ffprobe:
        raise ValueError("找不到 FFmpeg / FFprobe，请先安装依赖。")
    finite: dict[Path, Path] = {}
    blank: set[Path] = set()
    for source in files:
        probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                                "-of", "default=nokey=1:noprint_wrappers=1", str(source)], capture_output=True, text=True)
        try:
            channels = int(probe.stdout.strip())
        except ValueError:
            raise RuntimeError(f"无法读取声道数：{source.name}")
        expressions = "|".join(f"if(isnan(val({channel}))+isinf(val({channel})),0,val({channel}))" for channel in range(channels))
        cleaned = workspace / source.name
        command = [ffmpeg, "-hide_banner", "-y", "-i", str(source), "-af", f"aeval=exprs='{expressions}':c=same",
                   "-c:a", "pcm_f32le", str(cleaned)]
        if run_process(job_id, command) != 0:
            raise RuntimeError(f"无法清洗浮点样本：{source.name}")
        finite[source] = cleaned
        peak = peak_of_audio(cleaned)
        # Unused float channels can contain low-level numeric residue. Do not raise
        # that residue to full scale: only material above the user-set threshold is active.
        if peak is None or peak <= silence_threshold:
            blank.add(source)
            append_log(job_id, f"{source.name} 峰值 {peak if peak is not None else '未知'} dBFS，低于无输入阈值 {silence_threshold:.0f} dBFS：仅转 MP3，不归一化。\n")
    return finite, blank


def encode_mp3(job_id: str, ffmpeg: str, input_file: Path, output_file: Path, bitrate: int,
               sample_rate: int | None, gain_db: float | None = None) -> None:
    command = [ffmpeg, "-y", "-i", str(input_file)]
    if gain_db is not None:
        command += ["-af", f"volume={gain_db:.4f}dB"]
    command += ["-c:a", "libmp3lame", "-b:a", f"{bitrate}k"]
    if sample_rate:
        command += ["-ar", str(sample_rate)]
    command.append(str(output_file))
    if run_process(job_id, command) != 0:
        raise RuntimeError(f"转换失败：{input_file.name}")


def convert_job(job_id: str, options: dict) -> None:
    try:
        source = Path(options["source"]).expanduser().resolve()
        if not source.is_dir():
            raise ValueError("源文件夹不存在。")
        files = sorted([p for p in source.iterdir() if p.is_file() and p.suffix.lower() == ".wav"])
        if not files:
            raise ValueError("该文件夹中没有 WAV 文件。")
        mode = options["mode"]
        bitrate = int(options["bitrate"])
        sample_rate = options.get("sampleRate")
        sample_rate = int(sample_rate) if sample_rate else None
        ceiling = float(options["ceiling"])
        silence_threshold = float(options.get("silenceThreshold", "-40"))
        output = source / "normalized_mp3"
        output.mkdir(exist_ok=True)
        append_log(job_id, f"发现 {len(files)} 个 WAV，输出：{output}\n")

        ffmpeg = tool_path("ffmpeg")
        if not ffmpeg:
            raise ValueError("找不到 FFmpeg，请先安装依赖。")
        with tempfile.TemporaryDirectory(prefix="multitrack-wav-export-") as temp:
            cleaned, blank = sanitized_inputs(job_id, files, Path(temp), silence_threshold)
            active = [file for file in files if file not in blank]
            # Empty recorder channels are still included in the share package, but they stay silent.
            for file in blank:
                encode_mp3(job_id, ffmpeg, cleaned[file], output / f"{file.stem}.mp3", bitrate, sample_rate)

            if mode == "convert":
                target = ceiling - 0.2
                for file in active:
                    output_file = output / f"{file.stem}.mp3"
                    input_peak = peak_of_audio(cleaned[file])
                    if input_peak is None:
                        raise RuntimeError(f"无法测量清洗后轨道的峰值：{file.name}")
                    # Keep the original level unless the float source already exceeds the
                    # output ceiling. Measuring before MP3 encoding avoids hidden clipping.
                    gain = min(0.0, target - input_peak)
                    encode_mp3(job_id, ffmpeg, cleaned[file], output_file, bitrate, sample_rate, gain)
                    for _ in range(3):
                        peak = peak_of_mp3(output_file)
                        if peak is None or peak <= ceiling:
                            break
                        attenuation = (peak - ceiling) + 0.2
                        append_log(job_id, f"{file.name} 编码后峰值 {peak:.2f} dBFS，降低 {attenuation:.2f} dB 后重编码。\n")
                        gain -= attenuation
                        encode_mp3(job_id, ffmpeg, cleaned[file], output_file, bitrate, sample_rate, gain)
                    else:
                        raise RuntimeError(f"无法让 {file.name} 满足安全峰值上限。")
            elif active:
                # ffmpeg-normalize's peak scanner can mis-handle NaN-bearing float WAVs.
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
                    for file in active:
                        encode_mp3(job_id, ffmpeg, cleaned[file], output / f"{file.stem}.mp3", bitrate, sample_rate, gains[file])
                    measured = {file: peak_of_mp3(output / f"{file.stem}.mp3") for file in active}
                    overs = {file: peak - ceiling for file, peak in measured.items() if peak is not None and peak > ceiling}
                    append_log(job_id, "编码后峰值：" + ", ".join(f"{file.name} {peak:.2f} dBFS" for file, peak in measured.items() if peak is not None) + "\n")
                    if not overs:
                        break
                    if mode == "preserve":
                        reduction = max(overs.values()) + 0.2
                        gains = {file: gain - reduction for file, gain in gains.items()}
                    else:
                        for file, amount in overs.items():
                            gains[file] -= amount + 0.2
                    append_log(job_id, "峰值高于安全上限，降低增益后从清洗 WAV 重编码。\n")
                else:
                    raise RuntimeError("三次安全验证后仍无法满足输出峰值上限。")

        # Final report is intentionally based on the generated MP3 rather than the source WAV.
        final_peaks = {p.name: peak_of_mp3(output / f"{p.stem}.mp3") for p in files}
        failed = [name for name, peak in final_peaks.items() if peak is not None and peak > ceiling]
        if failed:
            raise RuntimeError("最终安全验证失败：" + "、".join(failed))
        append_log(job_id, "最终 MP3 峰值验证通过。\n")
        zip_path = None
        if options.get("packageZip"):
            zip_path = shutil.make_archive(str(source / f"{source.name}_normalized_mp3"), "zip", root_dir=output)
            append_log(job_id, f"已创建分享 ZIP：{zip_path}\n")

        with JOBS_LOCK:
            JOBS[job_id].update(status="done", output=str(output), zip=zip_path)
    except Exception as error:
        append_log(job_id, f"\n错误：{error}\n")
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"


class Handler(SimpleHTTPRequestHandler):
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

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self.json_response({"ffmpeg": bool(tool_path("ffmpeg"))})
        elif parsed.path.startswith("/api/job/"):
            with JOBS_LOCK:
                job = JOBS.get(parsed.path.rsplit("/", 1)[-1])
                self.json_response(job or {"status": "missing"}, 404 if not job else 200)
        else:
            super().do_GET()

    def do_POST(self) -> None:
        try:
            data = self.read_json()
            if self.path == "/api/convert":
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None}
                threading.Thread(target=convert_job, args=(job_id, data), daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/dependencies":
                action = data.get("action")
                if action not in {"install", "uninstall"}:
                    raise ValueError("无效的依赖操作。")
                job_id = uuid.uuid4().hex
                with JOBS_LOCK:
                    JOBS[job_id] = {"status": "running", "log": "", "output": None}
                def dependencies():
                    code = run_process(job_id, ["/bin/bash", str(SCRIPTS / f"{action}_dependencies.sh")], ROOT)
                    with JOBS_LOCK:
                        JOBS[job_id]["status"] = "done" if code == 0 else "error"
                threading.Thread(target=dependencies, daemon=True).start()
                self.json_response({"job": job_id})
            elif self.path == "/api/select-folder":
                # This is intentionally macOS-only. The server is bound to 127.0.0.1.
                prompt = "Select the folder containing WAV tracks" if data.get("language") == "en" else "选择包含 WAV 多轨的歌曲文件夹"
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
    print(f"Multitrack WAV Exporter is running at http://127.0.0.1:{port}")
    httpd.serve_forever()
