import unittest
import numpy as np
from motion_check import compare_frames


class MotionChecks(unittest.TestCase):
    def test_static_or_caption_only_does_not_count(self):
        image = np.zeros((360, 640, 3), np.uint8)
        self.assertFalse(compare_frames(image, image)["measurableChange"])
        captions = image.copy()
        captions[280:] = 255
        captions[:30] = 255
        self.assertFalse(compare_frames(image, captions)["measurableChange"])

    def test_real_content_change_is_reported(self):
        image = np.zeros((360, 640, 3), np.uint8)
        moved = image.copy()
        moved[70:150, 100:230] = 180
        measured = compare_frames(image, moved)
        self.assertTrue(measured["measurableChange"])
        self.assertGreater(measured["changedPixelFraction"], .05)


if __name__ == "__main__":
    unittest.main()
