import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from music import compose, analyze


class ScoreTests(unittest.TestCase):
    def test_original_score_is_deterministic_stereo_and_has_safe_fades(self):
        with tempfile.TemporaryDirectory(prefix="hands-score-") as directory:
            request = {"durationSeconds": 10, "style": "minimal-electronic", "tempoBpm": 104, "intensity": .65, "seed": 23}
            a, b = Path(directory) / "one.wav", Path(directory) / "two.wav"
            with contextlib.redirect_stdout(io.StringIO()):
                compose(request, a); compose(request, b)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            stats = analyze(a)
            self.assertEqual(stats["durationSeconds"], 10)
            self.assertEqual(stats["channels"], 2)
            self.assertLessEqual(stats["peakDbfs"], -3)
            self.assertGreater(stats["rmsDbfs"], -30)
            self.assertEqual(stats["clippedSamples"], 0)
            self.assertLess(stats["firstQuarterSecondRmsDbfs"], stats["rmsDbfs"] - 8)
            self.assertLess(stats["lastQuarterSecondRmsDbfs"], stats["rmsDbfs"] - 8)
            with self.assertRaises(FileExistsError): compose(request, a)

    def test_invalid_requests_do_not_create_media(self):
        with tempfile.TemporaryDirectory(prefix="hands-score-invalid-") as directory:
            target = Path(directory) / "bad.wav"
            for request in [{"durationSeconds": 301}, {"durationSeconds": 10, "style": "copyrighted-download"}, {"durationSeconds": 10, "url": "https://example.test"}]:
                with self.assertRaises(ValueError): compose(request, target)
            self.assertFalse(target.exists())


if __name__ == "__main__": unittest.main()
