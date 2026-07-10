"""Synthetic, privacy-safe tests for the 32-bit float WAV export pipeline."""

from __future__ import annotations

import math
import struct
import tempfile
import unittest
from pathlib import Path

import server


def write_float_wav(path: Path, values: list[float], sample_rate: int = 48_000) -> None:
    """Write a mono IEEE-float WAV without relying on a real recording."""
    data = struct.pack(f"<{len(values)}f", *values)
    fmt = struct.pack("<HHIIHH", 3, 1, sample_rate, sample_rate * 4, 4, 32)
    path.write_bytes(b"RIFF" + struct.pack("<I", 4 + (8 + len(fmt)) + (8 + len(data))) + b"WAVE"
                     + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data)


@unittest.skipUnless(server.tool_path("ffmpeg") and server.tool_path("ffprobe"), "FFmpeg and FFprobe are required")
class FloatAudioPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.job_id = "test-job"
        server.JOBS[self.job_id] = {"status": "running", "log": "", "output": None}

    def tearDown(self) -> None:
        server.JOBS.pop(self.job_id, None)
        self.temp.cleanup()

    def test_peak_measurement_keeps_values_above_zero_dbfs(self) -> None:
        # A sample amplitude of 4.0 is +12.04 dBFS, valid in a float WAV.
        wav = self.root / "hot.wav"
        write_float_wav(wav, [4.0] * 4_800)
        self.assertAlmostEqual(server.peak_of_audio(wav), 12.04, places=1)

    def test_sanitizer_replaces_nonfinite_float_samples(self) -> None:
        source = self.root / "source"
        source.mkdir()
        wav = source / "dirty.wav"
        write_float_wav(wav, [float("nan"), float("inf"), float("-inf"), 0.1] * 1_200)
        cleaned, blank = server.sanitized_inputs(self.job_id, [wav], self.root / "work", -40, 0, None)
        self.assertNotIn(wav, blank)
        self.assertAlmostEqual(server.peak_of_audio(cleaned[wav]), -20.0, places=1)

    def test_selected_hot_track_exports_below_safety_ceiling(self) -> None:
        source = self.root / "source"
        source.mkdir()
        hot = source / "hot.wav"
        skipped = source / "skip.wav"
        # Both inputs are synthetic; only the selected one should be exported.
        write_float_wav(hot, [4.0] * 4_800)
        write_float_wav(skipped, [0.25] * 4_800)
        server.convert_job(self.job_id, {
            "source": str(source), "selectedFiles": [hot.name], "mode": "per_track",
            "bitrate": "128", "sampleRate": "", "ceiling": "-2", "silenceThreshold": "-40",
        })
        output = source / "normalized_mp3"
        self.assertEqual(server.JOBS[self.job_id]["status"], "done", server.JOBS[self.job_id]["log"])
        self.assertTrue((output / "hot.mp3").is_file())
        self.assertFalse((output / "skip.mp3").exists())
        self.assertLessEqual(server.peak_of_mp3(output / "hot.mp3"), -2.0)


if __name__ == "__main__":
    unittest.main()
