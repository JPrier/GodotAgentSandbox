// Project registry: projects created from the template live in GCK_HOME/projects/<id>;
// existing games can be "adopted" from any path (the AgentBridge addon gets installed into them).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { config } from './config.js';

const exec = promisify(execFile);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ZIP_EXCLUDE = /(^|\/)(\.godot|\.git|build|node_modules)(\/|$)/;

export function assertId(id) {
  if (!ID_RE.test(id || '')) throw httpError(400, 'project id must match ' + ID_RE);
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readRegistry() {
  try { return JSON.parse(await fs.readFile(config.registryFile, 'utf8')); } catch { return { projects: {} }; }
}
async function writeRegistry(reg) {
  await fs.mkdir(path.dirname(config.registryFile), { recursive: true });
  await fs.writeFile(config.registryFile, JSON.stringify(reg, null, 2));
}

/** All known projects: template-created folders plus adopted paths. */
export async function listProjects() {
  const out = {};
  await fs.mkdir(config.projectsDir, { recursive: true });
  for (const d of await fs.readdir(config.projectsDir, { withFileTypes: true })) {
    if (d.isDirectory() && fss.existsSync(path.join(config.projectsDir, d.name, 'project.godot'))) {
      out[d.name] = { id: d.name, path: path.join(config.projectsDir, d.name), autoBuild: true, autoCommit: true };
    }
  }
  const reg = await readRegistry();
  for (const [id, p] of Object.entries(reg.projects)) out[id] = { autoBuild: true, autoCommit: false, ...out[id], ...p, id };
  return out;
}

export async function getProject(id) {
  assertId(id);
  const p = (await listProjects())[id];
  if (!p) throw httpError(404, `unknown project: ${id}`);
  return p;
}

export async function updateSettings(id, patch) {
  const p = await getProject(id);
  const reg = await readRegistry();
  const allowed = ['autoBuild', 'autoCommit', 'validateOnBuild', 'testOnBuild'];
  reg.projects[id] = { ...(reg.projects[id] || { path: p.path }) };
  for (const k of allowed) if (k in patch) reg.projects[id][k] = Boolean(patch[k]);
  await writeRegistry(reg);
  return getProject(id);
}

async function copyDir(src, dst) {
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function git(cwd, ...args) {
  return exec('git', args, { cwd, maxBuffer: 32 << 20 });
}

export async function isGitRepo(dir) {
  return fss.existsSync(path.join(dir, '.git'));
}

/** git add -A && commit, if anything changed. Returns the commit sha or null. */
export async function gitSnapshot(dir, message) {
  if (!(await isGitRepo(dir))) return null;
  await git(dir, 'add', '-A');
  const { stdout } = await git(dir, 'status', '--porcelain');
  if (!stdout.trim()) return (await git(dir, 'rev-parse', 'HEAD').catch(() => ({ stdout: '' }))).stdout.trim() || null;
  await git(dir, '-c', 'user.name=gck-agent', '-c', 'user.email=gck@localhost', 'commit', '-q', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
}

export async function gitLog(dir, n = 20) {
  if (!(await isGitRepo(dir))) return [];
  const { stdout } = await git(dir, 'log', `-n${n}`, '--pretty=format:%H%x09%ad%x09%s', '--date=iso');
  return stdout.split('\n').filter(Boolean).map((l) => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject }; });
}

export async function installAddon(projectPath) {
  const dst = path.join(projectPath, 'addons', 'agent_bridge');
  await fs.rm(dst, { recursive: true, force: true });
  await copyDir(config.addonDir, dst);
}

export async function createProject(id, { name } = {}) {
  assertId(id);
  const dir = path.join(config.projectsDir, id);
  if (fss.existsSync(dir)) throw httpError(409, `project already exists: ${id}`);
  await copyDir(config.templateDir, dir);
  await installAddon(dir);
  const pg = path.join(dir, 'project.godot');
  await fs.writeFile(pg, (await fs.readFile(pg, 'utf8')).replace('__PROJECT_NAME__', name || id));
  await git(dir, 'init', '-q', '-b', 'main');
  await gitSnapshot(dir, 'gck: create project from template');
  return getProject(id);
}

/** Register an existing Godot project and wire in the bridge without touching game code. */
export async function adoptProject(id, projectPath, { installBridge = true } = {}) {
  assertId(id);
  const abs = path.resolve(projectPath);
  const pg = path.join(abs, 'project.godot');
  if (!fss.existsSync(pg)) throw httpError(400, `no project.godot in ${abs}`);
  const notes = [];
  if (installBridge) {
    await installAddon(abs);
    let text = await fs.readFile(pg, 'utf8');
    if (!/^AgentBridge=/m.test(text)) {
      const line = 'AgentBridge="*res://addons/agent_bridge/agent_bridge.gd"';
      text = /^\[autoload\]\s*$/m.test(text)
        ? text.replace(/^\[autoload\]\s*$/m, `[autoload]\n\n${line}`)
        : text.trimEnd() + `\n\n[autoload]\n\n${line}\n`;
      notes.push('added AgentBridge autoload');
    }
    if (!/rendering_method\.web=/.test(text) && !/rendering_method="gl_compatibility"/.test(text)) {
      text = /^\[rendering\]\s*$/m.test(text)
        ? text.replace(/^\[rendering\]\s*$/m, '[rendering]\n\nrenderer/rendering_method.web="gl_compatibility"')
        : text.trimEnd() + '\n\n[rendering]\n\nrenderer/rendering_method.web="gl_compatibility"\n';
      notes.push('web builds forced to the Compatibility renderer (Forward+/Mobile do not run in browsers)');
    }
    await fs.writeFile(pg, text);
    const presets = path.join(abs, 'export_presets.cfg');
    const existing = fss.existsSync(presets) ? await fs.readFile(presets, 'utf8') : '';
    if (!new RegExp(`^name="${config.exportPreset}"`, 'm').test(existing)) {
      const tpl = await fs.readFile(path.join(config.templateDir, 'export_presets.cfg'), 'utf8');
      const idx = [...existing.matchAll(/^\[preset\.(\d+)\]/gm)].length;
      const block = tpl.replace(/\[preset\.0\]/, `[preset.${idx}]`).replace(/\[preset\.0\.options\]/, `[preset.${idx}.options]`);
      await fs.writeFile(presets, existing ? existing.trimEnd() + '\n\n' + block : block);
      notes.push(`added "${config.exportPreset}" export preset`);
    }
  }
  const reg = await readRegistry();
  reg.projects[id] = { ...(reg.projects[id] || {}), path: abs };
  await writeRegistry(reg);
  return { project: await getProject(id), notes };
}

// ---------------------------------------------------------------- files (for agents not on this machine)

export function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.sep + (rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw httpError(400, 'path escapes project');
  if (/(^|[\\/])\.git([\\/]|$)/.test(path.relative(root, p))) throw httpError(400, 'refusing to touch .git');
  return p;
}

export async function listFiles(root, rel = '') {
  const base = safeJoin(root, rel);
  const out = [];
  async function walk(dir) {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      const r = path.relative(root, full).split(path.sep).join('/');
      if (ZIP_EXCLUDE.test(r)) continue;
      if (d.isDirectory()) await walk(full);
      else out.push({ path: r, size: (await fs.stat(full)).size });
    }
  }
  await walk(base);
  return out;
}

