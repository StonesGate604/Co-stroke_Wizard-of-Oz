from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from serve_stroke_model import (  # noqa: E402
    browser_to_model_point,
    make_v4_model_inputs,
    model_to_browser_point,
    pack_v4_context,
    rasterize_visible_drawing,
    score_v4_candidate,
    stroke_shape_quality,
    stroke_repeat_distance,
)
from train_stroke_relational_v4 import (  # noqa: E402
    StrokeRelationalTransformer,
    TrainConfig,
    make_completion_example,
    resample_stroke,
    sample_v4_stroke,
    sample_shape_gmm,
    sequence_loss,
)


def make_stroke(author: str, offset: float) -> dict:
    return {
        "author": {"type": author},
        "tool": "pen",
        "points": [
            {"x": offset, "y": 0.2},
            {"x": offset + 0.05, "y": 0.25},
            {"x": offset + 0.10, "y": 0.2},
        ],
    }


class FixedSubsetRng:
    """Minimal RNG stub for deterministic arbitrary-subset examples."""

    def __init__(self, target_index: int, context_count: int) -> None:
        self.target_index = target_index
        self.context_count = context_count
        self.random_calls = 0

    def random(self) -> float:
        self.random_calls += 1
        return 1.0 if self.random_calls == 1 else 0.0

    def randrange(self, start: int, stop: int) -> int:
        self.assert_in_range(start, stop, self.target_index)
        return self.target_index

    def randint(self, start: int, stop: int) -> int:
        self.assert_in_range(start, stop + 1, self.context_count)
        return self.context_count

    def sample(self, population: list[int], count: int) -> list[int]:
        return population[:count]

    @staticmethod
    def assert_in_range(start: int, stop: int, value: int) -> None:
        if not start <= value < stop:
            raise AssertionError(f"Fixed RNG value {value} is outside [{start}, {stop})")


