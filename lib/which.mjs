import { lstatSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

// Resolves an executable name to an absolute path by scanning PATH (and PATHEXT on Windows).
// Relative and empty PATH entries and the current directory are skipped, so a binary planted
// in a repo or the server's working directory is never picked up. Returns null if not found.
export function resolveExecutable(name, { env = process.env, platform = process.platform, cwd = process.cwd(), extensions } = {}) {
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) return null;
  const win = platform === 'win32';
  const pathVar = (win ? env.Path ?? env.PATH ?? env.path : env.PATH) ?? '';
  const sep = win ? ';' : ':';
  const norm = (p) => (win ? resolve(p).toLowerCase() : resolve(p));
  const here = norm(cwd);
  let exts = [''];
  if (win) {
    const pathext = (extensions ?? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'))
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^\.[a-z0-9]+$/.test(e));
    const own = extname(name);
    exts = own && pathext.some((e) => e.toLowerCase() === own.toLowerCase()) ? [''] : pathext;
  }
  const seen = new Set();
  for (let dir of pathVar.split(sep)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !isAbsolute(dir)) continue;
    if (win && /^[\\/]{2}/.test(dir)) continue; // no UNC entries
    const key = norm(dir);
    if (key === here || seen.has(key)) continue;
    seen.add(key);
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    // Windows app execution aliases (e.g. wt.exe in WindowsApps) can't be stat'ed but exist.
    try {
      const l = lstatSync(p);
      return !l.isDirectory();
    } catch {
      return false;
    }
  }
}

export function systemCmdPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return join(root, 'System32', 'cmd.exe');
}

// Resolves every external tool once (at server start).
export function resolveTools({ env = process.env, platform = process.platform, cwd = process.cwd() } = {}) {
  const opts = { env, platform, cwd };
  const exeOnly = platform === 'win32' ? { extensions: ['.exe', '.com'] } : {};
  return {
    git: resolveExecutable('git', { ...opts, ...exeOnly }),
    gh: resolveExecutable('gh', { ...opts, ...exeOnly }),
    claude: resolveExecutable('claude', opts),
    wt: platform === 'win32' ? resolveExecutable('wt', { ...opts, extensions: ['.exe'] }) : null,
    cmd: platform === 'win32' ? systemCmdPath(env) : null,
  };
}
