import { FORBIDDEN_KEYS, parseFrontmatter, serializeFrontmatter, normalizeText } from './frontmatter.mjs';
import { looksLikeIssueKey, SESSION_ID_RE } from './keys.mjs';

export const CANONICAL_SECTIONS = ['Summary', 'Next steps', 'Blockers', 'Notes', 'Log'];
export const STATUSES = ['active', 'waiting', 'parked', 'done'];
export const KNOWN_FIELDS = [
  'key', 'title', 'status', 'waitingOn', 'jiraStatus', 'repo', 'cwd', 'branch', 'pr',
  'updated', 'lastCheckpoint', 'sessions', 'sessionsSinceCheckpoint',
];
export const MAX_SESSIONS = 20;
export const MAX_SESSIONS_TOTAL = 50;

const STEP_RE = /^( {0,3})[-*] \[([ xX])\] (.*)$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;
const HEADING_RE = /^## (.+)$/;

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

// Split a markdown body into a preamble (heading: null) and "## " sections.
// content is the exact text after the heading line (including its trailing newlines),
// so concatenating everything reproduces the body.
export function splitSections(body) {
  const sections = [];
  let inFence = false;
  let pos = 0;
  let current = { heading: null, content: '', start: 0 };
  const starts = [];
  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos);
    const lineEnd = nl === -1 ? body.length : nl;
    const line = body.slice(pos, lineEnd);
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING_RE.exec(line);
      if (m) starts.push({ heading: m[1], lineStart: pos, contentStart: nl === -1 ? body.length : nl + 1 });
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (!starts.length || starts[0].lineStart > 0) {
    current.content = body.slice(0, starts.length ? starts[0].lineStart : body.length);
    sections.push({ heading: null, content: current.content });
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].lineStart : body.length;
    sections.push({ heading: s.heading, content: body.slice(s.contentStart, end) });
  });
  return sections;
}

export function joinSections(sections) {
  return sections.map((s) => (s.heading === null ? s.content : `## ${s.heading}\n${s.content}`)).join('');
}

export function parseItem(text, keyFromFilename) {
  const fm = parseFrontmatter(normalizeText(text));
  const data = {};
  const parseWarnings = [];
  for (const [k, e] of fm.fields) {
    if (e.pseudo || FORBIDDEN_KEYS.has(k)) continue;
    if (e.ok) data[k] = clone(e.value);
    else if (KNOWN_FIELDS.includes(k)) parseWarnings.push(`Field "${k}" is not in the supported format and was ignored`);
  }
  return {
    key: keyFromFilename ?? (typeof data.key === 'string' ? data.key : null),
    fields: fm.fields,
    order: fm.order,
    hasFrontmatter: fm.hasFrontmatter,
    data,
    sections: splitSections(fm.body),
    parseWarnings,
  };
}

export function serializeItem(item) {
  const body = joinSections(item.sections);
  const hasData = Object.keys(item.data).some((k) => item.data[k] !== undefined);
  if (!item.hasFrontmatter && !hasData) return body;
  return serializeFrontmatter(item.fields, item.order, item.data) + body;
}

function findSectionIndex(item, name) {
  const n = name.trim().toLowerCase();
  return item.sections.findIndex((s) => s.heading !== null && s.heading.trim().toLowerCase() === n);
}

