import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isExistingAbsDir, isSafeLocalPath } from './paths.mjs';

export { isExistingAbsDir };

// File-based git inspection (no spawning) so the SessionEnd hook stays fast.
// Only local paths are touched (no UNC/device paths, see paths.mjs).
export function readGitInfo(cwd, { platform = process.platform } = {}) {
  const none = { branch: null, worktreeRoot: null, repo: null };
  if (!isSafeLocalPath(cwd, platform)) return none;
  let d = resolve(cwd);
  let gitDir = null;
  let worktreeRoot = null;
  let repo = null;
  for (let guard = 0; guard < 200; guard++) {
    const g = join(d, '.git');
    let st = null;
    try { st = statSync(g); } catch { st = null; }
    if (st && st.isDirectory()) {
      gitDir = g;
      worktreeRoot = d;
      repo = d;
      break;
    }
    if (st && st.isFile()) {
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(g, 'utf8'));
        if (!m) return none;
        gitDir = resolve(d, m[1]);
        if (!isSafeLocalPath(gitDir, platform)) return none;
        worktreeRoot = d;
        try {
          const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
          repo = isSafeLocalPath(common, platform) ? dirname(common) : d;
        } catch {
          repo = d;
        }
      } catch {
        return none;
      }
      break;
    }
    const parent = dirname(d);
    if (parent === d) return none;
    d = parent;
  }
  if (!gitDir) return none;
  let branch = null;
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
    branch = m ? m[1] : null;
  } catch {
    branch = null;
  }
  return { branch, worktreeRoot, repo };
}

export function parseGitStatus(stdout) {
  const res = { ok: true, branch: null, ahead: 0, behind: 0, dirty: 0, upstream: null };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, name, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (name === 'branch.head') res.branch = val === '(detached)' ? null : val;
      else if (name === 'branch.upstream') res.upstream = val;
      else if (name === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]); }
      }
    } else {
      res.dirty++;
    }
  }
  return res;
}

// No optional locks (never blocks a concurrent git command) and no fsmonitor hook
// (a repo's config cannot make status run an arbitrary program).
export function gitStatusArgs(cwd) {
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'status', '--porcelain=v2', '--branch'];
}

// gitPath: absolute path of git resolved at startup (see which.mjs). Never spawned by bare name.
export function liveGit(cwd, { gitPath, execFileImpl = execFile, platform = process.platform } = {}) {
  const fail = (error) => ({ ok: false, branch: null, ahead: 0, behind: 0, dirty: 0, upstream: null, error });
  if (!isExistingAbsDir(cwd, platform)) return Promise.resolve(fail('working directory missing'));
  if (!gitPath) return Promise.resolve(fail('git not found on PATH'));
  return new Promise((resolveP) => {
    try {
      execFileImpl(gitPath, gitStatusArgs(cwd), { cwd, timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          const msg = err.code === 'ENOENT' ? 'git not found' : err.killed ? 'git timed out' : 'not a git repository';
          resolveP(fail(msg));
          return;
        }
        resolveP(parseGitStatus(stdout));
      });
    } catch (err) {
      resolveP(fail(String(err.message || err)));
    }
  });
}
