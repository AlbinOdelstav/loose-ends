import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExistingAbsDir } from './paths.mjs';
import { systemCmdPath } from './which.mjs';

export const LAUNCHER_PATH = fileURLToPath(new URL('../bin/launch-claude.mjs', import.meta.url));
export const PROMPTS_DIRNAME = '.prompts';

const CMD_UNSAFE_RE = /["%^&|<>!\r\n]/;

export function writePromptFile(dir, key, text) {
  const pdir = join(dir, PROMPTS_DIRNAME);
  mkdirSync(pdir, { recursive: true });
  const name = `${key}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`;
  const target = join(pdir, name);
  const tmp = join(pdir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, target);
  return target;
}

const escWt = (s) => String(s).replace(/;/g, '\\;');

// The launcher gets the prompt file and the absolute path of claude (resolved at startup).
export function buildWtArgs({ cwd, key, nodeExe, launcher, promptFile, claudePath }) {
  const args = ['-w', 'new', 'new-tab', '--title', `Loose Ends ${key}`, '-d', resolve(cwd), nodeExe, launcher, promptFile];
  if (claudePath) args.push(claudePath);
  return args.map(escWt);
}

export function buildCmdStartLine({ cwd, key, nodeExe, launcher, promptFile, claudePath }) {
  const parts = { cwd: resolve(cwd), key, nodeExe, launcher, promptFile };
  if (claudePath) parts.claudePath = claudePath;
  for (const [name, v] of Object.entries(parts)) {
    if (typeof v !== 'string' || !v || CMD_UNSAFE_RE.test(v)) {
      throw new Error(`Cannot launch via cmd: ${name} contains characters that are unsafe for cmd.exe`);
    }
  }
  return `start "Loose Ends ${key}" /D "${parts.cwd}" "${nodeExe}" "${launcher}" "${promptFile}"${claudePath ? ` "${claudePath}"` : ''}`;
}

function trySpawn(spawnImpl, cmd, args, opts) {
  return new Promise((resolveP, reject) => {
    let child;
    try {
      child = spawnImpl(cmd, args, opts);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch { /* ignore */ }
      resolveP(child);
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export async function launchSession({
  cwd, key, prompt, cfg = {}, dir, spawnImpl = spawn,
  nodeExe = process.execPath, launcher = LAUNCHER_PATH,
  tools = {},
}) {
  // All executables are absolute paths resolved at startup (never bare names, which
  // Windows would also look up in the current directory).
  if (!isExistingAbsDir(cwd)) throw new Error('Working directory is not an existing local directory');
  if (!tools.claude) throw new Error('claude CLI not found on PATH');
  const cmdPath = tools.cmd || systemCmdPath();
  const promptFile = writePromptFile(dir, key, prompt);
  const base = { cwd, key, nodeExe, launcher, promptFile, claudePath: tools.claude };
  let wtError = null;
  if (cfg.terminal !== 'cmd' && tools.wt) {
    try {
      await trySpawn(spawnImpl, tools.wt, buildWtArgs(base), { detached: true, stdio: 'ignore', windowsHide: false });
      return { via: 'wt', promptFile };
    } catch (err) {
      wtError = err;
    }
  }
  try {
    const line = buildCmdStartLine(base);
    await trySpawn(spawnImpl, cmdPath, ['/d', '/s', '/c', line], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
    return { via: 'cmd', promptFile };
  } catch (err) {
    try { unlinkSync(promptFile); } catch { /* ignore */ }
    const msg = wtError ? `wt failed (${wtError.code || wtError.message}); cmd failed: ${err.message}` : err.message;
    throw new Error(msg);
  }
}

export function cleanupOldPrompts(dir, maxAgeMs = 86400000, now = Date.now()) {
  const pdir = join(dir, PROMPTS_DIRNAME);
  let removed = 0;
  let names;
  try { names = readdirSync(pdir); } catch { return 0; }
  for (const name of names) {
    const p = join(pdir, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}
