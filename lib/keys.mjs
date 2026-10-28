import { basename } from 'node:path';

export const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
// Claude Code session ids (UUIDs); also safe to put on a command line.
export const SESSION_ID_RE = /^[A-Za-z0-9-]{1,100}$/;

const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export const DENY = ['UTF', 'SHA', 'MD', 'ISO', 'RFC', 'CVE', 'X86', 'ARM', 'WIN', 'HTTP', 'TLS', 'SSL', 'IPV', 'UCS', 'ES', 'PR'];

export function validateKey(k) {
  if (typeof k !== 'string') return false;
  if (!KEY_RE.test(k)) return false;
  if (k === '.' || k === '..') return false;
  if (k.endsWith('.')) return false;
  if (RESERVED_RE.test(k)) return false;
  return true;
}

export function looksLikeIssueKey(k) {
  if (typeof k !== 'string' || !ISSUE_KEY_RE.test(k)) return false;
  const prefix = k.slice(0, k.lastIndexOf('-'));
  return !DENY.includes(prefix) && validateKey(k);
}

export function extractKey(text, { keyPrefixes = [] } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const allow = (keyPrefixes || []).map((p) => String(p).toUpperCase());
  const re = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-(\d+)(?![A-Za-z0-9])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1].toUpperCase();
    // Allow overlapping scans: the separator char consumed at the start may belong to the next match.
    re.lastIndex = m.index + 1;
    if (DENY.includes(prefix)) continue;
    if (allow.length && !allow.includes(prefix)) continue;
    const key = `${prefix}-${m[2]}`;
    if (validateKey(key)) return key;
  }
  return null;
}

export function detectKey({ branch, cwd, worktreeRoot } = {}, cfg = {}) {
  const opts = { keyPrefixes: (cfg && cfg.keyPrefixes) || [] };
  const candidates = [branch, cwd ? basename(cwd) : null, worktreeRoot ? basename(worktreeRoot) : null];
  for (const c of candidates) {
    if (!c) continue;
    const k = extractKey(c, opts);
    if (k) return k;
  }
  return null;
}