export function getSection(item, name) {
  const i = findSectionIndex(item, name);
  if (i === -1) return '';
  return item.sections[i].content.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

function ensureEndsWithBlankLine(s) {
  if (s === '') return s;
  if (s.endsWith('\n\n')) return s;
  if (s.endsWith('\n')) return s + '\n';
  return s + '\n\n';
}

export function setSection(item, name, content) {
  const text = String(content ?? '').replace(/\s+$/, '');
  let i = findSectionIndex(item, name);
  if (i === -1) {
    const canonicalName = CANONICAL_SECTIONS.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
    const ci = CANONICAL_SECTIONS.indexOf(canonicalName);
    let insertAt = item.sections.length;
    if (ci !== -1) {
      const later = item.sections.findIndex((s) => {
        if (s.heading === null) return false;
        const k = CANONICAL_SECTIONS.findIndex((c) => c.toLowerCase() === s.heading.trim().toLowerCase());
        return k > ci;
      });
      if (later !== -1) {
        insertAt = later;
      } else {
        let lastEarlier = -1;
        item.sections.forEach((s, idx) => {
          if (s.heading === null) return;
          const k = CANONICAL_SECTIONS.findIndex((c) => c.toLowerCase() === s.heading.trim().toLowerCase());
          if (k !== -1 && k < ci) lastEarlier = idx;
        });
        if (lastEarlier !== -1) insertAt = lastEarlier + 1;
      }
    }
    if (insertAt > 0) {
      const prev = item.sections[insertAt - 1];
      prev.content = ensureEndsWithBlankLine(prev.content);
    }
    item.sections.splice(insertAt, 0, { heading: canonicalName, content: '' });
    i = insertAt;
  }
  const isLast = i === item.sections.length - 1;
  item.sections[i].content = (text ? text + '\n' : '') + (isLast && text ? '' : '\n');
  return item;
}

export function getSteps(item) {
  const i = findSectionIndex(item, 'Next steps');
  if (i === -1) return [];
  const lines = item.sections[i].content.split('\n');
  const steps = [];
  let inFence = false;
  lines.forEach((l, lineNo) => {
    if (FENCE_RE.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = STEP_RE.exec(l);
    if (m) steps.push({ index: steps.length, text: m[3].trim(), done: m[2] !== ' ', line: lineNo });
  });
  return steps;
}

export function setStepDone(item, index, done) {
  const steps = getSteps(item);
  const step = steps.find((s) => s.index === index);
  if (!step) throw new RangeError(`No step with index ${index}`);
  const i = findSectionIndex(item, 'Next steps');
  const lines = item.sections[i].content.split('\n');
  const line = lines[step.line];
  const m = STEP_RE.exec(line);
  const pos = m[1].length + 3; // "- [" after the indent
  lines[step.line] = line.slice(0, pos) + (done ? 'x' : ' ') + line.slice(pos + 1);
  item.sections[i].content = lines.join('\n');
  return item;
}

export function appendLog(item, line, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const entry = `- ${date}: ${String(line).replace(/\s*\n\s*/g, ' ').trim()}`;
  const existing = getSection(item, 'Log');
  setSection(item, 'Log', existing ? `${existing}\n${entry}` : entry);
  return item;
}

function str(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

// Thread state of a session record:
//   open: true  -> an open thread (unfinished work, set by /checkpoint or the board)
//   open: false -> a finished thread
//   missing     -> untracked (recorded by the hook, never classified)
export function isSessionOpen(s) {
  return !!s && s.open === true;
}

export function sessionOpenState(s) {
  if (!s) return null;
  if (s.open === true) return true;
  if (s.open === false) return false;
  return null;
}

export function normalizeSessions(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s) => s && typeof s === 'object' && !Array.isArray(s))
    .map((s) => ({
      id: str(s.id),
      parentId: str(s.parentId),
      cwd: str(s.cwd),
      branch: str(s.branch),
      endedAt: str(s.endedAt),
      note: str(s.note),
      open: sessionOpenState(s),
    }));
}

// Keeps the last `maxOther` untracked/closed sessions and every open thread,
// with a hard ceiling of `maxTotal` records (oldest dropped first).
export function capSessions(sessions, { maxOther = MAX_SESSIONS, maxTotal = MAX_SESSIONS_TOTAL } = {}) {
  let list = [...sessions];
  let excess = list.filter((s) => !isSessionOpen(s)).length - maxOther;
  if (excess > 0) {
    list = list.filter((s) => {
      if (excess > 0 && !isSessionOpen(s)) { excess--; return false; }
      return true;
    });
  }
  if (list.length > maxTotal) list = list.slice(list.length - maxTotal);
  return list;
}

// Builds a forest from normalized sessions: a session whose parentId is not in the list is a root.
export function buildSessionTree(sessions) {
  const nodes = [];
  const byId = new Map();
  for (const s of sessions) {
    const node = { id: s.id, cwd: s.cwd, branch: s.branch, endedAt: s.endedAt, note: s.note, open: s.open, children: [] };
    nodes.push({ node, parentId: s.parentId });
    if (s.id && !byId.has(s.id)) byId.set(s.id, node);
  }
  const roots = [];
  const attached = new Set();
  for (const { node, parentId } of nodes) {
    const parent = parentId && parentId !== node.id ? byId.get(parentId) : null;
    if (parent && byId.get(node.id) === node) parent.children.push(node);
    else if (parent && !node.id) parent.children.push(node);
    else roots.push(node);
  }
  // Nodes caught in a parent cycle are unreachable from any root: promote them to roots.
  const visit = (n) => {
    if (attached.has(n)) return;
    attached.add(n);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  for (const { node } of nodes) {
    if (attached.has(node)) continue;
    for (const { node: p } of nodes) p.children = p.children.filter((c) => c !== node);
    roots.push(node);
    visit(node);
  }
  return roots;
}

export function toApiItem(item, rev, cfg = {}) {
  const d = item.data;
  const key = item.key;
  const sessions = normalizeSessions(d.sessions);
  const last = sessions.length ? sessions[sessions.length - 1].id : null;
  const openSessions = sessions.filter((x) => x.open === true).length;
  const count = Number.isInteger(d.sessionsSinceCheckpoint) && d.sessionsSinceCheckpoint > 0 ? d.sessionsSinceCheckpoint : 0;
  const base = cfg && cfg.jiraBaseUrl;
  const api = {
    key,
    title: str(d.title) ?? '',
    status: str(d.status) ?? 'active',
    waitingOn: str(d.waitingOn),
    jiraStatus: str(d.jiraStatus),
    repo: str(d.repo),
    cwd: str(d.cwd),
    branch: str(d.branch),
    pr: str(d.pr),
    updated: str(d.updated),
    lastCheckpoint: str(d.lastCheckpoint),
    sessions,
    sessionTree: buildSessionTree(sessions),
    openSessions,
    sessionsSinceCheckpoint: count,
    summary: getSection(item, 'Summary'),
    blockers: getSection(item, 'Blockers'),
    notes: getSection(item, 'Notes'),
    log: getSection(item, 'Log'),
    steps: getSteps(item).map(({ index, text, done }) => ({ index, text, done })),
    rev,
    jiraUrl: base && looksLikeIssueKey(key) ? `${base}/browse/${encodeURIComponent(key)}` : null,
    // Id of the most recently recorded session (kept for API consumers/scripts; the board
    // itself uses sessionTree).
    lastSessionId: last && SESSION_ID_RE.test(last) ? last : null,
  };
  if (item.parseWarnings && item.parseWarnings.length) api.parseWarnings = [...item.parseWarnings];
  return api;
}

export function newStubItem({ key, title, cwd = null, repo = null, branch = null, now = new Date() }) {
  const item = parseItem('', key);
  item.data = {
    key,
    title: title ?? key,
    status: 'active',
    waitingOn: null,
    jiraStatus: null,
    repo: repo ?? null,
    cwd: cwd ?? null,
    branch: branch ?? null,
    pr: null,
    updated: now.toISOString(),
    lastCheckpoint: null,
    sessions: [],
    sessionsSinceCheckpoint: 0,
  };
  item.sections = CANONICAL_SECTIONS.map((h, i) => ({ heading: h, content: i === CANONICAL_SECTIONS.length - 1 ? '' : '\n' }));
  item.sections.unshift({ heading: null, content: '\n' });
  return item;
}
