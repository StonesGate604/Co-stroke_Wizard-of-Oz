import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createEmptyDrawing, createStroke, normalizeDrawing } from '../src/stroke-format.js';
const example = JSON.parse(readFileSync(new URL('../data/examples/simple-house.json', import.meta.url),'utf8').replace(/^\uFEFF/,''));

export const LEASE_MS = 45000;
export const MAX_BYTES = 700000;
export const roles = ['participant', 'wizard'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function makeSession() {
  const tokens = Object.fromEntries(roles.map(r => [r, randomBytes(32).toString('base64url')]));
  return { tokens, record: {
    auth: Object.fromEntries(roles.map(r => [r, hash(tokens[r])])), leases: {},
    state: { revision: 0, drawing: createEmptyDrawing(), step: 0, playback: null, request: null,
      recentOps: [], lastAction: 'Session created' }
  } };
}
export function authenticate(record, role, token) {
  if (!record || !roles.includes(role) || typeof token !== 'string' || record.auth[role] !== hash(token)) {
    fail('auth', 'Invalid session link.');
  }
}
export function claim(record, role, clientId, connectionId, now = Date.now()) {
  if (typeof clientId !== 'string' || !/^[\w-]{8,80}$/.test(clientId)) fail('invalid', 'Invalid browser identity.');
  const lease = record.leases[role];
  if (lease && lease.until > now && lease.clientId !== clientId) fail('occupied', 'This role is open in another browser. Close it and wait up to 45 seconds.');
  record.leases[role] = { clientId, connectionId, until: now + LEASE_MS };
  return record;
}
export function requireLease(record, role, connectionId, now = Date.now()) {
  const lease = record?.leases[role];
  if (!lease || lease.connectionId !== connectionId || lease.until <= now) fail('replaced', 'Connection expired or replaced. Reconnect to continue.');
}
export function visibleStep(state, now = Date.now()) {
  if (!state.playback) return state.step;
  return Math.min(state.drawing.strokes.length, state.playback.fromStep + Math.floor(Math.max(0, now - state.playback.startedAt) / 420));
}
export function cleanStroke(raw, role, step) {
  if (!raw || !['pen', 'eraser'].includes(raw.tool) || !Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 2048) fail('invalid', 'A stroke needs 2–2048 points.');
  const points = raw.points.map(p => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) fail('invalid', 'Stroke coordinates must be between 0 and 1.');
    return { x: p.x, y: p.y, t: Math.min(3600000, Math.max(0, Number(p.t) || 0)), p: Math.min(1, Math.max(0, Number(p.p) || 0.5)) };
  });
  return createStroke({ id: `stroke_${randomBytes(12).toString('hex')}`, authorType: role === 'wizard' ? 'ai' : 'human', tool: raw.tool,
    color: raw.tool === 'eraser' ? '#ffffff' : role === 'wizard' ? '#ff44aa' : '#111111',
    width: raw.tool === 'eraser' ? 10 : 4, points, insertedAtStep: step });
}
export function applyOperation(record, role, connectionId, op, now = Date.now()) {
  requireLease(record, role, connectionId, now);
  if (!op || typeof op.id !== 'string' || !/^[\w-]{8,80}$/.test(op.id)) fail('invalid', 'Invalid operation id.');
  const state = record.state;
  // The receipt and the change are persisted in the same transaction, before ACK.
  if (state.recentOps.includes(`${role}:${op.id}`)) return record;
  if (op.baseRevision !== state.revision) fail('conflict', 'Shared history changed. Your action was not applied.');
  const step = visibleStep(state, now);
  const wasPlaying = !!state.playback && step < state.drawing.strokes.length;
  switch (op.type) {
    case 'stroke': {
      if (wasPlaying) fail('turn', 'Pause playback before drawing.');
      if (role === 'wizard' && (!state.request || op.requestId !== state.request.id)) fail('turn', 'Wait for an AI request before drawing.');
      if (role === 'participant' && state.request) fail('turn', 'Wait for AI or cancel the request.');
      if (state.drawing.strokes.slice(0, step).length >= 500) fail('capacity', 'Session limit reached. Export and start another session.');
      const stroke = cleanStroke(op.stroke, role, step);
      state.drawing.strokes = [...state.drawing.strokes.slice(0, step), stroke];
      state.step = state.drawing.strokes.length;
      state.playback = null;
      state.lastAction = role === 'wizard' ? 'AI stroke added' : 'Human stroke added';
      break;
    }
    case 'request':
      if (role !== 'participant' || state.request || wasPlaying) fail('turn', 'AI request unavailable.');
      state.step = step; state.playback = null;
      state.request = { id: op.id, createdAt: now };
      state.lastAction = 'AI continuation requested';
      break;
    case 'finish':
      if (role !== 'wizard' || !state.request || op.requestId !== state.request.id) fail('turn', 'No matching AI turn.');
      state.request = null; state.lastAction = 'AI turn finished';
      break;
    case 'cancel':
      if (role !== 'participant') fail('turn', 'Only Participant can cancel.');
      state.request = null; state.lastAction = 'AI request cancelled';
      break;
    case 'seek': case 'play': case 'pause': case 'undo': case 'clear': case 'example':
      if (role !== 'participant') fail('turn', 'Participant controls shared history.');
      state.playback = null; state.request = null; state.step = step;
      if (op.type === 'seek') {
        if (!Number.isInteger(op.step) || op.step < 0 || op.step > state.drawing.strokes.length) fail('invalid', 'Invalid timeline step.');
        state.step = op.step;
      }
      if (op.type === 'play') {
        const fromStep = step >= state.drawing.strokes.length ? 0 : step;
        state.step = fromStep; state.playback = { fromStep, startedAt: now };
      }
      if (op.type === 'undo') {
        state.drawing.strokes = state.drawing.strokes.slice(0, Math.max(0, step - 1));
        state.step = state.drawing.strokes.length;
      }
      if (op.type === 'clear') { state.drawing = createEmptyDrawing(); state.step = 0; }
      if (op.type === 'example') { state.drawing = normalizeDrawing(structuredClone(example)); state.step = state.drawing.strokes.length; }
      state.lastAction = `Participant: ${op.type}`;
      break;
    default: fail('invalid', 'Unknown operation.');
  }
  state.drawing.updatedAt = new Date(now).toISOString();
  state.drawing.timeline.currentStep = state.step;
  state.revision++;
  state.recentOps = [...state.recentOps, `${role}:${op.id}`].slice(-128);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) fail('capacity', 'Session storage limit reached. Export before starting another session.');
  return record;
}
export function publicState(record) { return record.state; }
