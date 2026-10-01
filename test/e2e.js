// End-to-end check: real browser + real server + real Godot.
//   GCK_URL=http://localhost:8790 node test/e2e.js [project-id]
// Uses Playwright's Chromium (or CHROME_PATH). Exits non-zero on failure.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.GCK_URL || 'http://localhost:8790';
const ID = process.argv[2] || `e2e-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
async function waitFor(fn, ms = 60000, every = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); }
  return null;
}
const liveSession = (build) => async () => {
  const s = await api('GET', `/api/projects/${ID}/sessions`);
  return s.find((x) => x.kind === 'browser' && x.state === 'running' && (build == null || x.build === build));
};

const existing = await api('GET', `/api/projects/${ID}`);
if (existing.error) {
  const created = await api('POST', '/api/projects', { id: ID });
  check('create project + initial build', created.build?.ok, `${created.build?.ms}ms`);
}
const status = await api('GET', `/api/projects/${ID}`);
const projectPath = status.path;

const browser = await chromium.launch({
  executablePath: [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(existsSync),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('  [page error]', e.message));
await page.goto(`${BASE}/play/${ID}`);

const s1 = await waitFor(liveSession(), 90000);
check('browser session running', !!s1, s1 ? `build ${s1.build}, sid ${s1.sid}` : 'timed out');
const bridgeUp = await waitFor(async () => (await api('POST', `/api/projects/${ID}/command`, { cmd: 'ping', timeoutMs: 3000 })).ok, 30000, 1000);
check('game bridge answers ping', !!bridgeUp);

const info = await api('POST', `/api/projects/${ID}/command`, { cmd: 'info' });
check('info', info.ok && info.result.web === true, `${info.result?.engine} scene=${info.result?.scene}`);

const shot = await api('POST', `/api/projects/${ID}/screenshot`, { max_width: 960 });
let shotOk = false;
if (shot.ok) {
  const buf = await fs.readFile(shot.path);
  shotOk = buf.length > 2000 && buf.subarray(1, 4).toString() === 'PNG';
  await fs.copyFile(shot.path, path.join(process.env.E2E_OUT || '.', `e2e-screenshot-1.png`)).catch(() => {});
}
check('screenshot from browser renderer', shotOk, shot.ok ? `${shot.width}x${shot.height} ${shot.url}` : shot.error);

const st1 = await api('POST', `/api/projects/${ID}/command`, { cmd: 'state' });
await api('POST', `/api/projects/${ID}/command`, { cmd: 'eval', args: { expr: 'scene.coin.set("position", Vector2(-500, -500))' } });
const inp = await api('POST', `/api/projects/${ID}/command`, { cmd: 'input', args: { action: 'move_right', frames: 30 } });
const st2 = await api('POST', `/api/projects/${ID}/command`, { cmd: 'state' });
const dx = (st2.result?.scene?.player?.x ?? 0) - (st1.result?.scene?.player?.x ?? 0);
check('input moves player (state hook)', inp.ok && dx > 40, `dx=${dx.toFixed?.(1)}`);

const tree = await api('POST', `/api/projects/${ID}/command`, { cmd: 'tree', args: { depth: 1 } });
check('scene tree', tree.ok && tree.result.children?.some((c) => c.name === 'Player'), tree.result?.children?.map((c) => c.name).join(','));

const bad = await api('POST', `/api/projects/${ID}/command`, { cmd: 'eval', args: { expr: 'nope(' } });
check('eval errors are reported', bad.ok === false && /parse/i.test(bad.error), bad.error);

const tests = await api('POST', `/api/projects/${ID}/test`, { where: 'browser' });
check('tests in browser', tests.ok && tests.passed === tests.total && tests.total > 0, `${tests.passed}/${tests.total}`);

const htests = await api('POST', `/api/projects/${ID}/test`, { where: 'headless' });
check('tests headless on server', htests.ok, `${htests.passed}/${htests.total} in ${htests.ms}ms`);

// Hot reload: edit a file on disk -> watcher builds -> browser reloads new .pck.
const before = s1.build;
const mainGd = path.join(projectPath, 'main.gd');
const src = await fs.readFile(mainGd, 'utf8');
await fs.writeFile(mainGd, src.replace('const SPEED := 320.0', 'const SPEED := 321.0'));
const t0 = Date.now();
const s2 = await waitFor(async () => { const s = await liveSession()(); return s && s.build > before ? s : null; }, 90000);
check('file edit -> auto build -> browser hot reload', !!s2, s2 ? `build ${before} → ${s2.build} in ${Date.now() - t0}ms` : 'timed out');
await waitFor(async () => (await api('POST', `/api/projects/${ID}/command`, { cmd: 'ping', timeoutMs: 3000 })).ok, 30000, 500);
const speed = await api('POST', `/api/projects/${ID}/command`, { cmd: 'eval', args: { expr: 'scene.get_script().get_script_constant_map()["SPEED"]' } });
check('new code is live', speed.result === 321, `SPEED=${speed.result}`);

// Broken edit: build fails, browser keeps running the last good build and shows the error.
const okBuild = s2?.build;
await fs.writeFile(mainGd, src.replace('score += 1', 'score += oops_undefined'));
const failed = await waitFor(async () => { const p = await api('GET', `/api/projects/${ID}`); return p.lastBuild && p.lastBuild.n > okBuild && !p.building ? p.lastBuild : null; }, 90000);
const errText = JSON.stringify(failed?.steps?.validate?.errors || []);
check('broken script fails the build with file:line', failed && !failed.ok && /main\.gd/.test(errText) && /oops_undefined/.test(errText), failed ? `build ${failed.n}` : 'timed out');
await sleep(500);
const still = await liveSession(okBuild)();
check('browser keeps last good build', !!still, `still on build ${still?.build}`);
const overlayVisible = await page.locator('#overlay:not([hidden])').count();
check('failure overlay shown to the human', overlayVisible === 1);
await page.screenshot({ path: path.join(process.env.E2E_OUT || '.', 'e2e-shell-failure.png') });

await fs.writeFile(mainGd, src);
const s3 = await waitFor(async () => { const s = await liveSession()(); return s && s.build > (failed?.n ?? 0) ? s : null; }, 90000);
check('fix -> recovers', !!s3, `build ${s3?.build}`);
await waitFor(async () => (await api('POST', `/api/projects/${ID}/command`, { cmd: 'ping', timeoutMs: 3000 })).ok, 30000, 500);
await sleep(800);
await page.screenshot({ path: path.join(process.env.E2E_OUT || '.', 'e2e-shell.png') });

const logs = await api('GET', `/api/projects/${ID}/logs?level=error`);
check('error log stream available', Array.isArray(logs.logs), `${logs.logs.length} error entries`);
const hist = await api('GET', `/api/projects/${ID}/history`);
check('git snapshots per good build', hist.length >= 2, hist.slice(0, 3).map((h) => h.subject).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