// ---------------------------------------------------------------- zip round trip (web editor)

export async function zipProject(root) {
  const zip = new AdmZip();
  for (const f of await listFiles(root)) zip.addFile(f.path, await fs.readFile(path.join(root, f.path)));
  return zip.toBuffer();
}

/** Apply a zip (e.g. "Download Project Source" from the web editor). Returns changed paths. */
export async function applyZip(root, buffer, { deleteMissing = false } = {}) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  // Zips from the web editor may wrap everything in one top-level folder.
  const names = entries.map((e) => e.entryName);
  const pgEntry = names.find((n) => n === 'project.godot' || /^[^/]+\/project\.godot$/.test(n));
  if (!pgEntry) throw httpError(400, 'zip does not contain project.godot');
  const prefix = pgEntry.slice(0, -'project.godot'.length);
  const changed = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel || ZIP_EXCLUDE.test(rel)) continue;
    seen.add(rel);
    const dst = safeJoin(root, rel);
    const data = e.getData();
    const old = await fs.readFile(dst).catch(() => null);
    if (old && old.equals(data)) continue;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, data);
    changed.push(rel);
  }
  if (deleteMissing) {
    for (const f of await listFiles(root)) {
      if (!seen.has(f.path) && !f.path.startsWith('addons/agent_bridge/')) {
        await fs.rm(path.join(root, f.path));
        changed.push(`-${f.path}`);
      }
    }
  }
  return changed;
}
