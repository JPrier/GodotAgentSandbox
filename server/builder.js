// Build pipeline: import -> validate -> export .pck -> git snapshot -> push to browsers.
// Builds are numbered per project and immutable; the browser reuses the cached engine
// (wasm/js) and only downloads the new .pck, so a rebuild-and-reload takes seconds.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config } from './config.js';
import * as godot from './godot.js';
import { gitSnapshot, listProjects, getProject } from './projects.js';
import { hub } from './hub.js';

const queues = new Map();   // id -> Promise chain
const watchers = new Map(); // id -> { watcher, timer }
const lastBuild = new Map(); // id -> build record
const buildingNow = new Set();

export const stateDir = (id, ...rest) => path.join(config.stateDir, id, ...rest);

let engineInfo = null;
/** Unpack the web export template once per Godot version; served at /engine/<version>/. */
export async function ensureEngine() {
  if (engineInfo) return engineInfo;
  const ver = await godot.godotVersion();
  const dir = path.join(config.engineDir, `${ver.templates}-${config.webTemplate}`);
  if (!fss.existsSync(path.join(dir, 'godot.wasm'))) {
    const zipPath = path.join(config.templatesDir, ver.templates, `${config.webTemplate}.zip`);
    if (!fss.existsSync(zipPath)) {
      throw new Error(`web export template missing: ${zipPath}\nRun scripts/install-godot.sh ${ver.short}`);
    }
    await fs.mkdir(dir, { recursive: true });
    new AdmZip(zipPath).extractAllTo(dir, true);
  }
  engineInfo = { version: ver.full, templates: ver.templates, dir, urlBase: `/engine/${path.basename(dir)}/` };
  return engineInfo;
}

function enqueue(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(id, next);
  return next;
}

async function nextBuildNumber(id) {
  const dir = stateDir(id, 'builds');
  await fs.mkdir(dir, { recursive: true });
  const nums = (await fs.readdir(dir)).map(Number).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export async function getLastBuild(id) {
  if (lastBuild.has(id)) return lastBuild.get(id);
  const dir = stateDir(id, 'builds');
  if (!fss.existsSync(dir)) return null;
  const nums = (await fs.readdir(dir)).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  for (const n of nums) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, String(n), 'build.json'), 'utf8'));
      lastBuild.set(id, rec);
      return rec;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Latest build that produced a playable .pck. */
export async function getLastGoodBuild(id) {
  const dir = stateDir(id, 'builds');
  if (!fss.existsSync(dir)) return null;
  const nums = (await fs.readdir(dir)).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  for (const n of nums) {
    if (fss.existsSync(path.join(dir, String(n), 'game.pck'))) {
      try { return JSON.parse(await fs.readFile(path.join(dir, String(n), 'build.json'), 'utf8')); } catch { /* skip */ }
    }
  }
  return null;
}

async function pruneBuilds(id) {
  const dir = stateDir(id, 'builds');
  const nums = (await fs.readdir(dir)).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  for (const n of nums.slice(config.keepBuilds)) await fs.rm(path.join(dir, String(n)), { recursive: true, force: true });
}

/**
 * Run the full pipeline. Options:
 *   validate (default: project.validateOnBuild ?? true) — skip export if validation fails
 *   tests    (default: project.testOnBuild ?? false)   — run headless tests too
 *   force    — export even if validation fails
 *   reason   — label stored in the build record / commit message
 */
