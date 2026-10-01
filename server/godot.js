// Thin wrappers around the headless Godot binary: import, validate, test, export.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

const ANSI = /\x1b\[[0-9;]*m/g;

export function runGodot(args, { cwd, timeoutMs = config.godotTimeoutMs, onLine } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(config.godotBin, ['--headless', ...args], { cwd, env: { ...process.env } });
    let out = '';
    let timedOut = false;
    const feed = (buf, stream) => {
      const text = buf.toString().replace(ANSI, '');
      out += text;
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line, stream);
    };
    child.stdout.on('data', (b) => feed(b, 'stdout'));
    child.stderr.on('data', (b) => feed(b, 'stderr'));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err), timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut, ms: Date.now() - started });
    });
  });
}

export async function godotVersion() {
  return new Promise((resolve, reject) => {
    execFile(config.godotBin, ['--version'], (err, stdout) => {
      if (err) return reject(new Error(`cannot run Godot (${config.godotBin}): ${err.message}`));
      const full = stdout.trim().split('\n').pop();
      // "4.7.2.stable.official.ed1daf0bf" -> templates folder "4.7.2.stable"
      const m = full.match(/^(\d+\.\d+(?:\.\d+)?)\.(\w+)/);
      resolve({ full, templates: m ? `${m[1]}.${m[2]}` : full, short: m ? m[1] : full });
    });
  });
}

/** Pull SCRIPT ERROR / ERROR lines out of raw Godot output as a fallback for crashes. */
export function scrapeErrors(output) {
  const lines = output.split('\n');
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(SCRIPT ERROR|ERROR|USER ERROR|SHADER ERROR):\s*(.*)$/);
    if (!m) continue;
    const at = (lines[i + 1] || '').match(/at:\s*(.*?)\s*\((.*?):(\d+)\)/);
    errors.push({ kind: m[1], text: m[2], function: at?.[1], file: at?.[2], line: at ? Number(at[3]) : undefined });
  }
  return errors;
}

export async function importProject(projectPath, onLine) {
  return runGodot(['--path', projectPath, '--import'], { onLine });
}

async function runReportMode(projectPath, flag, extra, onLine) {
  const tmp = path.join(os.tmpdir(), `gck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const res = await runGodot(['--path', projectPath, '--', flag, `--agent-out=${tmp}`, ...extra], { onLine });
  let report;
  try {
    report = JSON.parse(await fs.readFile(tmp, 'utf8'));
  } catch {
    report = {
      ok: false,
      crashed: true,
      message: res.timedOut ? 'Godot timed out' : `Godot exited with code ${res.code} before writing a report (is the AgentBridge autoload installed?)`,
      errors: scrapeErrors(res.output),
    };
  } finally {
    fs.rm(tmp, { force: true }).catch(() => {});
  }
  report.ms = res.ms;
  report.raw_errors = scrapeErrors(res.output);
  return report;
}

export function validateProject(projectPath, onLine) {
  return runReportMode(projectPath, '--agent-validate', [], onLine);
}

export function testProject(projectPath, filter, onLine) {
  return runReportMode(projectPath, '--agent-run-tests', filter ? [`--agent-filter=${filter}`] : [], onLine);
}

export async function exportPack(projectPath, outFile, onLine) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const res = await runGodot(['--path', projectPath, '--export-pack', config.exportPreset, outFile], { onLine });
  const ok = res.code === 0 && (await fs.stat(outFile).then((s) => s.size > 0, () => false));
  return { ok, ms: res.ms, errors: scrapeErrors(res.output), output: ok ? '' : res.output.slice(-4000) };
}

export async function exportFull(projectPath, outDir, { release = false } = {}, onLine) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const res = await runGodot(['--path', projectPath, release ? '--export-release' : '--export-debug',
    config.exportPreset, path.join(outDir, 'index.html')], { onLine });
  const ok = res.code === 0 && (await fs.stat(path.join(outDir, 'index.html')).then(() => true, () => false));
  return { ok, ms: res.ms, errors: scrapeErrors(res.output), output: ok ? '' : res.output.slice(-4000) };
}
