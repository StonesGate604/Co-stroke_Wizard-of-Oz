import { createStroke } from "./stroke-format.js";

export function resolveModelEndpoint({
  location = globalThis.location ?? {},
  config = globalThis.CO_STROKE_CONFIG ?? {}
} = {}) {
  const localPage = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  const override = new URLSearchParams(location.search ?? "").get("api");
  const baseUrl = override ?? config.modelApiBaseUrl ?? "";
  if (typeof baseUrl !== "string") throw new Error("The AI connection address is invalid.");
  if (!baseUrl.trim()) return localPage ? "http://127.0.0.1:8787/continue" : null;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("The AI connection address is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The AI connection needs an HTTP or HTTPS address without credentials.");
  }
  if ((!localPage || location.protocol === "https:") && url.protocol !== "https:") {
    throw new Error("This page needs an HTTPS AI connection.");
  }
  if (url.search || url.hash) {
    throw new Error("The AI connection address must not contain a query or fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/continue`;
  return url.href;
}

export class MockStrokeModelAdapter {
  constructor() {
    this.name = "mock-autoregressive-stroke-model";
    this.version = "0.1.0";
  }

  async continue({ drawing, currentStep, options = {} }) {
    const visibleStrokes = drawing.strokes.slice(0, currentStep);
    const seedStroke = visibleStrokes[visibleStrokes.length - 1];
    const seedPoint = seedStroke?.points?.[seedStroke.points.length - 1] ?? { x: 0.48, y: 0.48 };
    const offset = Math.min(0.08, 0.03 + (options.temperature ?? 0.4) * 0.05);

    return {
      model: { name: this.name, version: this.version },
      strokes: [
        createStroke({
          id: `stroke_ai_${Date.now()}`,
          authorType: "ai",
          tool: "pen",
          color: options.style?.color ?? "#ff44aa",
          width: options.style?.width ?? 4,
          insertedAtStep: currentStep,
          points: [
            { x: clamp(seedPoint.x, 0.08, 0.92), y: clamp(seedPoint.y, 0.08, 0.92), t: 0, p: 0.5 },
            { x: clamp(seedPoint.x + offset, 0.08, 0.92), y: clamp(seedPoint.y - offset, 0.08, 0.92), t: 120, p: 0.5 },
            { x: clamp(seedPoint.x + offset * 1.8, 0.08, 0.92), y: clamp(seedPoint.y, 0.08, 0.92), t: 240, p: 0.5 }
          ]
        })
      ]
    };
  }
}

export class LocalStrokeModelAdapter {
  constructor({ endpoint = resolveModelEndpoint(), fallback = null, timeoutMs = 30000 } = {}) {
    this.endpoint = endpoint;
    this.fallback = fallback;
    this.timeoutMs = timeoutMs;
  }

  async continue(request) {
    if (!this.endpoint) throw new Error("AI is not connected yet. Drawing and replay are available.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`AI service returned ${response.status}. Please try again.`);
      }

      const result = await response.json();
      if (!Array.isArray(result.strokes)) {
        throw new Error("The AI service returned an invalid drawing response.");
      }
      if (result.strokes.some((stroke) => !Array.isArray(stroke?.points)
        || stroke.points.length < 2
        || stroke.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) {
        throw new Error("The AI service returned invalid stroke coordinates.");
      }
      return result;
    } catch (error) {
      if (this.fallback) return this.fallback.continue(request);
      if (error.name === "AbortError") throw new Error("AI took too long to respond. Please try again.");
      if (error instanceof TypeError) throw new Error("AI is unavailable. Your drawing is still here; please try again later.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function requestAIContinuation(request, adapter = new LocalStrokeModelAdapter()) {
  return adapter.continue(request);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

