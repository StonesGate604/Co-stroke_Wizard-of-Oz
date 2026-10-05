from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from evaluate_stroke_model import (  # noqa: E402
    compare_strokes,
    count_self_intersections,
    describe,
)


def make_stroke(points: list[tuple[float, float]]) -> dict:
    return {"points": [{"x": x, "y": y} for x, y in points]}


class StrokeEvaluationTests(unittest.TestCase):
    def test_identical_strokes_have_zero_distance(self) -> None:
        stroke = make_stroke([(0.1, 0.2), (0.4, 0.5), (0.8, 0.7)])
        metrics = compare_strokes(stroke, stroke)
        self.assertAlmostEqual(metrics["chamfer"], 0.0, places=6)
        self.assertAlmostEqual(metrics["hausdorff"], 0.0, places=6)

    def test_displaced_strokes_have_positive_distance(self) -> None:
        first = make_stroke([(0.1, 0.1), (0.2, 0.1)])
        second = make_stroke([(0.6, 0.6), (0.7, 0.6)])
        self.assertGreater(compare_strokes(first, second)["chamfer"], 0.5)

    def test_bow_tie_has_one_self_intersection(self) -> None:
        bow_tie = make_stroke([(0.1, 0.1), (0.9, 0.9), (0.1, 0.9), (0.9, 0.1)])
        self.assertEqual(count_self_intersections(bow_tie), 1)

    def test_describe_ignores_non_finite_values(self) -> None:
        summary = describe([1.0, 2.0, math.nan, math.inf])
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["mean"], 1.5)


if __name__ == "__main__":
    unittest.main()
