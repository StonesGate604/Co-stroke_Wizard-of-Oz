from __future__ import annotations

import math
import sys
import unittest
from dataclasses import asdict
from pathlib import Path

import torch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from train_stroke_multimodal_v41 import (  # noqa: E402
    StrokeMultimodalV41,
    TrainConfig,
    cosine_lr_multiplier,
    multimodal_loss,
    rasterize_context,
    sample_v41_stroke,
)
from serve_stroke_model import StrokeMultimodalV41Runtime  # noqa: E402
from evaluate_stroke_model import make_drawing, sample_candidate_set, seed_sampling  # noqa: E402


class StrokeMultimodalV41Tests(unittest.TestCase):
    def test_serving_matches_evaluation_and_excludes_future_strokes(self) -> None:
        config = TrainConfig(data="unused", d_model=24, layers=1, heads=3,
            points_per_stroke=4, mixtures=3, raster_size=16, dropout=0.0)
        model = StrokeMultimodalV41(config)
        runtime = StrokeMultimodalV41Runtime(
            {"config": asdict(config), "model": model.state_dict(), "epoch": 0},
            Path("unused.pt"), "cpu")
        drawing = make_drawing([
            torch.tensor([[0.2, 0.2], [0.4, 0.1], [0.6, 0.2], [0.6, 0.5]]),
            torch.tensor([[0.3, 0.4], [0.31, 0.41], [0.32, 0.4], [0.3, 0.4]]),
        ])
        selected, _ = sample_candidate_set(runtime, drawing,
            candidate_count=16, temperature=0.55, seed=73)
        # The browser sends a full timeline; hidden future ink must stay hidden.
        drawing["strokes"].append({"author": {"type": "ai"}, "tool": "pen",
            "points": [{"x": 0.9, "y": 0.9}, {"x": 0.95, "y": 0.9}]})
        seed_sampling(73, runtime.device)
        response = runtime.continue_drawing(drawing, 2, steps=64,
            temperature=0.55, max_strokes=1, max_points_per_stroke=4, style=None)
        self.assertEqual(response["strokes"][0]["points"], selected["points"])
        self.assertEqual(response["context"]["visibleStrokes"], 2)
        self.assertEqual(response["context"]["samplingPolicy"], "stroke-shape-quality-v1")
        self.assertEqual(response["context"]["rasterPolicy"], "full-visible-history-v1")

    def test_cosine_schedule_preserves_parameter_group_ratio(self) -> None:
        multipliers = [cosine_lr_multiplier(epoch, 12) for epoch in (0, 6, 12)]
        self.assertAlmostEqual(multipliers[0], 1.0)
        self.assertAlmostEqual(multipliers[-1], 0.1)
        self.assertGreater(multipliers[0], multipliers[1])
        self.assertGreater(multipliers[1], multipliers[2])

    def test_raster_channels_encode_all_ai_and_latest_human(self) -> None:
        points = torch.tensor([
            [[0.10, 0.15], [0.20, 0.15], [0.30, 0.15]],
            [[0.60, 0.50], [0.70, 0.50], [0.80, 0.50]],
            [[0.10, 0.80], [0.20, 0.80], [0.30, 0.80]],
        ])
        authors = torch.tensor([1, 2, 1])
        order = torch.tensor([0.0, 0.5, 1.0])
        raster = rasterize_context(points, authors, order, raster_size=32)

        self.assertEqual(tuple(raster.shape), (3, 32, 32))
        self.assertGreater(float(raster[0].sum()), float(raster[1].sum()))
        self.assertGreater(float(raster[1, 15:18, 18:27].sum()), 0.0)
        self.assertEqual(float(raster[1, 23:28, 2:12].sum()), 0.0)
        self.assertGreater(float(raster[2, 23:28, 2:12].sum()), 0.0)
        self.assertEqual(float(raster[2, 3:8, 2:12].sum()), 0.0)

    def test_partial_raster_does_not_contain_hidden_target(self) -> None:
        visible = torch.tensor([[[0.10, 0.20], [0.20, 0.20], [0.30, 0.20]]])
        raster = rasterize_context(
            visible,
            torch.tensor([1]),
            torch.tensor([0.0]),
            raster_size=32,
        )
        # A hypothetical target at the bottom-right must not appear because the
        # renderer receives only the selected context strokes.
        self.assertEqual(float(raster[:, 22:31, 22:31].sum()), 0.0)
        self.assertGreater(float(raster[:, 3:10, 2:12].sum()), 0.0)

    def test_forward_loss_sampling_and_raster_gradients_are_finite(self) -> None:
        config = TrainConfig(
            data="unused.ndjson",
            max_context_strokes=5,
            points_per_stroke=4,
            d_model=24,
            layers=1,
            heads=3,
            mixtures=3,
            dropout=0.0,
            raster_size=32,
        )
        model = StrokeMultimodalV41(config)
        context_points = torch.rand(2, 3, 4, 2)
        context_authors = torch.tensor([[1, 1, 2], [1, 2, 0]])
        context_order = torch.tensor([[0.0, 0.3, 0.7], [0.0, 0.5, 0.9]])
        context_mask = torch.tensor([[True, True, True], [True, True, False]])
        rasters = torch.stack([
            rasterize_context(context_points[index], context_authors[index], context_order[index], raster_size=32)
            for index in range(2)
        ])
        target_start = torch.rand(2, 2)
        target_shape = torch.rand(2, 3, 2) * 0.2
        target_stop = torch.tensor([0.0, 1.0])
        batch = {
            "target_start": target_start,
            "target_shape": target_shape,
            "target_stop": target_stop,
        }

        outputs = model(
            context_points,
            context_authors,
            context_order,
            context_mask,
            rasters,
            target_start,
        )
        losses = multimodal_loss(outputs, batch, config)
        self.assertTrue(all(math.isfinite(float(loss.item())) for loss in losses))
        losses[0].backward()
        raster_gradient = sum(
            float(parameter.grad.abs().sum())
            for parameter in model.raster_encoder.parameters()
            if parameter.grad is not None
        )
        self.assertGreater(raster_gradient, 0.0)

        sampled, confidence = sample_v41_stroke(
            model,
            context_points,
            context_authors,
            context_order,
            context_mask,
            rasters,
        )
        self.assertEqual(sampled.shape, (2, 4, 2))
        self.assertTrue(torch.isfinite(sampled).all())
        self.assertTrue(math.isfinite(confidence))


if __name__ == "__main__":
    unittest.main()
