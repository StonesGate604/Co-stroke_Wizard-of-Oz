"""Evaluate stroke-level checkpoints on held-out one-step and rollout tasks.

The evaluator deliberately reads recognized Quick, Draw! records after the
training prefix, so the default report does not reuse the first 70,000 records
consumed by the published cat checkpoints.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable, Sequence

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from serve_stroke_model import (  # noqa: E402
    load_runtime,
    pack_v4_context,
    rank_v4_candidates,
    score_v4_candidate,
    stroke_author_type,
    tensor_to_co_points,
)
from train_stroke_relational_v4 import (  # noqa: E402
    drawing_to_v4_strokes,
    resample_stroke,
)


DEFAULT_PREFIX_FRACTIONS = (0.25, 0.50, 0.75)
REPORT_VERSION = "stroke-eval-v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a co-Stroke v4/v4.1 checkpoint.")
    parser.add_argument("--data", required=True, help="Quick, Draw! simplified NDJSON file.")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True, help="Destination JSON report.")
    parser.add_argument("--csv-out", default="", help="Optional per-example CSV report.")
    parser.add_argument("--skip-recognized", type=int, default=70000)
    parser.add_argument("--max-drawings", type=int, default=32)
    parser.add_argument("--prefix-fractions", default="0.25,0.50,0.75")
    parser.add_argument("--best-of-k", type=int, default=16)
    parser.add_argument("--rollout-steps", type=int, default=10)
    parser.add_argument("--rollout-prefix-fraction", type=float, default=0.5)
    parser.add_argument("--temperature", type=float, default=0.55)
    parser.add_argument("--seed", type=int, default=20260903)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return parser.parse_args()


def parse_fractions(value: str) -> tuple[float, ...]:
    fractions = tuple(float(part.strip()) for part in value.split(",") if part.strip())
    if not fractions or any(not 0.0 < fraction < 1.0 for fraction in fractions):
        raise ValueError("prefix fractions must be comma-separated values strictly between 0 and 1")
    return fractions


def load_holdout_drawings(
    path: Path,
    *,
    skip_recognized: int,
    max_drawings: int,
    points_per_stroke: int,
) -> list[dict[str, Any]]:
    drawings: list[dict[str, Any]] = []
    recognized_seen = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if not bool(record.get("recognized", False)):
                continue
            raw_drawing = record.get("drawing")
            if not raw_drawing:
                continue
            if recognized_seen < skip_recognized:
                recognized_seen += 1
                continue
            recognized_seen += 1
            strokes = drawing_to_v4_strokes(raw_drawing, points_per_stroke)
            if len(strokes) < 2:
                continue
            drawings.append({
                "keyId": str(record.get("key_id", recognized_seen)),
                "countryCode": record.get("countrycode"),
                "strokes": strokes,
            })
            if len(drawings) >= max_drawings:
                break
    if not drawings:
        raise ValueError("No usable holdout drawings were found after the requested skip.")
    return drawings


def tensor_stroke_to_co(points: torch.Tensor, index: int, author: str = "human") -> dict[str, Any]:
    return {
        "id": f"eval_{author}_{index}",
        "author": {"type": author},
        "tool": "pen",
        "style": {"color": "#111111", "width": 4},
        "points": [
            {"x": float(point[0]), "y": float(point[1]), "t": point_index * 40, "p": 0.5}
            for point_index, point in enumerate(points)
        ],
    }


def make_drawing(strokes: Sequence[torch.Tensor], *, author: str = "human") -> dict[str, Any]:
    return {
        "version": "0.1.0",
        "category": "cat",
        "canvas": {"width": 256, "height": 256, "coordinateSystem": "normalized"},
        "strokes": [tensor_stroke_to_co(stroke, index, author) for index, stroke in enumerate(strokes)],
    }


def seed_sampling(seed: int, device: torch.device) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)


def sample_candidate_set(
    runtime: Any,
    drawing: dict[str, Any],
    *,
    candidate_count: int,
    temperature: float,
    seed: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    visible_strokes = drawing["strokes"]
    context_strokes, _ = pack_v4_context(
        visible_strokes,
        max_strokes=runtime.config.max_context_strokes,
    )
    model_inputs = runtime.make_model_inputs(
        context_strokes,
        visible_stroke_count=len(visible_strokes),
        canvas_width=256,
        canvas_height=256,
        raster_strokes=visible_strokes,
    )
    references = [stroke for stroke in visible_strokes if len(stroke.get("points", [])) >= 2]
    last_human = next(
        (stroke for stroke in reversed(references) if stroke_author_type(stroke) != "ai"),
        None,
    )

    seed_sampling(seed, runtime.device)
    candidates: list[dict[str, Any]] = []
    for _ in range(max(2, candidate_count)):
        tensor, log_density = runtime.sample_candidate(model_inputs, temperature=temperature)
        points = tensor_to_co_points(
            tensor[0],
            max_points=runtime.config.points_per_stroke,
            canvas_width=256,
            canvas_height=256,
        )
        guard = score_v4_candidate(points, references, last_human, confidence=log_density)
        candidates.append({"points": points, "logDensity": log_density, "confidence": log_density, **guard})

    return rank_v4_candidates(candidates), candidates


def xy_points(stroke: dict[str, Any]) -> list[tuple[float, float]]:
    return [(float(point["x"]), float(point["y"])) for point in stroke["points"]]


def compare_strokes(
    candidate: dict[str, Any],
    target: dict[str, Any],
    *,
    samples: int = 32,
) -> dict[str, float]:
    candidate_tensor = resample_stroke(xy_points(candidate), samples)
    target_tensor = resample_stroke(xy_points(target), samples)
    distances = torch.linalg.vector_norm(
        candidate_tensor.unsqueeze(1) - target_tensor.unsqueeze(0),
        dim=-1,
    )
    candidate_nearest = distances.amin(dim=1)
    target_nearest = distances.amin(dim=0)
    return {
        "chamfer": float((candidate_nearest.mean() + target_nearest.mean()) * 0.5),
        "hausdorff": float(torch.maximum(candidate_nearest.max(), target_nearest.max())),
        "startDistance": float(torch.linalg.vector_norm(candidate_tensor[0] - target_tensor[0])),
        "endDistance": float(torch.linalg.vector_norm(candidate_tensor[-1] - target_tensor[-1])),
    }


def stroke_length(stroke: dict[str, Any]) -> float:
    points = xy_points(stroke)
    return sum(math.dist(start, end) for start, end in zip(points, points[1:]))


def boundary_fraction(stroke: dict[str, Any], margin: float = 0.01) -> float:
    points = xy_points(stroke)
    return sum(
        x <= margin or x >= 1.0 - margin or y <= margin or y >= 1.0 - margin
        for x, y in points
    ) / max(len(points), 1)


def count_self_intersections(stroke: dict[str, Any]) -> int:
    points = xy_points(stroke)
    intersections = 0
    for first in range(len(points) - 1):
        for second in range(first + 2, len(points) - 1):
            if first == 0 and second == len(points) - 2 and points[0] == points[-1]:
                continue
            if segments_intersect(points[first], points[first + 1], points[second], points[second + 1]):
                intersections += 1
    return intersections


def segments_intersect(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    def cross(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    ab_c = cross(a, b, c)
    ab_d = cross(a, b, d)
    cd_a = cross(c, d, a)
    cd_b = cross(c, d, b)
    epsilon = 1e-9
    return (
        ((ab_c > epsilon and ab_d < -epsilon) or (ab_c < -epsilon and ab_d > epsilon))
        and ((cd_a > epsilon and cd_b < -epsilon) or (cd_a < -epsilon and cd_b > epsilon))
    )


def target_metrics(candidate: dict[str, Any], target: dict[str, Any]) -> dict[str, float]:
    comparison = compare_strokes(candidate, target)
    return {
        **comparison,
        "lengthRatio": stroke_length(candidate) / max(stroke_length(target), 1e-6),
        "boundaryFraction": boundary_fraction(candidate),
        "selfIntersections": float(count_self_intersections(candidate)),
    }


def evaluate_one_step(
    runtime: Any,
    drawings: Sequence[dict[str, Any]],
    *,
    fractions: Sequence[float],
    candidate_count: int,
    temperature: float,
    seed: int,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for drawing_index, item in enumerate(drawings):
        strokes = item["strokes"]
        for fraction_index, fraction in enumerate(fractions):
            context_count = max(1, min(len(strokes) - 1, round((len(strokes) - 1) * fraction)))
            context = make_drawing(strokes[:context_count])
            target = tensor_stroke_to_co(strokes[context_count], context_count)
            selected, candidates = sample_candidate_set(
                runtime,
                context,
                candidate_count=candidate_count,
                temperature=temperature,
                seed=seed + drawing_index * 1009 + fraction_index * 97,
            )
            scored = [(candidate, target_metrics(candidate, target)) for candidate in candidates]
            oracle_candidate, oracle = min(scored, key=lambda pair: pair[1]["chamfer"])
            selected_metrics = target_metrics(selected, target)
            records.append({
                "recordType": "oneStep",
                "keyId": item["keyId"],
                "prefixFraction": fraction,
                "contextStrokes": context_count,
                "totalStrokes": len(strokes),
                **{f"selected{key[0].upper()}{key[1:]}": value for key, value in selected_metrics.items()},
                "oracleChamfer": oracle["chamfer"],
                "oracleHausdorff": oracle["hausdorff"],
                "selectedOverlap": selected["overlap"],
                "selectedHumanOverlap": selected["humanOverlap"],
                "selectedLogDensity": selected["logDensity"],
                "selectedConfidenceZ": selected["confidenceZ"],
                "oracleLogDensity": oracle_candidate["logDensity"],
            })
    return records


def evaluate_rollouts(
    runtime: Any,
    drawings: Sequence[dict[str, Any]],
    *,
    prefix_fraction: float,
    rollout_steps: int,
    candidate_count: int,
    temperature: float,
    seed: int,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for drawing_index, item in enumerate(drawings):
        source = item["strokes"]
        context_count = max(1, min(len(source) - 1, round((len(source) - 1) * prefix_fraction)))
        drawing = make_drawing(source[:context_count])
        generated: list[dict[str, Any]] = []
        remaining_targets = [tensor_stroke_to_co(stroke, index) for index, stroke in enumerate(source[context_count:])]

        for step in range(1, rollout_steps + 1):
            selected, _ = sample_candidate_set(
                runtime,
                drawing,
                candidate_count=candidate_count,
                temperature=temperature,
                seed=seed + drawing_index * 1009 + step * 193,
            )
            ai_stroke = {
                **selected,
                "id": f"eval_ai_{drawing_index}_{step}",
                "author": {"type": "ai"},
                "tool": "pen",
            }
            prior_generated = list(generated)
            generated.append(ai_stroke)
            drawing["strokes"].append(ai_stroke)

            target_chamfer = min(
                (compare_strokes(ai_stroke, target)["chamfer"] for target in remaining_targets),
                default=math.nan,
            )
            repeat_chamfer: float | None = min(
                (compare_strokes(ai_stroke, prior)["chamfer"] for prior in prior_generated),
                default=None,
            )
            context_lengths = [stroke_length(stroke) for stroke in drawing["strokes"][:-1]]
            length_ratio = stroke_length(ai_stroke) / max(median(context_lengths), 1e-6)
            records.append({
                "recordType": "rollout",
                "keyId": item["keyId"],
                "rolloutStep": step,
                "contextStrokes": context_count,
                "targetChamfer": target_chamfer,
                "repeatChamfer": repeat_chamfer,
                "repeatBelow0025": float(repeat_chamfer is not None and repeat_chamfer < 0.025),
                "overlap": selected["overlap"],
                "humanOverlap": selected["humanOverlap"],
                "boundaryFraction": boundary_fraction(ai_stroke),
                "selfIntersections": float(count_self_intersections(ai_stroke)),
                "lengthVsContextMedian": length_ratio,
                "logDensity": selected["logDensity"],
                "confidenceZ": selected["confidenceZ"],
            })
    return records


def percentile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return math.nan
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def describe(values: Iterable[float | None]) -> dict[str, float | int | None]:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return {
        "count": len(clean),
        "mean": mean(clean) if clean else None,
        "p50": percentile(clean, 0.50) if clean else None,
        "p90": percentile(clean, 0.90) if clean else None,
    }


def summarize(records: Sequence[dict[str, Any]], group_key: str, metrics: Sequence[str]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        groups[str(record[group_key])].append(record)
    return {
        group: {metric: describe(record[metric] for record in members) for metric in metrics}
        for group, members in groups.items()
    }


def write_csv(path: Path, records: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = sorted({key for record in records for key in record})
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def main() -> None:
    args = parse_args()
    fractions = parse_fractions(args.prefix_fractions)
    checkpoint_path = Path(args.checkpoint)
    runtime = load_runtime(checkpoint_path, args.device)
    if not hasattr(runtime, "sample_candidate"):
        raise ValueError("This evaluator requires a stroke-level v4 or v4.1 checkpoint.")
    drawings = load_holdout_drawings(
        Path(args.data),
        skip_recognized=args.skip_recognized,
        max_drawings=args.max_drawings,
        points_per_stroke=runtime.config.points_per_stroke,
    )

    one_step = evaluate_one_step(
        runtime,
        drawings,
        fractions=fractions,
        candidate_count=args.best_of_k,
        temperature=args.temperature,
        seed=args.seed,
    )
    rollouts = evaluate_rollouts(
        runtime,
        drawings,
        prefix_fraction=args.rollout_prefix_fraction,
        rollout_steps=args.rollout_steps,
        candidate_count=args.best_of_k,
        temperature=args.temperature,
        seed=args.seed + 1_000_000,
    )

    report = {
        "reportVersion": REPORT_VERSION,
        "checkpoint": str(checkpoint_path),
        "model": {"name": runtime.name, "version": runtime.version, "type": runtime.model_type},
        "config": {
            "data": args.data,
            "skipRecognized": args.skip_recognized,
            "drawings": len(drawings),
            "prefixFractions": fractions,
            "bestOfK": args.best_of_k,
            "rolloutSteps": args.rollout_steps,
            "rolloutPrefixFraction": args.rollout_prefix_fraction,
            "temperature": args.temperature,
            "seed": args.seed,
            "device": args.device,
        },
        "summary": {
            "oneStepByPrefix": summarize(
                one_step,
                "prefixFraction",
                (
                    "selectedChamfer",
                    "oracleChamfer",
                    "selectedHausdorff",
                    "selectedOverlap",
                    "selectedBoundaryFraction",
                    "selectedSelfIntersections",
                ),
            ),
            "rolloutByStep": summarize(
                rollouts,
                "rolloutStep",
                (
                    "targetChamfer",
                    "repeatChamfer",
                    "repeatBelow0025",
                    "overlap",
                    "boundaryFraction",
                    "selfIntersections",
                    "lengthVsContextMedian",
                ),
            ),
        },
        "oneStep": one_step,
        "rollouts": rollouts,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    if args.csv_out:
        write_csv(Path(args.csv_out), [*one_step, *rollouts])
    print(json.dumps(report["summary"], indent=2, allow_nan=False), flush=True)
    print(f"Saved evaluation report to {out_path}", flush=True)


if __name__ == "__main__":
    main()
