#!/usr/bin/env node
// MCP (stdio) server exposing the bridge as agent tools. Screenshots come back as images.
//   claude mcp add godot -e GCK_URL=http://localhost:8790 -- node /path/to/godot-cloud-kit/mcp/server.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.GCK_URL || 'http://localhost:8790').replace(/\/$/, '');
const TOKEN = process.env.GCK_TOKEN || '';

async function api(method, url, body, raw = false) {
  const headers = { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return Buffer.from(await r.arrayBuffer());
  const data = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }], isError: v?.ok === false });
const live = async (project, cmd, args = {}, session) => text(await api('POST', `/api/projects/${project}/command`, { cmd, args, session }));
const P = { project: z.string().describe('Project id') };
const S = { session: z.string().optional().describe('Session id (defaults to the newest running browser)') };

const server = new McpServer({ name: 'godot-cloud-kit', version: '0.1.0' }, {
  instructions: [
    'Build and playtest Godot games. Source files live on the server (edit them directly, or use the files API);',
    'saving triggers an automatic headless validate + web export, and the user\'s browser hot-reloads the new build.',
    'Workflow: edit files -> godot_build (or wait for auto-build) -> fix errors it reports with file:line ->',
    'godot_test -> godot_screenshot / godot_state / godot_input to check behaviour in the live browser session.',
    'Live tools need the user to have the play page open (godot_play_url).',
  ].join(' '),
});

server.tool('godot_list_projects', 'List projects with last build result and live sessions.', {}, async () => {
  const list = await api('GET', '/api/projects');
  return text(list.map((p) => ({ id: p.id, path: p.path, lastBuild: p.lastBuild && { n: p.lastBuild.n, ok: p.lastBuild.ok }, live: p.sessions.length, playUrl: BASE + p.playUrl })));
});

server.tool('godot_create_project', 'Create a new game from the starter template (git repo, first build).',
  { id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i), name: z.string().optional() },
  async ({ id, name }) => text(await api('POST', '/api/projects', { id, name })));

server.tool('godot_adopt_project', 'Register an existing Godot project directory on the server and install the AgentBridge addon.',
  { id: z.string(), path: z.string().describe('Absolute path on the server') },
  async ({ id, path }) => text(await api('POST', '/api/projects/adopt', { id, path })));

server.tool('godot_status', 'Project status: settings, last build (with failures), live sessions.', P,
  async ({ project }) => text(await api('GET', `/api/projects/${project}`)));

server.tool('godot_build', 'Import + validate + export a web build; reloads it in connected browsers. Returns errors with file:line.',
  { ...P, tests: z.boolean().optional().describe('Also run headless tests'), force: z.boolean().optional().describe('Export even if validation fails') },
  async ({ project, tests, force }) => text(await api('POST', `/api/projects/${project}/build`, { tests, force, reason: 'mcp' })));

server.tool('godot_validate', 'Headless check: loads every script/scene/resource and reports parse/load errors.', P,
  async ({ project }) => text(await api('POST', `/api/projects/${project}/validate`)));

server.tool('godot_test', 'Run tests/test_*.gd (GameTest). Headless on the server by default, or inside the live browser.',
  { ...P, filter: z.string().optional(), where: z.enum(['headless', 'browser']).optional() },
  async ({ project, filter, where }) => text(await api('POST', `/api/projects/${project}/test`, { filter, where })));

server.tool('godot_play_url', 'URL the user opens to play the game and keep the live session running.', P,
  async ({ project }) => text(`${BASE}/play/${project}${TOKEN ? `?token=${TOKEN}` : ''}`));

server.tool('godot_screenshot', 'Capture what the game is rendering in the user\'s browser right now.',
  { ...P, ...S, max_width: z.number().int().optional() },
  async ({ project, session, max_width }) => {
    const r = await api('POST', `/api/projects/${project}/screenshot`, { session, max_width: max_width ?? 960 });
    if (!r.ok) return text(r);
    const png = await api('GET', r.url, undefined, true);
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `${r.width}x${r.height} saved at ${r.path}` }] };
  });

server.tool('godot_state', 'Runtime info plus whatever the current scene/autoloads return from get_agent_state().', { ...P, ...S },
  async ({ project, session }) => live(project, 'state', {}, session));

server.tool('godot_tree', 'Live scene tree (names, classes, positions, scripts).',
  { ...P, ...S, path: z.string().optional(), depth: z.number().int().optional(), props: z.boolean().optional().describe('Include script variables') },
  async ({ project, session, path, depth, props }) => live(project, 'tree', { path: path || '', depth: depth ?? 3, props: !!props }, session));

server.tool('godot_eval', 'Evaluate a Godot Expression in the running game. Variables: tree, root, scene, bridge. No assignment; use obj.set("prop", value).',
  { ...P, ...S, expr: z.string(), path: z.string().optional().describe('Node used as `self`') },
  async ({ project, session, expr, path }) => live(project, 'eval', { expr, path: path || '' }, session));

server.tool('godot_input', 'Send input to the running game. Use action (InputMap name), key (e.g. "Space"), or mouse [x,y]. frames>0 holds then releases.',
  { ...P, ...S, action: z.string().optional(), key: z.string().optional(), mouse: z.array(z.number()).length(2).optional(), frames: z.number().int().optional(), pressed: z.boolean().optional() },
  async ({ project, session, ...a }) => live(project, 'input', Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), session));

server.tool('godot_command', 'Raw bridge command: ping, info, get, set, call, wait, change_scene, reload_scene, pause, time_scale, logs, run_tests, shell.reload, shell.info.',
  { ...P, ...S, cmd: z.string(), args: z.record(z.any()).optional() },
  async ({ project, session, cmd, args }) => live(project, cmd, args || {}, session));

server.tool('godot_logs', 'Merged log stream: build output, browser console, structured game errors (file:line, backtrace).',
  { ...P, since: z.number().int().optional(), errors_only: z.boolean().optional(), limit: z.number().int().optional() },
  async ({ project, since, errors_only, limit }) => text(await api('GET', `/api/projects/${project}/logs?since=${since || 0}&limit=${limit || 200}${errors_only ? '&level=error' : ''}`)));

server.tool('godot_reload', 'Restart the game in connected browsers on the latest good build.', P,
  async ({ project }) => text(await api('POST', `/api/projects/${project}/reload`, {})));

server.tool('godot_export', 'Produce a standalone web build (index.html + wasm + pck) for sharing.',
  { ...P, release: z.boolean().optional() },
  async ({ project, release }) => { const r = await api('POST', `/api/projects/${project}/export`, { release }); return text({ ...r, url: r.url ? BASE + r.url : null }); });

await server.connect(new StdioServerTransport());
