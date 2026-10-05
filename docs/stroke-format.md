# Stroke Format

This is a concise reference for the current `co-stroke.json` v0.1 format. The normative machine-readable definition is [`../schemas/co-stroke.schema.json`](../schemas/co-stroke.schema.json); the complete design notes are in [`co-stroke-json-v0.1.md`](co-stroke-json-v0.1.md).

## Drawing Object

```json
{
  "schema": "https://co-stroke.local/schema/co-stroke-v0.1.json",
  "version": "0.1.0",
  "id": "drawing_simple_house_001",
  "title": "simple-house",
  "category": "house",
  "source": { "type": "example", "name": "hand-authored sample" },
  "canvas": {
    "width": 960,
    "height": 640,
    "coordinateSystem": "normalized",
    "background": "#ffffff"
  },
  "timeline": {
    "unit": "stroke",
    "currentStep": 0,
    "branchPolicy": "truncate-future-on-edit"
  },
  "strokes": []
}
```

Required drawing fields are `version`, `id`, `title`, `canvas`, and `strokes`.

## Stroke Object

Each stroke is one timeline step.

```json
{
  "id": "stroke_001",
  "author": { "type": "human", "id": "local-user" },
  "tool": "pen",
  "style": {
    "color": "#111111",
    "width": 4,
    "opacity": 1,
    "lineCap": "round",
    "lineJoin": "round"
  },
  "timing": { "startMs": 0, "durationMs": 400 },
  "points": [
    { "x": 0.2, "y": 0.7, "t": 0, "p": 0.5 },
    { "x": 0.4, "y": 0.5, "t": 400, "p": 0.5 }
  ],
  "metadata": { "insertedAtStep": 0 }
}
```

Required stroke fields are `id`, `author`, `tool`, `style`, and `points`. `author.type` is one of `human`, `ai`, `dataset`, or `robot`; `tool` is `pen` or `eraser`. Every stroke has at least two points.

## Coordinates, Timing, and Pressure

- `x` and `y` are absolute normalized canvas coordinates in the range `0..1`.
- `t` is elapsed time in milliseconds relative to the start of the stroke.
- `p` is normalized pressure in the range `0..1`; the browser uses `0.5` when the device provides no useful pressure value.
- `style.width` is the rendered stroke width in pixels.

Normalized coordinates make drawings independent of display size and suitable for later conversion into calibrated robot coordinates. Training code derives model-specific representations such as `(dx, dy, pen_state)` from this interchange format.

## Legacy Input Compatibility

`src/stroke-format.js` accepts older input with a string `author` and top-level `color`/`size`, then normalizes it to the nested `author` and `style` objects shown above. Newly exported drawings always use the current v0.1 structure.
