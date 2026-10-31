import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { FileStore, FirestoreStore } from './store.js';
import { authenticate, claim, requireLease, makeSession, applyOperation, publicState, cleanStroke, fail, LEASE_MS } from './session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const validSession = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
export async function createServer({ store, adminToken = '', allowedOrigins = [], cloud = false } = {}) {
  if (cloud && (!adminToken || !allowedOrigins.length)) throw new Error('Cloud Run requires ADMIN_TOKEN and ALLOWED_ORIGINS.');
  const originAllowed = origin => !origin || allowedOrigins.includes(origin) || (!cloud && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (!originAllowed(origin)) { res.writeHead(403); res.end('Origin not allowed'); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, service: 'co-stroke-woz', storage: store instanceof FirestoreStore ? 'firestore' : 'local-file' })); return;
      }
      if (req.method === 'POST' && url.pathname === '/sessions') {
        if (adminToken ? req.headers.authorization !== `Bearer ${adminToken}` : cloud || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
          res.writeHead(401); res.end('Session creation requires admin authorization'); return;
        }
        const id = randomBytes(16).toString('hex'), { record, tokens } = makeSession();
        await store.update(id, old => { if (old) fail('collision', 'Retry session creation'); return record; });
        res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ session: id, tokens })); return;
      }
      // Serve only the frontend asset allowlist. Never serve source server files or snapshots.
      if (req.method === 'GET') {
        const requestPath = decodeURIComponent(url.pathname);
        const relative = requestPath === '/' ? 'public/index.html' : requestPath === '/public/' ? 'public/index.html' : requestPath.slice(1);
        if (!/^(public|src|data\/examples)\/[\w./-]+$/.test(relative) || relative.split('/').includes('..')) { res.writeHead(404); res.end(); return; }
        const body = await readFile(path.join(root, relative));
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(relative)] || 'application/octet-stream');
        res.end(body); return;
      }
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(e.code === 'ENOENT' ? 404 : 503); res.end('Service unavailable'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 180000 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !originAllowed(req.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 2000000) ws.close(1013, 'Slow connection'); else ws.send(JSON.stringify(data)); } };
  wss.on('connection', ws => {
    let identity, cached, unwatch, unpreview, busy = false, lastPreview = 0, count = 0, countAt = Date.now();
    const connectionId = randomBytes(16).toString('hex');
    const authTimeout = setTimeout(() => ws.close(1008, 'Authentication required'), 8000);
    const observe = record => {
      cached = record;
      if (identity && record.leases[identity.role]?.connectionId !== connectionId) { ws.close(4001, 'Role reconnected elsewhere'); return; }
      send(ws, { type: 'state', state: publicState(record), serverNow: Date.now(), presence: Object.fromEntries(['participant','wizard'].map(role => [role, (record.leases[role]?.until ?? 0) > Date.now()])) });
    };
    ws.on('message', async raw => {
      let message;
      try {
        if (Date.now() - countAt > 1000) { count = 0; countAt = Date.now(); }
        if (++count > 35) fail('rate', 'Too many messages.');
        try { message = JSON.parse(raw.toString()); } catch { fail('invalid', 'Message must be valid JSON.'); }
        if (!message || typeof message !== 'object' || !['hello','ping','preview','op'].includes(message.type)) fail('invalid', 'Unknown message type.');
        if (!identity) {
          if (busy) return;
          busy = true;
          if (message.type !== 'hello' || !validSession(message.session)) fail('auth', 'Invalid session link.');
          const { session, role, token, clientId } = message;
          const record = await store.update(session, record => { authenticate(record, role, token); return claim(record, role, clientId, connectionId); });
          identity = { session, role, clientId }; clearTimeout(authTimeout);
          unwatch = store.watch(session, observe, () => ws.close(1011, 'Storage unavailable'));
          unpreview = store.watchPreview(session, preview => {
            if (preview.role !== role && preview.expiresAt > Date.now()) send(ws, { type: 'preview', ...preview });
          }, () => {});
          observe(record); busy = false; return;
        }
        if (message.type === 'ping') {
          const record = await store.update(identity.session, r => { requireLease(r, identity.role, connectionId); r.leases[identity.role].until = Date.now() + LEASE_MS; return r; });
          observe(record); return;
        }
        if (message.type === 'preview') {
          if (Date.now() - lastPreview < 120) return;
          lastPreview = Date.now(); requireLease(cached, identity.role, connectionId);
          if (message.baseRevision !== cached.state.revision) return;
          if (identity.role === 'wizard' ? !cached.state.request : !!cached.state.request) return;
          const stroke = message.stroke ? cleanStroke(message.stroke, identity.role, cached.state.step) : null;
          if (stroke && stroke.points.length > 256) return;
          await store.preview(identity.session, identity.role, { stroke, baseRevision: message.baseRevision, expiresAt: Date.now() + 3000 }); return;
        }
        if (message.type !== 'op' || busy) return;
        busy = true;
        const record = await store.update(identity.session, r => applyOperation(r, identity.role, connectionId, message.op));
        observe(record); send(ws, { type: 'ack', id: message.op.id }); busy = false;
      } catch (e) {
        busy = false;
        const protocolError = ['auth','invalid','occupied','replaced','conflict','turn','capacity','rate'].includes(e.code);
        send(ws, { type: 'error', code: protocolError ? e.code : 'storage', message: protocolError ? e.message : 'Storage unavailable. Reconnect to check whether your action was saved.', id: message?.op?.id });
        if (!identity || e.code === 'replaced' || !protocolError) ws.close(1011, 'Reconnect required');
        else if (identity) { try { const r = await store.read(identity.session); if (r) observe(r); } catch {} }
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimeout); unwatch?.(); unpreview?.();
      if (identity) store.update(identity.session, r => {
        if (r?.leases[identity.role]?.connectionId === connectionId) r.leases[identity.role].until = 0;
        return r;
      }).catch(() => {});
    });
  });
  return { server, wss, async close() {
    await Promise.all([...wss.clients].map(ws => new Promise(resolve => { ws.once('close',resolve); ws.terminate(); })));
    await new Promise(resolve => server.close(resolve)); await store.close();
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cloud = !!process.env.K_SERVICE;
  if (cloud && process.env.STORE !== 'firestore') throw new Error('Cloud Run must use STORE=firestore; instance memory/disk is not durable.');
  let store;
  if (process.env.STORE === 'firestore') {
    const { Firestore } = await import('@google-cloud/firestore');
    store = new FirestoreStore(new Firestore({ databaseId: process.env.FIRESTORE_DATABASE || 'co-stroke-woz' }));
  } else store = new FileStore(process.env.DATA_DIR || path.join(root, '.woz-data'));
  const app = await createServer({ store, cloud, adminToken: process.env.ADMIN_TOKEN, allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
  app.server.listen(Number(process.env.PORT || 8788), '0.0.0.0', () => console.log('Co-stroke_Wizard of Oz listening on', app.server.address().port));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