class StrokeRelationalV4Tests(unittest.TestCase):
    def test_subset_can_recover_first_stroke_and_uses_completion_stop(self) -> None:
        strokes = [
            torch.tensor([[0.1 + 0.2 * index, 0.2], [0.12 + 0.2 * index, 0.25]])
            for index in range(3)
        ]
        config = TrainConfig(
            data="unused.ndjson",
            points_per_stroke=2,
            max_context_strokes=3,
            prefix_probability=0.0,
        )

        complete = make_completion_example(strokes, config, FixedSubsetRng(0, 2))
        self.assertTrue(torch.allclose(complete["target_start"], strokes[0][0]))
        self.assertEqual(float(complete["target_stop"]), 1.0)
        self.assertTrue(torch.allclose(complete["context_order"], torch.tensor([0.0, 1.0])))

        incomplete = make_completion_example(strokes, config, FixedSubsetRng(0, 1))
        self.assertEqual(float(incomplete["target_stop"]), 0.0)
        self.assertTrue(torch.allclose(incomplete["context_order"], torch.tensor([0.0])))

    def test_serving_order_is_ranked_only_within_visible_context(self) -> None:
        strokes = [make_stroke("human", 0.1 + index * 0.2) for index in range(3)]
        for stroke, original_index in zip(strokes, (0, 12, 48)):
            stroke["_contextIndex"] = original_index
        inputs = make_v4_model_inputs(
            strokes,
            visible_stroke_count=50,
            points_per_stroke=4,
            canvas_width=960,
            canvas_height=640,
            device=torch.device("cpu"),
        )
        self.assertTrue(torch.allclose(inputs["context_order"], torch.tensor([[0.0, 0.5, 1.0]])))

    def test_shape_start_noise_is_training_only(self) -> None:
        config = TrainConfig(
            data="unused.ndjson",
            points_per_stroke=4,
            d_model=24,
            layers=1,
            heads=3,
            mixtures=3,
            dropout=0.0,
            start_condition_noise=0.05,
        )
        model = StrokeRelationalTransformer(config)
        target = torch.full((4, 2), 0.5)
        model.train()
        torch.manual_seed(11)
        self.assertFalse(torch.allclose(model.condition_shape_start(target), target))
        model.eval()
        self.assertTrue(torch.equal(model.condition_shape_start(target), target))

    def test_letterbox_mapping_preserves_screen_space_shape_and_round_trip(self) -> None:
        center = browser_to_model_point(
            0.5, 0.5, canvas_width=960, canvas_height=640
        )
        horizontal = browser_to_model_point(
            0.5 + 64 / 960, 0.5, canvas_width=960, canvas_height=640
        )
        vertical = browser_to_model_point(
            0.5, 0.5 + 64 / 640, canvas_width=960, canvas_height=640
        )
        self.assertAlmostEqual(horizontal[0] - center[0], vertical[1] - center[1])

        browser = model_to_browser_point(
            *browser_to_model_point(0.23, 0.71, canvas_width=960, canvas_height=640),
            canvas_width=960,
            canvas_height=640,
        )
        self.assertAlmostEqual(browser[0], 0.23)
        self.assertAlmostEqual(browser[1], 0.71)

    def test_resampling_preserves_endpoints_and_fixed_width(self) -> None:
        sampled = resample_stroke([(0.1, 0.2), (0.4, 0.2), (0.9, 0.8)], 8)
        self.assertEqual(tuple(sampled.shape), (8, 2))
        self.assertTrue(torch.allclose(sampled[0], torch.tensor([0.1, 0.2])))
        self.assertTrue(torch.allclose(sampled[-1], torch.tensor([0.9, 0.8])))

    def test_forward_loss_and_sampling_are_finite(self) -> None:
        config = TrainConfig(
            data="unused.ndjson",
            max_context_strokes=5,
            points_per_stroke=4,
            d_model=24,
            layers=1,
            heads=3,
            mixtures=3,
            dropout=0.0,
        )
        model = StrokeRelationalTransformer(config)
        context_points = torch.rand(2, 3, 4, 2)
        context_authors = torch.tensor([[1, 1, 2], [1, 2, 0]])
        context_order = torch.tensor([[0.0, 0.3, 0.7], [0.0, 0.5, 0.9]])
        context_mask = torch.tensor([[True, True, True], [True, True, False]])
        target_start = torch.rand(2, 2)
        target_shape = torch.rand(2, 3, 2) * 0.2
        target_stop = torch.tensor([0.0, 1.0])

        outputs = model(
            context_points,
            context_authors,
            context_order,
            context_mask,
            target_start,
        )
        self.assertEqual(outputs[0]["pi_logits"].shape, (2, 3))
        self.assertEqual(outputs[1]["mean"].shape, (2, 3, 3, 2))
        losses = sequence_loss(*outputs, target_start, target_shape, target_stop, 0.25)
        self.assertTrue(all(math.isfinite(float(loss.item())) for loss in losses))

        sampled, confidence = sample_v4_stroke(
            model,
            context_points,
            context_authors,
            context_order,
            context_mask,
        )
        self.assertEqual(sampled.shape, (2, 4, 2))
        self.assertTrue(torch.isfinite(sampled).all())
        self.assertTrue(math.isfinite(confidence))

    def test_v4_context_retains_humans_and_recent_ai(self) -> None:
        strokes = [make_stroke("human", 0.02 * index) for index in range(8)]
        strokes.extend(make_stroke("ai", 0.35 + 0.02 * index) for index in range(10))
        packed, stats = pack_v4_context(strokes, max_strokes=10)

        self.assertEqual(stats["humanStrokesUsed"], 8)
        self.assertEqual(stats["aiStrokesUsed"], 2)
        self.assertEqual(stats["droppedAIStrokes"], 8)
        self.assertEqual(len(packed), 10)
        self.assertEqual(packed[-1]["author"]["type"], "ai")

    def test_history_is_not_discarded_before_context_is_full(self) -> None:
        strokes = [make_stroke("human", 0.05 * i) for i in range(3)]
        strokes += [make_stroke("ai", 0.03 * i) for i in range(12)]
        packed, stats = pack_v4_context(strokes, max_strokes=24)
        self.assertEqual(len(packed), 15)
        self.assertEqual(stats["droppedAIStrokes"], 0)
        self.assertFalse(stats["compacted"])
        empty, _ = pack_v4_context(strokes, max_strokes=0)
        self.assertEqual(empty, [])

    def test_visual_history_survives_vector_budget_and_eraser_removes_ink(self) -> None:
        def stroke(y: float, author: str = "human", tool: str = "pen") -> dict:
            return {"author": {"type": author}, "tool": tool,
                "points": [{"x": 0.2, "y": y}, {"x": 0.8, "y": y}]}
        history = [stroke(0.2, "ai"), stroke(0.8), stroke(0.5)]
        packed, _ = pack_v4_context(history, max_strokes=2)
        self.assertEqual(len(packed), 2)
        kwargs = dict(points_per_stroke=16, raster_size=64,
            canvas_width=256, canvas_height=256, device=torch.device("cpu"))
        canvas = rasterize_visible_drawing(history, **kwargs)
        self.assertGreater(float(canvas[1, 10:16].sum()), 0)
        self.assertGreater(float(canvas[2, 29:35].sum()), 0)
        erased = rasterize_visible_drawing(history + [stroke(0.2, tool="eraser")], **kwargs)
        self.assertEqual(float(erased[:, 10:16].sum()), 0)
        self.assertGreater(float(erased[0, 48:54].sum()), 0)
        repainted = rasterize_visible_drawing(history + [stroke(0.2, tool="eraser"), stroke(0.2)], **kwargs)
        self.assertGreater(float(repainted[0, 10:16].sum()), 0)
        self.assertEqual(float(repainted[1, 10:16].sum()), 0)

    def test_shape_sampling_preserves_component_geometry_without_point_jitter(self) -> None:
        mean = torch.tensor([[[[0.1, 0.0], [0.2, 0.0], [0.3, 0.0]]]])
        distribution = {"pi_logits": torch.zeros(1, 1), "mean": mean,
            "log_sigma": torch.zeros_like(mean)}
        points, density = sample_shape_gmm(distribution, 0.55)
        self.assertTrue(torch.equal(points, mean[:, 0]))
        self.assertTrue(torch.isfinite(density).all())
        noisy, _ = sample_shape_gmm(distribution, 0.55, residual_noise=0.2)
        self.assertFalse(torch.equal(noisy, points))

    def test_quality_distinguishes_crossings_from_a_closed_loop(self) -> None:
        def points(xy: list) -> list:
            return [{"x": x, "y": y} for x, y in xy]
        loop = points([(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8), (0.2, 0.2)])
        crossed = points([(0.2, 0.2), (0.8, 0.8), (0.2, 0.8), (0.8, 0.2)])
        self.assertEqual(stroke_shape_quality(loop)["selfIntersections"], 0)
        self.assertEqual(stroke_shape_quality(crossed)["selfIntersections"], 1)

    def test_small_interior_detail_is_not_treated_as_isolated(self) -> None:
        outline = {"points": [{"x": x, "y": y} for x, y in
            [(0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9), (0.1, 0.1)]]}
        detail = [{"x": 0.49, "y": 0.49}, {"x": 0.51, "y": 0.50}]
        metrics = score_v4_candidate(detail, [outline], outline, confidence=0)
        self.assertGreaterEqual(metrics["geometryScore"], -0.05)

    def test_repeat_penalty_is_direction_invariant_but_allows_new_connections(self) -> None:
        previous = {"author": {"type": "ai"}, "points": [
            {"x": 0.2, "y": 0.4}, {"x": 0.5, "y": 0.4}]}
        repeated = list(reversed(previous["points"]))
        connected = [{"x": 0.5, "y": 0.4}, {"x": 0.7, "y": 0.6}]
        self.assertLess(stroke_repeat_distance(repeated, [previous]), 1e-6)
        self.assertGreater(stroke_repeat_distance(connected, [previous]), 0.04)
        self.assertGreater(score_v4_candidate(connected, [previous], None, confidence=0)["score"],
            score_v4_candidate(repeated, [previous], None, confidence=0)["score"])

    def test_score_prefers_connection_over_tracing_or_isolation(self) -> None:
        human = make_stroke("human", 0.2)
        traced = [{**point, "t": index * 40, "p": 0.5} for index, point in enumerate(human["points"])]
        connected = [
            {"x": 0.30, "y": 0.20, "t": 0, "p": 0.5},
            {"x": 0.35, "y": 0.15, "t": 40, "p": 0.5},
            {"x": 0.40, "y": 0.10, "t": 80, "p": 0.5},
            {"x": 0.45, "y": 0.12, "t": 120, "p": 0.5},
            {"x": 0.48, "y": 0.16, "t": 160, "p": 0.5},
        ]
        distant = [
            {"x": 0.7, "y": 0.7, "t": 0, "p": 0.5},
            {"x": 0.8, "y": 0.75, "t": 40, "p": 0.5},
            {"x": 0.9, "y": 0.7, "t": 80, "p": 0.5},
        ]
        traced_metrics = score_v4_candidate(
            traced, [human], human, confidence=0.0
        )
        connected_metrics = score_v4_candidate(
            connected, [human], human, confidence=0.0
        )
        distant_metrics = score_v4_candidate(
            distant, [human], human, confidence=0.0
        )
        self.assertGreater(traced_metrics["humanOverlap"], connected_metrics["humanOverlap"])
        self.assertGreater(connected_metrics["score"], traced_metrics["score"])
        self.assertGreater(connected_metrics["score"], distant_metrics["score"])
        self.assertLess(connected_metrics["endpointDistance"], distant_metrics["endpointDistance"])


if __name__ == "__main__":
    unittest.main()
