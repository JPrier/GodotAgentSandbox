// Runtime configuration, all overridable through environment variables.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(here, '..');

const home = process.env.GCK_HOME || path.join(os.homedir(), '.gck');

export const config = {
  port: Number(process.env.GCK_PORT || process.env.PORT || 8790),
  host: process.env.GCK_HOST || '0.0.0.0',
  token: process.env.GCK_TOKEN || '',               // optional shared secret for API + WS
  home,
  projectsDir: process.env.GCK_PROJECTS_DIR || path.join(home, 'projects'),
  stateDir: path.join(home, 'state'),
  engineDir: path.join(home, 'engine'),
  editorDir: path.join(home, 'editor'),
  registryFile: path.join(home, 'registry.json'),
  godotBin: process.env.GODOT_BIN || 'godot',
  templatesDir: process.env.GODOT_TEMPLATES_DIR ||
    path.join(os.homedir(), '.local', 'share', 'godot', 'export_templates'),
  // Which web template variant the browser runs. nothreads needs no cross-origin isolation
  // and works in every browser; switch to "web_debug" only if a game needs threads.
  webTemplate: process.env.GCK_WEB_TEMPLATE || 'web_nothreads_debug',
  exportPreset: process.env.GCK_EXPORT_PRESET || 'Web',
  keepBuilds: Number(process.env.GCK_KEEP_BUILDS || 10),
  buildDebounceMs: Number(process.env.GCK_DEBOUNCE_MS || 700),
  commandTimeoutMs: Number(process.env.GCK_COMMAND_TIMEOUT_MS || 30000),
  godotTimeoutMs: Number(process.env.GCK_GODOT_TIMEOUT_MS || 180000),
  templateDir: path.join(KIT_ROOT, 'template'),
  addonDir: path.join(KIT_ROOT, 'addon', 'agent_bridge'),
  webDir: path.join(KIT_ROOT, 'web'),
};
