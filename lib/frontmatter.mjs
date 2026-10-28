// Lossless parser/serializer for the small YAML subset described in FORMAT.md.
// Every top-level entry keeps its raw text. Unchanged entries are written back
// byte-for-byte; entries outside the subset (ok: false) are always written back raw.

export const CANONICAL_ORDER = [
  'key', 'title', 'status', 'waitingOn', 'jiraStatus', 'repo', 'cwd', 'branch', 'pr',
  'updated', 'lastCheckpoint', 'sessions', 'sessionsSinceCheckpoint',
];

const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/;
const MAP_PAIR_RE = /^([A-Za-z_][A-Za-z0-9_]*):(?: (.*))?$/;
const LIST_ITEM_RE = /^( *)-(?: (.*))?$/;
const NUMBER_RE = /^-?\d{1,15}$/;
const PLAIN_RE = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^\x00-\x1f\x7f]*$/;

export function normalizeText(text) {
  let t = String(text ?? '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, '\n');
}

export function parseScalar(s) {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  if (t[0] === '"') {
    const v = JSON.parse(t); // throws on malformed input
    if (typeof v !== 'string') throw new Error('Bad double-quoted scalar');
    return v;
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new Error('Bad single-quoted scalar');
    const inner = t.slice(1, -1);
    if (/'(?!')/.test(inner.replace(/''/g, ''))) throw new Error('Bad single-quoted scalar');
    return inner.replace(/''/g, "'");
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (NUMBER_RE.test(t)) return Number(t);
  return t;
}

function isBlockOrFlow(t) {
  return t[0] === '|' || t[0] === '>' || t[0] === '[' || t[0] === '{';
}

function parseInlineValue(rest) {
  // rest is everything after "KEY:"
  if (rest === '' || /^\s+$/.test(rest)) return { value: null, empty: true };
  if (rest[0] !== ' ' && rest[0] !== '\t') throw new Error('Missing space after colon');
  const t = rest.trim();
  if (t === '[]') return { value: [] };
  if (isBlockOrFlow(t)) throw new Error('Unsupported YAML construct');
  return { value: parseScalar(t) };
}

// Keys that must never become object properties (prototype pollution).
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Values nested in a list are parsed leniently: anything that isn't valid quoted syntax
// (or looks like flow/block syntax) is kept as a plain string, so one sloppy value
// (e.g. an unquoted "[WIP] refactor 'auth'") doesn't invalidate the whole entry.
function parseNestedValue(s) {
  const t = (s ?? '').trim();
  if (t === '[]') return [];
  if (t && isBlockOrFlow(t)) return t;
  try {
    return parseScalar(t);
  } catch {
    return t;
  }
}

function setPair(obj, k, v) {
  if (!FORBIDDEN_KEYS.has(k)) obj[k] = v;
}

function parseList(lines) {
  const items = [];
  let ind = null;
  let current = null; // current map item
  for (const line of lines) {
    const li = LIST_ITEM_RE.exec(line);
    if (li && (ind === null || li[1].length === ind)) {
      if (ind === null) ind = li[1].length;
      const content = li[2] ?? '';
      const mp = MAP_PAIR_RE.exec(content);
      if (mp) {
        current = {};
        setPair(current, mp[1], parseNestedValue(mp[2]));
        items.push(current);
      } else {
        items.push(parseNestedValue(content));
        current = null;
      }
      continue;
    }
    const indent = /^ */.exec(line)[0].length;
    if (current && ind !== null && indent > ind) {
      const mp = MAP_PAIR_RE.exec(line.slice(indent));
      if (!mp) throw new Error('Unsupported list continuation');
      setPair(current, mp[1], parseNestedValue(mp[2]));
      continue;
    }
    throw new Error('Unsupported list line');
  }
  return items;
}

function isContinuation(line) {
  return /^[ \t]/.test(line) || /^-( |$)/.test(line);
}

export function parseFrontmatter(input) {
  const text = normalizeText(input);
  const fields = new Map();
  const order = [];
  if (!(text.startsWith('---\n') || text === '---')) {
    return { fields, order, body: text, hasFrontmatter: false };
  }
  const lines = text.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return { fields, order, body: text, hasFrontmatter: false };

  const fm = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  let pseudo = 0;
  const addPseudo = (raw) => {
    const id = `#${pseudo++}`;
    fields.set(id, { value: undefined, raw, ok: true, pseudo: true });
    order.push(id);
  };

  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    const km = KEY_LINE_RE.exec(line);
    if (!km) {
      addPseudo(line); // blank line, comment, or stray text: preserved verbatim
      i++;
      continue;
    }
    const key = km[1];
    const rawLines = [line];
    let j = i + 1;
    while (j < fm.length && fm[j] !== '' && isContinuation(fm[j])) {
      rawLines.push(fm[j]);
      j++;
    }
    const cont = rawLines.slice(1);
    let entry;
    try {
      const inline = parseInlineValue(km[2]);
      let value = inline.value;
      if (cont.length) {
        if (!inline.empty) throw new Error('Unexpected continuation lines');
        value = parseList(cont);
      }
      entry = { value, raw: rawLines.join('\n'), ok: true };
    } catch {
      entry = { value: undefined, raw: rawLines.join('\n'), ok: false };
    }
    if (fields.has(key)) {
      // Duplicate key: last one wins; keep the earlier text verbatim as a pseudo entry.
      const prev = fields.get(key);
      const idx = order.indexOf(key);
      const id = `#${pseudo++}`;
      fields.set(id, { value: undefined, raw: prev.raw, ok: true, pseudo: true });
      order[idx] = id;
      fields.delete(key);
    }
    fields.set(key, entry);
    order.push(key);
    i = j;
  }
  return { fields, order, body, hasFrontmatter: true };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function canBePlain(s) {
  if (!PLAIN_RE.test(s)) return false;
  if (s.includes(': ') || s.includes(' #') || /\s$/.test(s) || s.endsWith(':')) return false;
  let reparsed;
  try { reparsed = parseScalar(s); } catch { return false; }
  return reparsed === s;
}

export function serializeScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'string') return v !== '' && canBePlain(v) ? v : JSON.stringify(v);
  return JSON.stringify(JSON.stringify(v));
}

