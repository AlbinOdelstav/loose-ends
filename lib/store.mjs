import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dataDir, itemPath } from './config.mjs';
import { normalizeText } from './frontmatter.mjs';
import { parseItem, serializeItem } from './item.mjs';
import { validateKey } from './keys.mjs';

export class ConflictError extends Error {
  constructor(current) {
    super('Item changed on disk');
    this.name = 'ConflictError';
    this.current = current; // { item, rev } | null
  }
}

export function revOf(bufOrText) {
  return createHash('sha1').update(bufOrText).digest('hex').slice(0, 16);
}

export const MAX_ITEM_BYTES = 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor() {
    super('file too large');
    this.name = 'FileTooLargeError';
    this.code = 'EFILETOOLARGE';
  }
}

export function readItem(key, dir = dataDir()) {
  const p = itemPath(key, dir);
  let buf;
  try {
    const st = statSync(p);
    if (st.isFile() && st.size > MAX_ITEM_BYTES) throw new FileTooLargeError();
    buf = readFileSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (buf.length > MAX_ITEM_BYTES) throw new FileTooLargeError();
  const text = normalizeText(buf.toString('utf8'));
  return { item: parseItem(text, key), rev: revOf(buf), text };
}

export function listItems(dir = dataDir()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.md')) continue;
    const key = name.slice(0, -3);
    if (!validateKey(key)) continue;
    try {
      const r = readItem(key, dir);
      if (r) out.push({ key, item: r.item, rev: r.rev });
    } catch (err) {
      let rev = null;
      if (!(err instanceof FileTooLargeError)) {
        try { rev = revOf(readFileSync(join(dir, name))); } catch { /* ignore */ }
      }
      out.push({ key, rev, parseError: String(err && err.message ? err.message : err) });
    }
  }
  return out;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKOFF = [25, 50, 100, 200, 400];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function writeFileAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, text, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code) || attempt === BACKOFF.length) break;
      await delay(BACKOFF[attempt]);
    }
  }
  try { await unlink(tmp); } catch { /* ignore */ }
  throw lastErr;
}

const locks = new Map();

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

// mutator(item|null) returns the item to write (or null/undefined for "no change").
export function updateItem(key, expectedRev, mutator, dir = dataDir()) {
  const p = itemPath(key, dir); // validates the key
  const id = `${resolve(dir).toLowerCase()}|${key.toLowerCase()}`;
  return withLock(id, async () => {
    const cur = readItem(key, dir);
    if (expectedRev !== null && expectedRev !== undefined && (cur ? cur.rev : null) !== expectedRev) {
      throw new ConflictError(cur ? { item: cur.item, rev: cur.rev } : null);
    }
    const next = await mutator(cur ? cur.item : null);
    if (!next) return { item: cur ? cur.item : null, rev: cur ? cur.rev : null, changed: false };
    const text = serializeItem(next);
    if (cur && text === cur.text) return { item: cur.item, rev: cur.rev, changed: false };
    await mkdir(dirname(p), { recursive: true });
    await writeFileAtomic(p, text);
    return { item: parseItem(text, key), rev: revOf(Buffer.from(text, 'utf8')), changed: true };
  });
}
