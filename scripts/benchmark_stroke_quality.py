"""Reproducible checkpoint quality checks with inspectable stroke geometry.

Uses the same candidate sampler as evaluate_stroke_model; --script-dir can
point at a frozen copy of the pre-change scripts for a fair comparison.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import importlib
import json
import sys
import time
from pathlib import Path
from statistics import mean


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script-dir', default=str(Path(__file__).parent))
    parser.add_argument('--checkpoint', default='runs/stroke-multimodal-v41-cat/checkpoint.pt')
    parser.add_argument('--data', default='data/quickdraw/cat.ndjson')
    parser.add_argument('--out', required=True)
    parser.add_argument('--count', type=int, default=24)
    parser.add_argument('--skip', type=int, default=70000)
    parser.add_argument('--steps', type=int, default=12)
    parser.add_argument('--seed', type=int, default=20260907)
    parser.add_argument('--device', default='cuda')
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.script_dir).resolve()))
    ev = importlib.import_module('evaluate_stroke_model')
    runtime = ev.load_runtime(Path(args.checkpoint), args.device)
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in Path(args.script_dir).glob('*.py')}
    drawings = ev.load_holdout_drawings(Path(args.data), skip_recognized=args.skip,
        max_drawings=args.count, points_per_stroke=runtime.config.points_per_stroke)
    cases = []
    started = time.perf_counter()
    for index, item in enumerate(drawings):
        prefix_count = max(1, len(item['strokes']) // 2)
        drawing = ev.make_drawing(item['strokes'][:prefix_count])
        initial = list(drawing['strokes'])
        target = ev.tensor_stroke_to_co(item['strokes'][prefix_count], prefix_count)
        records = []
        generated = []
        for step in range(args.steps):
            selected, candidates = ev.sample_candidate_set(runtime, drawing,
                candidate_count=16, temperature=0.55,
                seed=args.seed + index * 1009 + step * 193)
            stroke = {**selected, 'author': {'type': 'ai'}, 'tool': 'pen'}
            repeat = min((ev.compare_strokes(stroke, old)['chamfer'] for old in generated), default=None)
            records.append({
                'selfIntersections': ev.count_self_intersections(stroke),
                'overlap': selected['overlap'],
                'repeat': float(repeat is not None and repeat < 0.025),
                'length': ev.stroke_length(stroke),
                'boundaryFraction': ev.boundary_fraction(stroke),
                'targetChamfer': ev.compare_strokes(stroke, target)['chamfer'] if step == 0 else None,
                'oracleChamfer': min(ev.compare_strokes(c, target)['chamfer'] for c in candidates) if step == 0 else None,
            })
            generated.append(stroke)
            drawing['strokes'].append(stroke)
        cases.append({'keyId': item['keyId'], 'context': initial,
            'target': target, 'generated': generated, 'metrics': records})
        print(f'{index + 1}/{len(drawings)}', flush=True)
    all_records = [r for c in cases for r in c['metrics']]
    first_records = [c['metrics'][0] for c in cases]
    summary = {key: mean(r[key] for r in all_records)
        for key in ('selfIntersections', 'overlap', 'repeat', 'length', 'boundaryFraction')}
    summary.update({key: mean(r[key] for r in first_records) for key in ('targetChamfer', 'oracleChamfer')})
    summary['seconds'] = time.perf_counter() - started
    report = {'config': vars(args), 'checkpointSha256': hashlib.sha256(Path(args.checkpoint).read_bytes()).hexdigest(),
        'sourceHashes': hashes, 'summary': summary, 'cases': cases}
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    cards = []
    for case in cases:
        panels = []
        for label, strokes in [('Reference next stroke', [case['target']]),
                               ('Generated first stroke', case['generated'][:1]),
                               (f'After {args.steps} AI strokes', case['generated'])]:
            paths = []
            for stroke, color in [(s, '#252525') for s in case['context']] + [(s, '#ed3896') for s in strokes]:
                points = ' '.join(f"{p['x'] * 256:.2f},{p['y'] * 256:.2f}" for p in stroke['points'])
                paths.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>')
            panels.append(f'<div><p>{label}</p><svg viewBox="0 0 256 256">{"".join(paths)}</svg></div>')
        cards.append(f'<section><h3>{html.escape(case["keyId"])}</h3><div class="row">{"".join(panels)}</div></section>')
    page = '<!doctype html><meta charset="utf-8"><title>Stroke quality benchmark</title><style>body{font:14px system-ui;background:#edf0f4;margin:24px}section{background:white;padding:16px;margin-bottom:20px;max-width:960px}.row{display:flex;gap:20px}.row>div{flex:1}svg{width:100%;border:1px solid #ddd}pre{white-space:pre-wrap}</style>'
    page += '<h1>Stroke quality benchmark</h1><p>Black: input. Pink: reference or generated strokes. Raw polylines, without browser smoothing.</p>'
    page += '<pre>' + html.escape(json.dumps(summary, indent=2)) + '</pre>' + ''.join(cards)
    output.with_suffix('.html').write_text(page, encoding='utf-8')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