function pair(k, s) {
  return s === '' ? `${k}:` : `${k}: ${s}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function serializeNested(v) {
  if (Array.isArray(v) && v.length === 0) return '[]';
  if (v !== null && typeof v === 'object') return serializeScalar(JSON.stringify(v));
  return serializeScalar(v);
}

export function serializeEntry(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const out = [`${key}:`];
    for (const el of value) {
      if (isPlainObject(el)) {
        const keys = Object.keys(el).filter((k) => el[k] !== undefined && !FORBIDDEN_KEYS.has(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (!keys.length) { out.push('  -'); continue; }
        keys.forEach((k, n) => {
          out.push(`${n === 0 ? '  - ' : '    '}${pair(k, serializeNested(el[k]))}`);
        });
      } else {
        const s = serializeNested(el);
        out.push(s === '' ? '  -' : `  - ${s}`);
      }
    }
    return out.join('\n');
  }
  if (isPlainObject(value)) return pair(key, serializeScalar(JSON.stringify(value)));
  return pair(key, serializeScalar(value));
}

// updates: the desired value per key. Keys absent from `updates` are written back raw.
// A key whose update is `undefined` is removed.
export function serializeFrontmatter(fields, order, updates = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(updates, k);
  const out = [];
  for (const k of order) {
    const e = fields.get(k);
    if (!e) continue;
    if (e.pseudo || !e.ok || !has(k)) { out.push(e.raw); continue; }
    const v = updates[k];
    if (v === undefined) continue;
    out.push(deepEqual(v, e.value) ? e.raw : serializeEntry(k, v));
  }
  const newKeys = Object.keys(updates).filter((k) => !fields.has(k) && !FORBIDDEN_KEYS.has(k) && updates[k] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  newKeys.sort((a, b) => {
    const ia = CANONICAL_ORDER.indexOf(a);
    const ib = CANONICAL_ORDER.indexOf(b);
    return (ia === -1 ? 1e6 : ia) - (ib === -1 ? 1e6 : ib);
  });
  for (const k of newKeys) out.push(serializeEntry(k, updates[k]));
  if (!out.length) return '---\n---\n';
  return `---\n${out.join('\n')}\n---\n`;
}
