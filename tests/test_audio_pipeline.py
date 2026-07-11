"""Synthetic, privacy-safe tests for the 32-bit float WAV export pipeline."""

from __future__ import annotations

import math
import struct
import subprocess
import tempfile
import unittest
import zipfile
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
        cleaned, blank = server.sanitized_inputs(self.job_id, [wav], self.root / "work", -40, 0, None, 1)
        self.assertNotIn(wav, blank)
        self.assertAlmostEqual(server.peak_of_audio(cleaned[wav]), -20.0, places=1)

    def test_individual_trim_is_applied_to_its_named_track(self) -> None:
        wav = self.root / "longer.wav"
        write_float_wav(wav, [0.2] * 4_800)  # 0.1 seconds
        cleaned, _ = server.sanitized_inputs(
            self.job_id, [wav], self.root / "individual-work", -40, 0, None, 1,
            {wav.name: {"start": "0.020", "end": "0.070"}},
        )
        ffprobe = server.tool_path("ffprobe")
        duration = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                   "-of", "default=nokey=1:noprint_wrappers=1", str(cleaned[wav])],
                                  capture_output=True, text=True, check=True)
        self.assertAlmostEqual(float(duration.stdout.strip()), 0.050, places=3)

    def test_selected_hot_track_exports_below_safety_ceiling(self) -> None:
        source = self.root / "source"
        source.mkdir()
        hot = source / "hot.wav"
        hot_two = source / "hot-two.wav"
        skipped = source / "skip.wav"
        # All inputs are synthetic; two selected tracks exercise the parallel path.
        write_float_wav(hot, [4.0] * 4_800)
        write_float_wav(hot_two, [2.0] * 4_800)
        write_float_wav(skipped, [0.25] * 4_800)
        old_output = source / "normalized_audio"
        old_output.mkdir()
        (old_output / "stale.mp3").write_bytes(b"not a real MP3")
        server.convert_job(self.job_id, {
            "source": str(source), "selectedFiles": [hot.name, hot_two.name], "mode": "per_track",
            "bitrate": "128", "sampleRate": "", "ceiling": "-2", "silenceThreshold": "-40", "workers": "2", "packageZip": "on",
        })
        output = source / "normalized_audio"
        self.assertEqual(server.JOBS[self.job_id]["status"], "done", server.JOBS[self.job_id]["log"])
        self.assertTrue((output / "hot.mp3").is_file())
        self.assertTrue((output / "hot-two.mp3").is_file())
        self.assertFalse((output / "skip.mp3").exists())
        self.assertLessEqual(server.peak_of_mp3(output / "hot.mp3"), -2.0)
        self.assertLessEqual(server.peak_of_mp3(output / "hot-two.mp3"), -2.0)
        with zipfile.ZipFile(source / f"{source.name}_normalized_audio.zip") as archive:
            self.assertEqual(set(archive.namelist()), {"hot.mp3", "hot-two.mp3"})

    def test_wav_pcm24_output_is_safe_and_has_requested_codec(self) -> None:
        source = self.root / "wav-output"
        source.mkdir()
        hot = source / "hot.wav"
        write_float_wav(hot, [4.0] * 4_800)
        server.convert_job(self.job_id, {
            "source": str(source), "mode": "per_track", "outputFormat": "wav", "wavDepth": "pcm24",
            "bitrate": "256", "sampleRate": "", "ceiling": "-2", "silenceThreshold": "-40", "workers": "1",
        })
        output = source / "normalized_audio" / "hot.wav"
        self.assertEqual(server.JOBS[self.job_id]["status"], "done", server.JOBS[self.job_id]["log"])
        self.assertTrue(output.is_file())
        self.assertLessEqual(server.peak_of_audio(output), -2.0)
        ffprobe = server.tool_path("ffprobe")
        codec = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
                                "-of", "default=nokey=1:noprint_wrappers=1", str(output)], capture_output=True, text=True, check=True)
        self.assertEqual(codec.stdout.strip(), "pcm_s24le")

    def test_m4a_output_is_safe(self) -> None:
        source = self.root / "m4a-output"
        source.mkdir()
        hot = source / "hot.wav"
        write_float_wav(hot, [4.0] * 4_800)
        server.convert_job(self.job_id, {
            "source": str(source), "mode": "per_track", "outputFormat": "m4a", "bitrate": "128",
            "sampleRate": "", "ceiling": "-2", "silenceThreshold": "-40", "workers": "1",
        })
        output = source / "normalized_audio" / "hot.m4a"
        self.assertEqual(server.JOBS[self.job_id]["status"], "done", server.JOBS[self.job_id]["log"])
        self.assertTrue(output.is_file())
        self.assertLessEqual(server.peak_of_audio(output), -2.0)

    def test_flac_input_is_discovered_and_exported(self) -> None:
        source = self.root / "flac-input"
        source.mkdir()
        wav = source / "source.wav"
        flac = source / "source.flac"
        write_float_wav(wav, [0.5] * 4_800)
        ffmpeg = server.tool_path("ffmpeg")
        subprocess.run([ffmpeg, "-y", "-i", str(wav), str(flac)], capture_output=True, check=True)
        wav.unlink()
        server.convert_job(self.job_id, {
            "source": str(source), "mode": "per_track", "outputFormat": "mp3", "bitrate": "128",
            "sampleRate": "", "ceiling": "-2", "silenceThreshold": "-40", "workers": "1",
        })
        output = source / "normalized_audio" / "source.mp3"
        self.assertEqual(server.JOBS[self.job_id]["status"], "done", server.JOBS[self.job_id]["log"])
        self.assertTrue(output.is_file())


if __name__ == "__main__":
    unittest.main()
