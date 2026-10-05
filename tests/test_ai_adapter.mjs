import test from "node:test";
import assert from "node:assert/strict";
import { LocalStrokeModelAdapter, resolveModelEndpoint } from "../src/ai-adapter.js";

const publicPage = { hostname: "stonesgate604.github.io", protocol: "https:", search: "" };
const request = { drawing: { strokes: [] }, currentStep: 0, options: { maxStrokes: 1 } };
const modelResponse = {
  model: { name: "local-stroke-multimodal-v4.1-cat", version: "epoch-12" },
  strokes: [{ points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }] }]
};

test("public pages never connect to a visitor's localhost by default", () => {
  assert.equal(resolveModelEndpoint({ location: publicPage, config: {} }), null);
  assert.equal(resolveModelEndpoint({ location: { hostname: "localhost", protocol: "http:" }, config: {} }), "http://127.0.0.1:8787/continue");
});

test("a shared HTTPS service and a temporary override preserve proxy paths", () => {
  assert.equal(resolveModelEndpoint({ location: publicPage, config: { modelApiBaseUrl: "https://model.example/api/" } }), "https://model.example/api/continue");
  assert.equal(resolveModelEndpoint({ location: { ...publicPage, search: "?api=https%3A%2F%2Ftrial.example" }, config: { modelApiBaseUrl: "https://model.example" } }), "https://trial.example/continue");
});

test("public connection settings reject HTTP, credentials and malformed addresses", () => {
  for (const baseUrl of ["http://model.example", "https://user:secret@model.example", "javascript:alert(1)", "not-a-url", "https://model.example?secret=1"]) {
    assert.throws(() => resolveModelEndpoint({ location: publicPage, config: { modelApiBaseUrl: baseUrl } }));
  }
});

test("no configured service does not make a request or fabricate a stroke", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  await assert.rejects(new LocalStrokeModelAdapter({ endpoint: null }).continue(request), /not connected/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("real responses preserve model identity and send the current drawing", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://model.example/continue");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), request);
    return { ok: true, json: async () => modelResponse };
  });
  assert.deepEqual(await new LocalStrokeModelAdapter({ endpoint: "https://model.example/continue" }).continue(request), modelResponse);
});

test("service failure is reported instead of silently returning a mock stroke", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(new LocalStrokeModelAdapter({ endpoint: "https://model.example/continue" }).continue(request), /503/);
});

test("network failure is reported without changing the input drawing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(new LocalStrokeModelAdapter({ endpoint: "https://model.example/continue" }).continue(request), /unavailable/);
  assert.deepEqual(request.drawing.strokes, []);
});

test("invalid model geometry is rejected before it reaches the renderer", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ strokes: [{ points: [{ x: NaN, y: 0.2 }, { x: 0.4, y: 0.5 }] }] }) }));
  await assert.rejects(new LocalStrokeModelAdapter({ endpoint: "https://model.example/continue" }).continue(request), /invalid stroke coordinates/);
});

test("slow service requests are aborted and reported", async (t) => {
  t.mock.method(globalThis, "fetch", (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(new LocalStrokeModelAdapter({ endpoint: "https://model.example/continue", timeoutMs: 10 }).continue(request), /too long/);
});
