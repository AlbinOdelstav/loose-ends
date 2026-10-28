import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateKey } from './keys.mjs';

export const DEFAULT_PORT = 4477;

export function dataDir() {
  const env = process.env.LOOSE_ENDS_DIR;
  if (env) return resolve(env);
  return join(homedir(), '.claude', 'loose-ends');
}

export function claudeDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return resolve(env);
  return join(homedir(), '.claude');
}

export function configPath(dir = dataDir()) {
  return join(dir, 'config.json');
}

function validPort(p) {
  const n = typeof p === 'string' && /^\d+$/.test(p.trim()) ? Number(p.trim()) : p;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export function loadConfig(dir = dataDir()) {
  let raw = {};
  try {
    let text = readFileSync(configPath(dir), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = {};
  }

  let jiraBaseUrl = null;
  if (typeof raw.jiraBaseUrl === 'string' && raw.jiraBaseUrl.trim()) {
    try {
      const u = new URL(raw.jiraBaseUrl.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        jiraBaseUrl = raw.jiraBaseUrl.trim().replace(/\/+$/, '');
      }
    } catch {
      jiraBaseUrl = null;
    }
  }

  const port = validPort(process.env.LOOSE_ENDS_PORT) ?? validPort(raw.port) ?? DEFAULT_PORT;
  const terminal = raw.terminal === 'cmd' ? 'cmd' : 'wt';
  const keyPrefixes = Array.isArray(raw.keyPrefixes)
    ? raw.keyPrefixes.filter((p) => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9]+$/.test(p)).map((p) => p.toUpperCase())
    : [];

  const ghHosts = Array.isArray(raw.ghHosts)
    ? raw.ghHosts.filter((h) => typeof h === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(h)).map((h) => h.toLowerCase())
    : [];

  return { jiraBaseUrl, port, terminal, keyPrefixes, ghHosts };
}

export function itemPath(key, dir = dataDir()) {
  if (!validateKey(key)) throw new Error(`Invalid key: ${key}`);
  const root = resolve(dir);
  const p = resolve(root, key + '.md');
  if (dirname(p) !== root) throw new Error(`Invalid key: ${key}`);
  return p;
}

// True when the module identified by `metaUrl` is the script node was started with.
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const real = (p) => {
    try { return realpathSync(p); } catch { return p; }
  };
  try {
    const argv1 = resolve(process.argv[1]);
    const self = fileURLToPath(metaUrl);
    if (norm(argv1) === norm(self)) return true;
    // Symlinks, junctions or 8.3 short names: compare the real paths too.
    return norm(real(argv1)) === norm(real(self));
  } catch {
    return false;
  }
}
