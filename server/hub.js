// Live session hub: browser shells and native games connect here; agents send commands
// through it and read the merged event/log stream.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const LOG_CAP = 3000;

class ProjectHub {
  constructor(id) {
    this.id = id;
    this.sessions = new Map();   // sid -> { ws, kind, info, state, build, connectedAt }
    this.pending = new Map();    // request id -> { resolve, timer, sid }
    this.agents = new Set();     // ws subscribers to the event stream
    this.logs = [];
    this.seq = 0;
  }

  log(source, level, text, extra = {}) {
    const entry = { seq: ++this.seq, time: new Date().toISOString(), source, level, text, ...extra };
    this.logs.push(entry);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
    this.broadcastAgents({ type: 'log', entry });
    return entry;
  }

  getLogs({ since = 0, level, source, limit = 500 } = {}) {
    let out = this.logs.filter((e) => e.seq > since);
    if (level) {
      const levels = level === 'error' ? ['error'] : level === 'warning' ? ['error', 'warning'] : null;
      if (levels) out = out.filter((e) => levels.includes(e.level));
    }
    if (source) out = out.filter((e) => e.source === source);
    return out.slice(-limit);
  }

  broadcastAgents(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.agents) if (ws.readyState === 1) ws.send(text);
  }

  broadcastSessions(msg, kind) {
    const text = JSON.stringify(msg);
    for (const s of this.sessions.values()) if ((!kind || s.kind === kind) && s.ws.readyState === 1) s.ws.send(text);
  }

  attachSession(ws, kind, meta = {}) {
    const sid = randomUUID().slice(0, 8);
    const s = { sid, ws, kind, info: {}, state: kind === 'native' ? 'running' : 'connecting', build: null, connectedAt: Date.now(), ...meta };
    this.sessions.set(sid, s);
    this.log('hub', 'info', `${kind} session ${sid} connected`);
    this.broadcastAgents({ type: 'session', sid, kind, connected: true });
    ws.on('message', (raw) => this.onSessionMessage(s, raw));
    ws.on('close', () => {
      this.sessions.delete(sid);
      for (const [id, p] of this.pending) if (p.sid === sid) { clearTimeout(p.timer); this.pending.delete(id); p.resolve({ ok: false, error: 'session disconnected' }); }
      this.log('hub', 'info', `${kind} session ${sid} disconnected`);
      this.broadcastAgents({ type: 'session', sid, kind, connected: false });
    });
    return s;
  }

  onSessionMessage(s, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case 'hello':
        Object.assign(s.info, msg.info || {});
        break;
      case 'status':
        s.state = msg.state;
        if (msg.build != null) s.build = msg.build;
        this.log(`${s.kind}:${s.sid}`, msg.state === 'crashed' ? 'error' : 'info', `game ${msg.state}${msg.build != null ? ` (build ${msg.build})` : ''}${msg.error ? `: ${msg.error}` : ''}`);
        this.broadcastAgents({ type: 'status', sid: s.sid, state: msg.state, build: s.build, error: msg.error });
        break;
      case 'console':
        this.log(`${s.kind}:${s.sid}`, msg.level || 'info', String(msg.text ?? ''));
        break;
      case 'event':
        if (msg.event === 'ready') { s.state = 'running'; Object.assign(s.info, msg); delete s.info.type; }
        if (msg.event === 'log' && msg.entry) {
          const e = msg.entry;
          this.log(`${s.kind}:${s.sid}`, e.level || 'info', e.text, e.file ? { file: e.file, line: e.line, kind: e.kind, backtrace: e.backtrace } : {});
        } else {
          this.broadcastAgents({ type: 'event', sid: s.sid, ...msg });
        }
        break;
      case 'response': {
        const p = this.pending.get(msg.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
        break;
      }
    }
  }

  pickSession(sid) {
    if (sid) return this.sessions.get(sid) || null;
    // Prefer the most recently connected running browser, then any session.
    const all = [...this.sessions.values()].sort((a, b) => b.connectedAt - a.connectedAt);
    return all.find((s) => s.kind === 'browser' && s.state === 'running') || all.find((s) => s.state === 'running') || all[0] || null;
  }

  /** Send a command to a live game and await its response. */
  command(cmd, args = {}, { sid, timeoutMs = config.commandTimeoutMs } = {}) {
    const s = this.pickSession(sid);
    if (!s) return Promise.resolve({ ok: false, error: 'no live game session — open the play page in a browser (or run the game natively with AGENT_BRIDGE_URL)' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: `timed out after ${timeoutMs}ms waiting for ${cmd}` }); }, timeoutMs);
      this.pending.set(id, { resolve: (r) => resolve({ ...r, sid: s.sid }), timer, sid: s.sid });
      s.ws.send(JSON.stringify({ type: 'command', id, cmd, args }));
    });
  }

  summary() {
    return [...this.sessions.values()].map((s) => ({
      sid: s.sid, kind: s.kind, state: s.state, build: s.build,
      connectedAt: new Date(s.connectedAt).toISOString(),
      scene: s.info.scene, engine: s.info.engine, userAgent: s.info.userAgent,
    }));
  }
}

const hubs = new Map();
export function hub(id) {
  if (!hubs.has(id)) hubs.set(id, new ProjectHub(id));
  return hubs.get(id);
}
