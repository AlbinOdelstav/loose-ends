import { execFile } from 'node:child_process';
import { isExistingAbsDir } from './paths.mjs';

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,250}$/;
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE']);

// A PR reference passed to `gh pr view` must be one of:
//   - a PR number ("42" or "#42")
//   - a branch name (no leading "-", so it can't be read as an option)
//   - an https URL on github.com or on a host listed in config `ghHosts`
// Returns the normalized reference or null.
export function normalizePrRef(ref, { ghHosts = [] } = {}) {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0 ? String(ref) : null;
  if (typeof ref !== 'string') return null;
  const r = ref.trim();
  if (!r || r.length > 500 || r.startsWith('-')) return null;
  const num = /^#?(\d{1,9})$/.exec(r);
  if (num) return num[1];
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) {
    let u;
    try { u = new URL(r); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const hosts = new Set(['github.com', ...ghHosts.map((h) => String(h).toLowerCase())]);
    if (!hosts.has(u.hostname.toLowerCase())) return null;
    if (/\s/.test(r)) return null;
    return u.href;
  }
  if (BRANCH_RE.test(r) && !r.includes('..')) return r;
  return null;
}

export function isSafeRef(ref, opts) {
  return normalizePrRef(ref, opts) !== null;
}

export function summarizeChecks(rollup) {
  const checks = { pass: 0, fail: 0, pending: 0, total: 0 };
  if (!Array.isArray(rollup)) return checks;
  for (const c of rollup) {
    if (!c || typeof c !== 'object') continue;
    const v = String(c.conclusion || c.state || '').toUpperCase();
    checks.total++;
    if (PASS.has(v)) checks.pass++;
    else if (FAIL.has(v)) checks.fail++;
    else checks.pending++;
  }
  return checks;
}

// ghPath: absolute path of gh resolved at startup (see which.mjs). Never spawned by bare name.
export function livePr(cwd, ref, { ghPath, ghHosts = [], execFileImpl = execFile, platform = process.platform } = {}) {
  const fail = (error) => ({ ok: false, number: null, url: null, state: null, isDraft: false, reviewDecision: null, checks: summarizeChecks([]), error });
  const r = normalizePrRef(ref, { ghHosts });
  if (!r) return Promise.resolve(fail('no usable PR reference'));
  if (!isExistingAbsDir(cwd, platform)) return Promise.resolve(fail('working directory missing'));
  if (!ghPath) return Promise.resolve(fail('gh not found on PATH'));
  return new Promise((resolveP) => {
    try {
      execFileImpl(ghPath, ['pr', 'view', r, '--json', 'number,url,state,isDraft,reviewDecision,statusCheckRollup'],
        { cwd, timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolveP(fail(err.code === 'ENOENT' ? 'gh not found' : err.killed ? 'gh timed out' : 'no pull request found'));
            return;
          }
          try {
            const j = JSON.parse(stdout);
            resolveP({
              ok: true,
              number: Number.isInteger(j.number) ? j.number : null,
              url: typeof j.url === 'string' ? j.url : null,
              state: typeof j.state === 'string' ? j.state : null,
              isDraft: !!j.isDraft,
              reviewDecision: typeof j.reviewDecision === 'string' && j.reviewDecision ? j.reviewDecision : null,
              checks: summarizeChecks(j.statusCheckRollup),
            });
          } catch {
            resolveP(fail('unexpected gh output'));
          }
        });
    } catch (err) {
      resolveP(fail(String(err.message || err)));
    }
  });
}