export function build(id, opts = {}) {
  return enqueue(id, async () => {
    const project = await getProject(id);
    const h = hub(id);
    const engine = await ensureEngine();
    const n = await nextBuildNumber(id);
    const dir = stateDir(id, 'builds', String(n));
    await fs.mkdir(dir, { recursive: true });
    const started = Date.now();
    const rec = { project: id, n, reason: opts.reason || 'manual', startedAt: new Date(started).toISOString(), engine: engine.version, steps: {} };
    buildingNow.add(id);
    h.log('build', 'info', `build ${n} started (${rec.reason})`);
    h.broadcastSessions({ type: 'build_started', n });
    h.broadcastAgents({ type: 'build_started', n });
    const onLine = (line, stream) => {
      if (/^(SCRIPT ERROR|ERROR|WARNING|USER ERROR|USER WARNING)/.test(line)) h.log('build', /WARNING/.test(line) ? 'warning' : 'error', line);
    };
    try {
      const imp = await godot.importProject(project.path, onLine);
      rec.steps.import = { ok: imp.code === 0, ms: imp.ms };

      const doValidate = opts.validate ?? project.validateOnBuild ?? true;
      if (doValidate) {
        const v = await godot.validateProject(project.path, onLine);
        rec.steps.validate = v;
        if (!v.ok) h.log('build', 'error', `validation failed: ${summarizeValidation(v)}`);
      }
      const doTests = opts.tests ?? project.testOnBuild ?? false;
      if (doTests) {
        const t = await godot.testProject(project.path, opts.filter, onLine);
        rec.steps.tests = t;
        h.log('build', t.ok ? 'info' : 'error', `tests: ${t.passed ?? 0}/${t.total ?? 0} passed`);
      }
      const blocked = !opts.force && ((rec.steps.validate && !rec.steps.validate.ok) || (opts.requireTests && rec.steps.tests && !rec.steps.tests.ok));
      if (!blocked) {
        const ex = await godot.exportPack(project.path, path.join(dir, 'game.pck'), onLine);
        rec.steps.export = ex;
      }
      rec.ok = !blocked && rec.steps.export?.ok === true;
      rec.playable = rec.steps.export?.ok === true;
      if (rec.ok && (opts.commit ?? project.autoCommit)) {
        try { rec.commit = await gitSnapshot(project.path, `gck: build ${n} (${rec.reason})`); }
        catch (e) { rec.commitError = e.message; }
      }
    } catch (e) {
      rec.ok = false;
      rec.error = e.message;
    } finally {
      buildingNow.delete(id);
    }
    rec.ms = Date.now() - started;
    rec.pckUrl = rec.playable ? `/builds/${id}/${n}/game.pck` : null;
    await fs.writeFile(path.join(dir, 'build.json'), JSON.stringify(rec, null, 2));
    lastBuild.set(id, rec);
    await pruneBuilds(id);
    h.log('build', rec.ok ? 'info' : 'error', `build ${n} ${rec.ok ? 'succeeded' : 'FAILED'} in ${rec.ms}ms${rec.error ? `: ${rec.error}` : ''}`);
    const announce = { type: 'build', n, ok: rec.ok, playable: rec.playable, pckUrl: rec.pckUrl, reload: rec.ok && opts.reload !== false };
    h.broadcastSessions(announce);
    h.broadcastAgents({ ...announce, record: compactRecord(rec) });
    return rec;
  });
}

export function summarizeValidation(v) {
  const parts = [];
  for (const f of v.failures || []) parts.push(`${f.file}: ${f.problem}`);
  for (const e of v.errors || []) parts.push(`${e.file || ''}${e.line ? ':' + e.line : ''} ${e.text}`);
  if (v.message) parts.push(v.message);
  return parts.slice(0, 8).join(' | ') || 'unknown';
}

export function compactRecord(rec) {
  if (!rec) return rec;
  const out = { ...rec, steps: { ...rec.steps } };
  if (out.steps.tests?.results) out.steps.tests = { ...out.steps.tests, results: out.steps.tests.results.filter((r) => !r.passed) };
  return out;
}

export function isBuilding(id) { return buildingNow.has(id); }

// ---------------------------------------------------------------- watch & auto-build

// Ignore engine caches, VCS, and files Godot itself writes during import/export
// (including its atomic-save temp files like "foo.gd.uid-kLVXNN").
const IGNORE = /(^|\/)(\.godot|\.git|build|node_modules|\.gck)(\/|$)|\.(import|uid|tmp|swp)(-\w+)?$|~$|\.(\w+)-\w{6}$/;

export async function watchProject(id) {
  if (watchers.has(id)) return;
  const project = await getProject(id);
  if (!project.autoBuild) return;
  const entry = { timer: null, dirty: false };
  try {
    entry.watcher = fss.watch(project.path, { recursive: true }, (_ev, file) => {
      if (!file || IGNORE.test(String(file).split(path.sep).join('/'))) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        build(id, { reason: `files changed: ${file}` }).catch(() => {});
      }, config.buildDebounceMs);
    });
  } catch (e) {
    hub(id).log('build', 'warning', `file watching unavailable: ${e.message}`);
    return;
  }
  watchers.set(id, entry);
}

export function unwatchProject(id) {
  const w = watchers.get(id);
  if (w) { w.watcher?.close(); clearTimeout(w.timer); watchers.delete(id); }
}

export async function watchAll() {
  for (const id of Object.keys(await listProjects())) await watchProject(id).catch(() => {});
}
