"""FFmpeg-oriented audio primitives shared by conversion and waveform jobs."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

MAC_BIN_DIRS = [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
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
    # volumedetect clamps at 0 dBFS, while float WAV samples can legitimately exceed it.
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path), "-af", "astats=metadata=0:reset=0", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    levels = []
    for value in re.findall(r"Peak level dB:\s*([-+\d.]+|-inf|inf)", result.stderr):
        try:
            level = float(value)
            if level not in {float("inf"), float("-inf")}:
                levels.append(level)
        except ValueError:
            continue
    return max(levels) if levels else None


def peak_of_mp3(path: Path) -> float | None:
    """Compatibility name for final lossy-output peak verification."""
    return peak_of_audio(path)
