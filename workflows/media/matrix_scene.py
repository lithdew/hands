"""Trusted data-driven ManimGL scene. The model supplies numeric JSON, never Python."""
import json
import os
import numpy as np
from manimlib import Scene, NumberPlane, Vector, VGroup, Polygon, WHITE, BLUE, TEAL, YELLOW, ORIGIN


class MatrixScene(Scene):
    def construct(self):
        data = json.loads(os.environ["HANDS_MATRIX_DATA"])
        matrix = np.asarray(data["matrix"], dtype=float)
        if matrix.shape != (2, 2) or not np.isfinite(matrix).all() or np.abs(matrix).max() > 5:
            raise ValueError("Invalid bounded matrix")
        seconds = float(data["durationSeconds"])
        # Heavier strokes: the clip is composited at about half size and then
        # watched inside a phone-width player.
        plane = NumberPlane(x_range=(-4, 4, 1), y_range=(-3, 3, 1), width=8, height=6,
                            faded_line_ratio=0, axis_config={"stroke_color": WHITE, "stroke_width": 3},
                            background_line_style={"stroke_color": BLUE, "stroke_width": 1.6, "stroke_opacity": .75})
        basis_x = Vector([1, 0, 0], color=TEAL, stroke_width=10)
        basis_y = Vector([0, 1, 0], color=YELLOW, stroke_width=10)
        square = Polygon(ORIGIN, [1, 0, 0], [1, 1, 0], [0, 1, 0], color=TEAL, fill_opacity=.28, stroke_width=3)
        group = VGroup(plane, square, basis_x, basis_y)
        self.add(group)
        self.wait(seconds * .10)
        self.play(group.animate.apply_matrix(matrix), run_time=seconds * .30)
        self.wait(seconds * .15)
        if abs(np.linalg.det(matrix)) > 1e-8:
            # Applying the computed inverse also exercises the mathematical contract.
            self.play(group.animate.apply_matrix(np.linalg.inv(matrix)), run_time=seconds * .30)
            error = float(np.max(np.abs(np.linalg.inv(matrix) @ matrix - np.eye(2))))
            if error > 1e-8:
                raise ValueError("Inverse identity check failed")
        else:
            self.wait(seconds * .30)
        self.wait(seconds * .15)
