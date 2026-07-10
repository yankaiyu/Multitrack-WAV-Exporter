#!/usr/bin/env python3
"""Local web UI and conversion backend for multitrack WAV exports."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
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
    if name == "ffmpeg-normalize":
        candidates += [str(Path.home() / ".local/bin" / name), str(Path.home() / ".local/pipx/venvs/ffmpeg-normalize/bin" / name)]
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


def peak_of_mp3(path: Path) -> float | None:
    """Return decoded sample peak in dBFS. Lower is quieter; 0 is full scale."""
    ffmpeg = tool_path("ffmpeg")
    if not ffmpeg:
        return None
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
                            capture_output=True, text=True)
    match = re.search(r"max_volume:\s*([-+\d.]+)\s*dB", result.stderr)
    return float(match.group(1)) if match else None


def normalize_command(files: list[Path], output: Path, mode: str, target: float, bitrate: int,
                      sample_rate: int | None) -> list[str]:
    normalize = tool_path("ffmpeg-normalize")
    command = [normalize or "ffmpeg-normalize", *map(str, files), "-nt", "peak", "-t", str(target),
               "-c:a", "libmp3lame", "-b:a", f"{bitrate}k", "-ext", "mp3", "-of", str(output), "-f"]
    if mode == "preserve":
        command.append("--batch")
    if sample_rate:
        command += ["-ar", str(sample_rate)]
    return command


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
        output = source / "normalized_mp3"
        output.mkdir(exist_ok=True)
        append_log(job_id, f"发现 {len(files)} 个 WAV，输出：{output}\n")

        if mode == "convert":
            ffmpeg = tool_path("ffmpeg")
            if not ffmpeg:
                raise ValueError("找不到 FFmpeg，请先安装依赖。")
            for file in files:
                out = output / f"{file.stem}.mp3"
                command = [ffmpeg, "-y", "-i", str(file), "-c:a", "libmp3lame", "-b:a", f"{bitrate}k"]
                if sample_rate:
                    command += ["-ar", str(sample_rate)]
                command.append(str(out))
                if run_process(job_id, command) != 0:
                    raise RuntimeError(f"转换失败：{file.name}")
            # Conversion without normalization still must respect the requested output ceiling.
            # Only files which exceed it are re-encoded from the WAV with attenuation applied.
            for file in files:
                output_file = output / f"{file.stem}.mp3"
                for _ in range(3):
                    peak = peak_of_mp3(output_file)
                    if peak is None or peak <= ceiling:
                        break
                    attenuation = (peak - ceiling) + 0.2
                    append_log(job_id, f"{file.name} 编码后峰值 {peak:.2f} dBFS，降低 {attenuation:.2f} dB 后重编码。\n")
                    command = [ffmpeg, "-y", "-i", str(file), "-af", f"volume=-{attenuation:.4f}dB",
                               "-c:a", "libmp3lame", "-b:a", f"{bitrate}k"]
                    if sample_rate:
                        command += ["-ar", str(sample_rate)]
                    command.append(str(output_file))
                    if run_process(job_id, command) != 0:
                        raise RuntimeError(f"安全重编码失败：{file.name}")
                else:
                    raise RuntimeError(f"无法让 {file.name} 满足安全峰值上限。")
        else:
            if not tool_path("ffmpeg-normalize"):
                raise ValueError("找不到 ffmpeg-normalize，请先安装依赖。")
            # A small safety margin is used before validation. If encoding raises the decoded peak,
            # retry the original WAV(s) with a lower target rather than re-encoding an MP3.
            target = ceiling - 0.2
            for attempt in range(3):
                if mode == "preserve":
                    code = run_process(job_id, normalize_command(files, output, mode, target, bitrate, sample_rate))
                    if code != 0:
                        raise RuntimeError("归一化失败。")
                else:
                    for file in files:
                        if run_process(job_id, normalize_command([file], output, mode, target, bitrate, sample_rate)) != 0:
                            raise RuntimeError(f"归一化失败：{file.name}")
                measured = {p.name: peak_of_mp3(output / f"{p.stem}.mp3") for p in files}
                peaks = [value for value in measured.values() if value is not None]
                worst = max(peaks) if peaks else None
                append_log(job_id, "编码后峰值：" + ", ".join(f"{name} {value:.2f} dBFS" for name, value in measured.items() if value is not None) + "\n")
                if worst is None or worst <= ceiling:
                    break
                target -= (worst - ceiling) + 0.2
                append_log(job_id, f"峰值高于设定上限，使用原始 WAV 降低目标后重试（{target:.2f} dBFS）。\n")
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
            self.json_response({"ffmpeg": bool(tool_path("ffmpeg")), "normalize": bool(tool_path("ffmpeg-normalize"))})
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
                result = subprocess.run(["/usr/bin/osascript", "-e", f"POSIX path of (choose folder with prompt {json.dumps(prompt)})"],
                                        capture_output=True, text=True)
                if result.returncode != 0:
                    self.json_response({"cancelled": True})
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
    print(f"Multitrack WAV Exporter is running at http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
