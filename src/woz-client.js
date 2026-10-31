export class SessionClient {
  constructor({ backend, session, role, token, onState, onStatus, onPreview, onError }) {
    Object.assign(this, { backend, session, role, token, onState, onStatus, onPreview, onError });
    this.key = `woz:${session}:${role}`;
    this.clientId = sessionStorage.getItem(`${this.key}:client`) || crypto.randomUUID();
    sessionStorage.setItem(`${this.key}:client`, this.clientId);
    try { this.pending = JSON.parse(sessionStorage.getItem(`${this.key}:pending`)); } catch {}
    this.state = null; this.ready = false; this.attempt = 0; this.offset = 0;
    this.connect();
  }
  connect() {
    this.onStatus('Connecting…');
    const url = new URL('/ws', this.backend); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.socket = new WebSocket(url);
    const deadline = setTimeout(() => ws.close(), 12000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', session: this.session, role: this.role, token: this.token, clientId: this.clientId }));
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'state') {
        clearTimeout(deadline); this.attempt = 0;
        this.offset = message.serverNow - Date.now();
        const first = !this.ready; this.ready = true;
        if (!this.state || message.state.revision >= this.state.revision) {
          this.state = message.state; this.presence = message.presence;
          if (this.pending && this.state.recentOps.includes(`${this.role}:${this.pending.id}`)) this.clearPending();
          this.onState(this.state);
        }
        this.onStatus(this.pending ? 'Saving…' : 'Connected');
        if (first && this.pending) this.send({ type: 'op', op: this.pending });
        if (!this.heartbeat) this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastMessage > 35000) ws.close();
          else this.send({ type: 'ping' });
        }, 10000);
      } else if (message.type === 'ack') {
        if (this.pending?.id === message.id) this.clearPending();
        this.onStatus('Connected'); this.onState(this.state);
      } else if (message.type === 'error') {
        if (message.id && this.pending?.id === message.id && message.code !== 'storage') {
          const rejected = this.pending; this.clearPending(); this.onError(message.message, rejected);
        } else this.onError(message.message);
        this.onState(this.state);
      } else if (message.type === 'preview') this.onPreview(message);
      this.lastMessage = Date.now();
    };
    ws.onclose = event => {
      clearTimeout(deadline); clearInterval(this.heartbeat); this.heartbeat = null; this.ready = false;
      this.onStatus('Disconnected — reconnecting…'); this.onState(this.state);
      if (event.code === 4001) { this.onStatus('This browser role was replaced. Reload to reconnect.'); return; }
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.attempt++) + Math.random() * 400);
    };
    ws.onerror = () => ws.close();
  }
  clearPending() { this.pending = null; sessionStorage.removeItem(`${this.key}:pending`); }
  send(message) { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  operation(type, extra = {}) {
    if (!this.ready || this.pending || !this.state) return false;
    this.pending = { id: crypto.randomUUID(), baseRevision: this.state.revision, type, ...extra };
    sessionStorage.setItem(`${this.key}:pending`, JSON.stringify(this.pending));
    this.send({ type: 'op', op: this.pending }); this.onStatus('Saving…'); this.onState(this.state); return true;
  }
  preview(stroke) { if (this.ready && !this.pending) this.send({ type: 'preview', baseRevision: this.state.revision, stroke }); }
  close() { this.stopped = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.socket.close(); }
}
