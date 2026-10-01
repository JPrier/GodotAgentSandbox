// godot-cloud-kit bridge server: HTTP API + static hosting + WebSockets.
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import * as projects from './projects.js';
import * as builder from './builder.js';
import * as godot from './godot.js';
import { hub } from './hub.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.zip': 'application/zip',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- helpers

function baseHeaders(extra = {}) {
  // Cross-origin isolation lets threaded builds and the web editor use SharedArrayBuffer.
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, baseHeaders({ 'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers }));
  res.end(payload);
}

async function readBody(req, limit = 256 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw projects.httpError(413, 'body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const b = await readBody(req, 64 << 20);
  if (!b.length) return {};
  try { return JSON.parse(b.toString()); } catch { throw projects.httpError(400, 'invalid JSON body'); }
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (url.searchParams.get('token')) return url.searchParams.get('token');
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)gck_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function authorized(req, url) {
  return !config.token || tokenFrom(req, url) === config.token;
}

async function serveFile(res, file, { immutable = false, req } = {}) {
  let st;
  try { st = await fs.stat(file); } catch { return send(res, 404, 'not found'); }
  if (st.isDirectory()) return serveFile(res, path.join(file, 'index.html'), { immutable, req });
  const headers = baseHeaders({
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.writeHead(200, headers);
  if (req?.method === 'HEAD') return res.end();
  fss.createReadStream(file).pipe(res);
}

function staticUnder(root, rel) {
  const p = path.resolve(root, '.' + path.sep + decodeURIComponent(rel));
  if (p !== root && !p.startsWith(root + path.sep)) throw projects.httpError(400, 'bad path');
  return p;
}

// ---------------------------------------------------------------- API

async function projectStatus(p) {
  const h = hub(p.id);
  return {
    id: p.id, path: p.path,
    settings: { autoBuild: p.autoBuild, autoCommit: p.autoCommit, validateOnBuild: p.validateOnBuild ?? true, testOnBuild: p.testOnBuild ?? false },
    building: builder.isBuilding(p.id),
    lastBuild: builder.compactRecord(await builder.getLastBuild(p.id)),
    lastGoodBuild: (await builder.getLastGoodBuild(p.id))?.n ?? null,
    sessions: h.summary(),
    playUrl: `/play/${p.id}`,
  };
}

async function saveScreenshot(id, result) {
  const dir = builder.stateDir(id, 'screenshots');
  await fs.mkdir(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.${result.format === 'jpg' ? 'jpg' : 'png'}`;
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(result.data, 'base64'));
  // keep the last 50
  const all = (await fs.readdir(dir)).sort();
  for (const old of all.slice(0, -50)) await fs.rm(path.join(dir, old), { force: true });
  return { path: file, url: `/screenshots/${id}/${name}`, width: result.width, height: result.height };
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/health', async () => {
  const engine = await builder.ensureEngine().catch((e) => ({ error: e.message }));
  return { ok: !engine.error, engine, home: config.home, editorInstalled: fss.existsSync(path.join(config.editorDir, 'index.html')) };
});

route('GET', '/api/projects', async () => {
  const all = await projects.listProjects();
  return Promise.all(Object.values(all).map(projectStatus));
});

route('POST', '/api/projects', async ({ req }) => {
  const body = await readJson(req);
  const p = await projects.createProject(body.id, { name: body.name });
  await builder.watchProject(p.id);
  const rec = body.build === false ? null : await builder.build(p.id, { reason: 'initial build' });
  return { project: await projectStatus(p), build: builder.compactRecord(rec) };
});

route('POST', '/api/projects/adopt', async ({ req }) => {
  const body = await readJson(req);
  const { project, notes } = await projects.adoptProject(body.id, body.path, { installBridge: body.installBridge !== false });
  await builder.watchProject(project.id);
  return { project: await projectStatus(project), notes };
});

route('GET', '/api/projects/:id', async ({ params }) => projectStatus(await projects.getProject(params.id)));

// Re-copy the kit's AgentBridge addon into the project (after upgrading the kit).
route('POST', '/api/projects/:id/update-bridge', async ({ params }) => {
  const p = await projects.getProject(params.id);
  await projects.installAddon(p.path);
  return { ok: true, note: 'addon updated; the file watcher will rebuild' };
});

route('PATCH', '/api/projects/:id', async ({ params, req }) => {
  const p = await projects.updateSettings(params.id, await readJson(req));
  builder.unwatchProject(p.id);
  await builder.watchProject(p.id);
  return projectStatus(p);
});

route('POST', '/api/projects/:id/build', async ({ params, req }) => {
  await projects.getProject(params.id);
  const body = await readJson(req);
  return builder.compactRecord(await builder.build(params.id, { reason: body.reason || 'api', ...body }));
});

route('GET', '/api/projects/:id/builds/:n', async ({ params }) => {
  const f = path.join(builder.stateDir(params.id, 'builds', String(Number(params.n))), 'build.json');
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { throw projects.httpError(404, 'no such build'); }
});

route('POST', '/api/projects/:id/validate', async ({ params }) => {
  const p = await projects.getProject(params.id);
  await godot.importProject(p.path);
  return godot.validateProject(p.path);
});

route('POST', '/api/projects/:id/test', async ({ params, req }) => {
  const p = await projects.getProject(params.id);
  const body = await readJson(req);
  if (body.where === 'browser') {
    const r = await hub(p.id).command('run_tests', { filter: body.filter || '' }, { sid: body.session, timeoutMs: body.timeoutMs || 120000 });
    return r.ok ? { where: 'browser', sid: r.sid, ...r.result } : r;
  }
  await godot.importProject(p.path);
  return { where: 'headless', ...(await godot.testProject(p.path, body.filter)) };
});

route('POST', '/api/projects/:id/export', async ({ params, req }) => {
  const p = await projects.getProject(params.id);
  const body = await readJson(req);
  const out = builder.stateDir(p.id, 'export');
  const r = await godot.exportFull(p.path, out, { release: body.release === true });
  return { ...r, url: r.ok ? `/exports/${p.id}/index.html` : null, dir: out };
});

route('POST', '/api/projects/:id/command', async ({ params, req }) => {
  await projects.getProject(params.id);
  const body = await readJson(req);
  if (!body.cmd) throw projects.httpError(400, 'cmd required');
  return hub(params.id).command(body.cmd, body.args || {}, { sid: body.session, timeoutMs: body.timeoutMs });
});

route('POST', '/api/projects/:id/screenshot', async ({ params, req }) => {
  await projects.getProject(params.id);
  const body = await readJson(req);
  const r = await hub(params.id).command('screenshot', { max_width: body.max_width ?? 1280, format: body.format || 'png' }, { sid: body.session });
  if (!r.ok) return r;
  return { ok: true, sid: r.sid, ...(await saveScreenshot(params.id, r.result)) };
});

route('POST', '/api/projects/:id/reload', async ({ params, req }) => {
  await projects.getProject(params.id);
  const body = await readJson(req);
  const good = await builder.getLastGoodBuild(params.id);
  if (!good) throw projects.httpError(409, 'no playable build yet');
  hub(params.id).broadcastSessions({ type: 'build', n: body.build ?? good.n, ok: true, playable: true, pckUrl: `/builds/${params.id}/${body.build ?? good.n}/game.pck`, reload: true }, 'browser');
  return { ok: true, build: body.build ?? good.n, sessions: hub(params.id).summary().length };
});

route('GET', '/api/projects/:id/logs', async ({ params, url }) => {
  await projects.getProject(params.id);
  const q = url.searchParams;
  const h = hub(params.id);
  return { seq: h.seq, logs: h.getLogs({ since: Number(q.get('since') || 0), level: q.get('level'), source: q.get('source'), limit: Number(q.get('limit') || 500) }) };
});

route('GET', '/api/projects/:id/sessions', async ({ params }) => hub((await projects.getProject(params.id)).id).summary());

route('GET', '/api/projects/:id/history', async ({ params }) => projects.gitLog((await projects.getProject(params.id)).path, 30));

// Files API — for agents that run somewhere other than this server.
route('GET', '/api/projects/:id/files', async ({ params, url, res }) => {
  const p = await projects.getProject(params.id);
  const rel = url.searchParams.get('path') || '';
  const abs = projects.safeJoin(p.path, rel);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw projects.httpError(404, 'not found');
  if (st.isDirectory()) return projects.listFiles(p.path, rel);
  send(res, 200, await fs.readFile(abs));
});

route('PUT', '/api/projects/:id/files', async ({ params, url, req }) => {
  const p = await projects.getProject(params.id);
  const abs = projects.safeJoin(p.path, url.searchParams.get('path'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, await readBody(req));
  return { ok: true, path: path.relative(p.path, abs) };
});

route('DELETE', '/api/projects/:id/files', async ({ params, url }) => {
  const p = await projects.getProject(params.id);
  const abs = projects.safeJoin(p.path, url.searchParams.get('path'));
  if (abs === p.path) throw projects.httpError(400, 'refusing to delete project root');
  await fs.rm(abs, { recursive: true, force: true });
  return { ok: true };
});

// Zip round trip for the browser-based Godot editor.
route('GET', '/api/projects/:id/source.zip', async ({ params, res }) => {
  const p = await projects.getProject(params.id);
  send(res, 200, await projects.zipProject(p.path), { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${p.id}.zip"` });
});

route('POST', '/api/projects/:id/source.zip', async ({ params, req, url }) => {
  const p = await projects.getProject(params.id);
  const changed = await projects.applyZip(p.path, await readBody(req), { deleteMissing: url.searchParams.get('delete') === '1' });
  const commit = changed.length ? await projects.gitSnapshot(p.path, `gck: import ${changed.length} file(s) from web editor`).catch(() => null) : null;
  hub(p.id).log('hub', 'info', `applied zip: ${changed.length} file(s) changed`);
  return { ok: true, changed, commit };
});

// Info the browser shell needs to boot the engine.
route('GET', '/api/projects/:id/boot', async ({ params }) => {
  const p = await projects.getProject(params.id);
  const engine = await builder.ensureEngine();
  const good = await builder.getLastGoodBuild(p.id);
  return { project: p.id, engine: { version: engine.version, base: engine.urlBase }, build: good ? { n: good.n, pckUrl: `/builds/${p.id}/${good.n}/game.pck` } : null, building: builder.isBuilding(p.id) };
});

// ---------------------------------------------------------------- HTTP server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // Visiting any page with ?token=... stores it in a cookie so the shell's fetch/ws calls carry it.
    const setCookie = config.token && url.searchParams.get('token') === config.token
      ? { 'Set-Cookie': `gck_token=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Strict` } : {};

    if (p.startsWith('/api/')) {
      if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        const out = await r.handler({ req, res, url, params: m.groups || {} });
        if (!res.headersSent) send(res, 200, out ?? { ok: true });
        return;
      }
      return send(res, 404, { error: `no route ${req.method} ${p}` });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (!authorized(req, url)) return send(res, 401, 'unauthorized — open with ?token=...');
    if (Object.keys(setCookie).length) res.setHeader('Set-Cookie', setCookie['Set-Cookie']);

    if (p === '/' || p === '/index.html') return serveFile(res, path.join(config.webDir, 'index.html'), { req });
    if (/^\/play\/[^/]+\/?$/.test(p)) return serveFile(res, path.join(config.webDir, 'play.html'), { req });
    if (p === '/player.html') return serveFile(res, path.join(config.webDir, 'player.html'), { req });
    if (p.startsWith('/static/')) return serveFile(res, staticUnder(config.webDir, p.slice(8)), { req });
    if (p.startsWith('/engine/')) return serveFile(res, staticUnder(config.engineDir, p.slice(8)), { immutable: true, req });
    if (p.startsWith('/builds/')) return serveFile(res, staticUnder(config.stateDir, p.slice(8).replace(/^([^/]+)\//, '$1/builds/')), { immutable: true, req });
    if (p.startsWith('/screenshots/')) return serveFile(res, staticUnder(config.stateDir, p.slice(13).replace(/^([^/]+)\//, '$1/screenshots/')), { req });
    if (p.startsWith('/exports/')) return serveFile(res, staticUnder(config.stateDir, p.slice(9).replace(/^([^/]+)\//, '$1/export/')), { req });
    if (p === '/editor' || p.startsWith('/editor/')) {
      if (!fss.existsSync(path.join(config.editorDir, 'index.html'))) return send(res, 404, 'web editor not installed — run scripts/install-godot.sh --web-editor');
      return serveFile(res, staticUnder(config.editorDir, p.slice(7) || 'index.html'), { req });
    }
    return send(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  }
});

// ---------------------------------------------------------------- WebSockets
//   /ws/browser?project=ID   browser shell (relays to the game iframe)
//   /ws/game?project=ID      native/headless game running the AgentBridge addon directly
//   /ws/agent?project=ID     agent event stream (logs, builds, sessions)

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const kind = { '/ws/browser': 'browser', '/ws/game': 'native', '/ws/agent': 'agent' }[url.pathname];
  const id = url.searchParams.get('project');
  if (!kind || !authorized(req, url)) { socket.destroy(); return; }
  try { await projects.getProject(id); } catch { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const h = hub(id);
    if (kind === 'agent') {
      h.agents.add(ws);
      ws.send(JSON.stringify({ type: 'hello', project: id, sessions: h.summary(), lastBuild: builder.compactRecord(await builder.getLastBuild(id)) }));
      ws.on('close', () => h.agents.delete(ws));
      ws.on('message', async (raw) => {
        // Agents may also send commands over this socket: {id, cmd, args, session}
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (!m.cmd) return;
        const r = await h.command(m.cmd, m.args || {}, { sid: m.session });
        ws.send(JSON.stringify({ type: 'response', id: m.id, ...r }));
      });
      return;
    }
    h.attachSession(ws, kind, { info: { userAgent: req.headers['user-agent'] } });
  });
});

// keep-alive pings so proxies don't drop idle sockets
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25000).unref();

export async function start() {
  await fs.mkdir(config.projectsDir, { recursive: true });
  await fs.mkdir(config.stateDir, { recursive: true });
  const engine = await builder.ensureEngine().catch((e) => { console.error(e.message); return null; });
  await builder.watchAll();
  await new Promise((r) => server.listen(config.port, config.host, r));
  console.log(`godot-cloud-kit listening on http://${config.host}:${config.port}`);
  console.log(`  home:   ${config.home}`);
  console.log(`  engine: ${engine ? engine.version : 'MISSING (see above)'}`);
  if (config.token) console.log('  auth:   token required (open pages with ?token=...)');
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
