import { DrawingInputController } from './drawing-input.js';
import { createEmptyDrawing, createStroke } from './stroke-format.js';
import { TimelinePlayer } from './timeline-player.js';
import { TimelineView } from './timeline-view.js';
import { SessionClient } from './woz-client.js';

const $ = id => document.getElementById(id);
const dom = Object.fromEntries(['drawingCanvas','loadExampleButton','exportButton','undoButton','clearButton','penToolButton','eraserToolButton','playButton','pauseButton','resetButton','aiStepButton','contextStat','titleStat','categoryStat','stepStat','authorStat','connectionStat','roleStat','turnNotice','finishButton','cancelButton','setupPanel','backendInput','adminInput','createSessionButton','sessionLinks','errorStat','draftButton','presenceStat'].map(id => [id,$(id)]));
const params = new URLSearchParams(location.hash.slice(1));
const role = params.get('role') || 'participant';
const backend = params.get('server') || globalThis.CO_STROKE_CONFIG?.syncServerUrl || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : '');
let client, shared, tool = 'pen', drawingRevision, lastRequest, remotePreview, lastPreviewAt = 0, rejectedDraft;
const player = new TimelinePlayer(dom.drawingCanvas);
const view = new TimelineView({ track: document.querySelector('.tl-track'), icons: $('tl-icons'), range: $('timeline'), label: $('tl-label'), cursor: $('tl-cursor'), onSeek: step => action('seek', { step }) });
player.onChange = ({ drawing, step, totalSteps, currentStroke }) => {
  view.update(drawing, step);
  dom.titleStat.textContent = drawing?.title || 'session'; dom.categoryStat.textContent = drawing?.category || 'unknown';
  dom.stepStat.textContent = `${step} / ${totalSteps}`; dom.authorStat.textContent = currentStroke?.author?.type || 'none';
};
player.setDrawing(createEmptyDrawing(),0);
const input = new DrawingInputController(dom.drawingCanvas, {
  canStart: () => canDraw(),
  onStart: () => { drawingRevision = shared.revision; dom.errorStat.textContent = ''; },
  onPreview(points) {
    player.render(buildStroke(points));
    if (Date.now() - lastPreviewAt > 140 && points.length >= 2) {
      lastPreviewAt = Date.now(); client.preview(buildStroke(sample(points,256)));
    }
  },
  onCommit(points) {
    if (!canDraw() || shared.revision !== drawingRevision) { player.render(); return; }
    action('stroke', { stroke: buildStroke(sample(points,2048)), requestId: shared.request?.id });
  },
  onCancel: () => player.render()
});
function sample(points, max) { if (points.length <= max) return points; return Array.from({length:max},(_,i) => points[Math.round(i*(points.length-1)/(max-1))]); }
function buildStroke(points) {
  return createStroke({ id: 'preview', authorType: role === 'wizard' ? 'ai' : 'human', tool, color: tool === 'eraser' ? '#ffffff' : role === 'wizard' ? '#ff44aa' : '#111111', width: tool === 'eraser' ? 10 : 4, points, insertedAtStep: player.step });
}
function isPlaying() { return !!shared?.playback && projectedStep() < shared.drawing.strokes.length; }
function projectedStep() {
  return shared?.playback ? Math.min(shared.drawing.strokes.length, shared.playback.fromStep + Math.floor(Math.max(0, Date.now() + (client?.offset || 0) - shared.playback.startedAt)/420)) : shared?.step || 0;
}
function canDraw() { return !!client?.ready && !client.pending && shared && !isPlaying() && (role === 'wizard' ? !!shared.request : !shared.request); }
function action(type, extra) {
  if (client?.operation(type, extra)) { input.cancel(); remotePreview = null; }
}
function renderState(next) {
  if (!next) return;
  const changed = !shared || next.revision !== shared.revision;
  shared = next;
  if (changed) { input.cancel(); remotePreview = null; player.setDrawing(next.drawing,projectedStep()); }
  const active = !!client?.ready && !client.pending;
  for (const button of [dom.loadExampleButton,dom.undoButton,dom.clearButton,dom.playButton,dom.pauseButton,dom.resetButton]) button.disabled = !active || role !== 'participant';
  document.querySelector('.tl-track').classList.toggle('readonly', !active || role !== 'participant');
  dom.aiStepButton.disabled = !active || role !== 'participant' || !!next.request || isPlaying();
  dom.finishButton.disabled = !active || !next.request;
  dom.cancelButton.disabled = !active || !next.request;
  dom.finishButton.hidden = role !== 'wizard' || !next.request;
  dom.cancelButton.hidden = role !== 'participant' || !next.request;
  dom.drawingCanvas.classList.toggle('unavailable', !canDraw());
  dom.turnNotice.hidden = !next.request;
  dom.turnNotice.textContent = role === 'wizard' ? 'AI REQUEST — draw a response, then finish the turn.' : 'AI is drawing…';
  dom.contextStat.textContent = next.request ? (role === 'wizard' ? 'Your pen contributes as AI.' : 'Waiting for AI. You can cancel to continue drawing.') : (role === 'wizard' ? 'Waiting for Participant to request AI.' : 'Draw or request AI to continue.');
  dom.presenceStat.textContent = client?.presence?.[role === 'wizard' ? 'participant' : 'wizard'] ? (role === 'wizard' ? 'Participant online' : 'AI available') : (role === 'wizard' ? 'Participant offline' : 'AI offline — request will wait');
  if (role === 'wizard' && next.request && next.request.id !== lastRequest) { document.title = '● AI REQUEST — co-Stroke'; dom.turnNotice.focus(); }
  if (!next.request) document.title = role === 'wizard' ? 'Wizard — co-Stroke' : 'co-Stroke';
  lastRequest = next.request?.id;
}
setInterval(() => {
  if (!shared) return;
  if (!input.isDrawing && player.step !== projectedStep()) { player.seek(projectedStep()); renderState(shared); }
  if (remotePreview && remotePreview.expiresAt < Date.now() + (client?.offset || 0)) { remotePreview = null; if (!input.isDrawing) player.render(); }
}, 80);
function showError(message, op) {
  player.render();
  dom.errorStat.textContent = message;
  if (op?.stroke) { rejectedDraft = op.stroke; sessionStorage.setItem('woz-rejected-draft',JSON.stringify(rejectedDraft)); dom.draftButton.hidden = false; }
}
dom.roleStat.textContent = role === 'wizard' ? 'Wizard console' : 'Drawing session';
dom.finishButton.hidden = true; dom.cancelButton.hidden = true;
dom.aiStepButton.hidden = role === 'wizard';
for (const button of [dom.loadExampleButton,dom.undoButton,dom.clearButton,dom.playButton,dom.pauseButton,dom.resetButton,dom.aiStepButton]) button.disabled = true;
dom.backendInput.value = backend;
if (params.has('session') && params.has('token') && ['participant','wizard'].includes(role) && backend) {
  try {
    const url = new URL(backend);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) throw new Error('Use an HTTPS sync server.');
    dom.setupPanel.hidden = true;
    client = new SessionClient({ backend, session: params.get('session'), role, token: params.get('token'), onState: renderState,
      onStatus: text => { dom.connectionStat.textContent = text; if (text.startsWith('Disconnected')) input.cancel(); },
      onError: showError,
      onPreview: preview => {
        if (!input.isDrawing && preview.baseRevision === shared?.revision) { remotePreview = preview; player.render(preview.stroke); }
      }
    });
  } catch(e) { showError(e.message); }
} else {
  dom.setupPanel.hidden = false; dom.connectionStat.textContent = 'Create a session to begin';
}
dom.createSessionButton.addEventListener('click', async () => {
  dom.createSessionButton.disabled = true;
  try {
    const base = new URL(dom.backendInput.value);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(base.hostname))) throw new Error('Use an HTTPS sync server.');
    const response = await fetch(new URL('/sessions',base), { method: 'POST', headers: dom.adminInput.value ? { Authorization: `Bearer ${dom.adminInput.value}` } : {} });
    dom.adminInput.value = '';
    if (!response.ok) throw new Error(`Session creation failed (${response.status}). Check the server and admin key.`);
    const result = await response.json(); dom.sessionLinks.replaceChildren();
    for (const r of ['participant','wizard']) {
      const url = new URL(location.href); url.search = ''; url.hash = new URLSearchParams({ session: result.session, role:r, token:result.tokens[r], server:base.origin }).toString();
      const link = document.createElement('a'); link.href = url.href; link.textContent = `Open ${r === 'wizard' ? 'Wizard' : 'Participant'}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const text = document.createElement('input'); text.readOnly = true; text.value = url.href; text.setAttribute('aria-label',`${r} link`); text.addEventListener('click',()=>text.select());
      dom.sessionLinks.append(link,text);
    }
  } catch(e) { showError(e.message); } finally { dom.createSessionButton.disabled = false; }
});
dom.aiStepButton.addEventListener('click', () => action('request'));
dom.loadExampleButton.addEventListener('click', () => action('example'));
dom.finishButton.addEventListener('click', () => action('finish', { requestId: shared?.request?.id }));
dom.cancelButton.addEventListener('click', () => action('cancel'));
dom.undoButton.addEventListener('click', () => action('undo'));
dom.clearButton.addEventListener('click', () => action('clear'));
dom.playButton.addEventListener('click', () => action('play'));
dom.pauseButton.addEventListener('click', () => action('pause'));
dom.resetButton.addEventListener('click', () => action('seek', { step: 0 }));
for (const [button,value] of [[dom.penToolButton,'pen'],[dom.eraserToolButton,'eraser']]) button.addEventListener('click', () => { tool = value; dom.penToolButton.classList.toggle('selected',tool === 'pen'); dom.eraserToolButton.classList.toggle('selected',tool === 'eraser'); });
function download(data, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
dom.exportButton.addEventListener('click', () => download({ ...player.drawing, timeline: { ...player.drawing.timeline, currentStep: player.step } },'co-stroke-woz.json'));
try { rejectedDraft = JSON.parse(sessionStorage.getItem('woz-rejected-draft')); dom.draftButton.hidden = !rejectedDraft; } catch {}
dom.draftButton.addEventListener('click', () => download(rejectedDraft,'unsaved-stroke.json'));
if (window.lucide) window.lucide.createIcons();
