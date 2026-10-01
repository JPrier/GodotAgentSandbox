#!/usr/bin/env node
// gck — agent-facing CLI for the godot-cloud-kit bridge server.
// Every command prints JSON (or a short summary) so agents can parse results.
//   GCK_URL   server base URL (default http://localhost:8790)
//   GCK_TOKEN optional bearer token
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.env.GCK_URL || 'http://localhost:8790').replace(/\/$/, '');
const TOKEN = process.env.GCK_TOKEN || '';

const HELP = `gck — drive Godot games running in a browser from a cloud agent

Projects
  gck list                                  list projects, last build, live sessions
  gck new <id> [--name "Title"]             create from template (git repo, first build)
  gck adopt <id> <path>                     register an existing Godot project + install bridge
  gck status <id>                           project status
  gck update-bridge <id>                    copy the latest AgentBridge addon into the project
  gck set <id> autoBuild=true testOnBuild=false ...

Build & verify (headless, on the server)
  gck build <id> [--tests] [--force] [--no-reload]
  gck validate <id>                         load every script/scene, report errors with file:line
  gck test <id> [filter] [--browser]        run tests/test_*.gd headless (or in the live browser)
  gck export <id> [--release]               standalone web build (index.html + wasm + pck)
  gck history <id>                          git snapshots of good builds

Live game (in the user's browser)
  gck play-url <id>                         URL the user opens to play/preview
  gck sessions <id>
  gck shot <id> [-o file.png] [--width 960] screenshot from the browser renderer
  gck state <id>                            info + get_agent_state() hooks
  gck tree <id> [node/path] [--depth 3] [--props]
  gck eval <id> "<expression>" [--path node]  Godot Expression; vars: tree, root, scene, bridge
  gck get <id> <node/path> <property>
  gck set-prop <id> <node/path> <property> <json-value | --expr "Vector2(1,2)">
  gck call <id> <node/path> <method> [jsonArgs...]
  gck input <id> --action move_right [--frames 30] | --key Space | --mouse 100,200
  gck wait <id> [--frames N] [--seconds S]
  gck scene <id> <res://path.tscn>          change scene (or "reload")
  gck reload <id>                           restart the game on the latest good build
  gck cmd <id> <command> [jsonArgs]         raw bridge command
  gck logs <id> [--since N] [--errors] [--follow]

Files (only needed when the agent is not on the server machine)
  gck pull <id> <remote/path> [local]       gck push <id> <local> <remote/path>   gck ls <id> [dir]
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') { flags.o = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['tests', 'force', 'no-reload', 'browser', 'release', 'props', 'errors', 'follow'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function api(method, url, body, { raw = false } = {}) {
  const headers = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let payload;
  if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(BASE + url, { method, headers, body: payload }); }
  catch (e) { die(`cannot reach ${BASE} (${e.cause?.code || e.message}). Is the server running? (npm start)`); }
  if (raw) { if (!r.ok) die(`${r.status} ${await r.text()}`); return Buffer.from(await r.arrayBuffer()); }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) die(typeof data === 'object' ? data.error || JSON.stringify(data) : data, r.status);
  return data;
}

function die(msg, status) {
  console.error(`gck: ${msg}`);
  process.exit(status === 401 ? 3 : 1);
}
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const cmd = (id, c, args = {}, extra = {}) => api('POST', `/api/projects/${id}/command`, { cmd: c, args, ...extra });
function need(v, what) { if (!v) die(`missing ${what}\n\n${HELP}`); return v; }
function parseVal(s) { try { return JSON.parse(s); } catch { return s; } }

/** Exit code 1 when a live command fails, so agents can branch on $?. */
function finish(r) { out(r); if (r && r.ok === false) process.exit(1); }

const { pos, flags } = parseArgs(process.argv.slice(2));
const [command, id, ...rest] = pos;

switch (command) {
  case undefined: case 'help': case '-h': out(HELP); break;
  case 'list': {
    const list = await api('GET', '/api/projects');
    for (const p of list) out(`${p.id.padEnd(24)} ${p.lastBuild ? `build ${p.lastBuild.n} ${p.lastBuild.ok ? 'ok    ' : 'FAILED'}` : 'not built   '}  ${p.sessions.length} live  ${p.path}`);
    if (!list.length) out('(no projects) — gck new <id>');
    break;
  }
  case 'new': out(await api('POST', '/api/projects', { id: need(id, 'id'), name: flags.name })); break;
  case 'adopt': out(await api('POST', '/api/projects/adopt', { id: need(id, 'id'), path: path.resolve(need(rest[0], 'path')) })); break;
  case 'status': out(await api('GET', `/api/projects/${need(id, 'id')}`)); break;
  case 'update-bridge': out(await api('POST', `/api/projects/${need(id, 'id')}/update-bridge`)); break;
  case 'set': {
    const patch = Object.fromEntries(rest.map((kv) => { const [k, v] = kv.split('='); return [k, v === 'true']; }));
    out(await api('PATCH', `/api/projects/${need(id, 'id')}`, patch));
    break;
  }
  case 'build': {
    const r = await api('POST', `/api/projects/${need(id, 'id')}/build`, { tests: !!flags.tests, force: !!flags.force, reload: !flags['no-reload'], reason: flags.reason || 'cli' });
    out(r);
    process.exit(r.ok ? 0 : 1);
  }
  case 'validate': { const r = await api('POST', `/api/projects/${need(id, 'id')}/validate`); out(r); process.exit(r.ok ? 0 : 1); }
  case 'test': {
    const r = await api('POST', `/api/projects/${need(id, 'id')}/test`, { filter: rest[0] || '', where: flags.browser ? 'browser' : 'headless' });
    out(r);
    process.exit(r.ok ? 0 : 1);
  }
  case 'export': out({ ...(await api('POST', `/api/projects/${need(id, 'id')}/export`, { release: !!flags.release })), base: BASE }); break;
  case 'history': out(await api('GET', `/api/projects/${need(id, 'id')}/history`)); break;
  case 'play-url': out(`${BASE}/play/${need(id, 'id')}${TOKEN ? `?token=${TOKEN}` : ''}`); break;
  case 'sessions': out(await api('GET', `/api/projects/${need(id, 'id')}/sessions`)); break;
  case 'shot': case 'screenshot': {
    const r = await api('POST', `/api/projects/${need(id, 'id')}/screenshot`, { max_width: Number(flags.width || 1280), session: flags.session });
    if (!r.ok) finish(r);
    let file = r.path;
    if (flags.o) { await fs.writeFile(flags.o, await api('GET', r.url, undefined, { raw: true })); file = path.resolve(flags.o); }
    out({ ok: true, file, url: BASE + r.url, width: r.width, height: r.height });
    break;
  }
  case 'state': finish(await cmd(need(id, 'id'), 'state')); break;
  case 'tree': finish(await cmd(need(id, 'id'), 'tree', { path: rest[0] || '', depth: Number(flags.depth || 3), props: !!flags.props })); break;
  case 'eval': finish(await cmd(need(id, 'id'), 'eval', { expr: need(rest[0], 'expression'), path: flags.path || '' })); break;
  case 'get': finish(await cmd(need(id, 'id'), 'get', { path: need(rest[0], 'node path'), property: need(rest[1], 'property') })); break;
  case 'set-prop': {
    const args = { path: need(rest[0], 'node path'), property: need(rest[1], 'property') };
    if (flags.expr) args.expr = flags.expr; else args.value = parseVal(need(rest[2], 'value'));
    finish(await cmd(id, 'set', args));
    break;
  }
  case 'call': finish(await cmd(need(id, 'id'), 'call', { path: need(rest[0], 'node path'), method: need(rest[1], 'method'), args: rest.slice(2).map(parseVal) })); break;
  case 'input': {
    const a = {};
    if (flags.action) a.action = flags.action;
    if (flags.key) a.key = flags.key;
    if (flags.mouse) a.mouse = String(flags.mouse).split(',').map(Number);
    if (flags.frames) a.frames = Number(flags.frames);
    if (flags.release) a.pressed = false;
    finish(await cmd(need(id, 'id'), 'input', a));
    break;
  }
  case 'wait': finish(await cmd(need(id, 'id'), 'wait', { frames: Number(flags.frames || 0), ...(flags.seconds ? { seconds: Number(flags.seconds) } : {}) })); break;
  case 'scene': finish(rest[0] === 'reload' ? await cmd(need(id, 'id'), 'reload_scene') : await cmd(need(id, 'id'), 'change_scene', { path: need(rest[0], 'scene path') })); break;
  case 'reload': out(await api('POST', `/api/projects/${need(id, 'id')}/reload`, {})); break;
  case 'cmd': finish(await cmd(need(id, 'id'), need(rest[0], 'command'), rest[1] ? JSON.parse(rest[1]) : {})); break;
  case 'logs': {
    let since = Number(flags.since || 0);
    const level = flags.errors ? 'error' : '';
    do {
      const r = await api('GET', `/api/projects/${need(id, 'id')}/logs?since=${since}${level ? `&level=${level}` : ''}`);
      for (const e of r.logs) console.log(`#${e.seq} ${e.time.slice(11, 19)} ${e.level.padEnd(7)} ${e.source.padEnd(16)} ${e.file ? `${e.file}:${e.line} ` : ''}${e.text}`);
      since = r.seq;
      if (flags.follow) await new Promise((res) => setTimeout(res, 1000));
    } while (flags.follow);
    break;
  }
  case 'ls': out(await api('GET', `/api/projects/${need(id, 'id')}/files?path=${encodeURIComponent(rest[0] || '')}`)); break;
  case 'pull': {
    const data = await api('GET', `/api/projects/${need(id, 'id')}/files?path=${encodeURIComponent(need(rest[0], 'remote path'))}`, undefined, { raw: true });
    if (rest[1]) await fs.writeFile(rest[1], data); else process.stdout.write(data);
    break;
  }
  case 'push': out(await api('PUT', `/api/projects/${need(id, 'id')}/files?path=${encodeURIComponent(need(rest[1], 'remote path'))}`, await fs.readFile(need(rest[0], 'local file')))); break;
  default: die(`unknown command: ${command}\n\n${HELP}`);
}
