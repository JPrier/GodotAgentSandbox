#!/usr/bin/env node
// Keeps a headless Chromium open on a project's play page, so the agent has a live
// browser session even when no human browser can reach the server (e.g. in a cloud sandbox).
//   node scripts/headless-player.js <project-id> [--url http://localhost:8790] [--width 1280 --height 720]
// Chromium: Playwright's bundled one, or CHROME_PATH. Runs until killed.
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!id) { console.error('usage: headless-player.js <project-id> [--url URL]'); process.exit(1); }

const base = flag('url', process.env.GCK_URL || 'http://localhost:8790').replace(/\/$/, '');
const token = process.env.GCK_TOKEN ? `?token=${encodeURIComponent(process.env.GCK_TOKEN)}` : '';
const candidates = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  executablePath,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: Number(flag('width', 1280)), height: Number(flag('height', 720)) } });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`${base}/play/${encodeURIComponent(id)}${token}`);
console.log(`headless player open on ${base}/play/${id} — the agent can now use live commands`);
const stop = async () => { await browser.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
