#!/usr/bin/env node
// Loose Ends board server. Plain Node 22, zero dependencies. Binds 127.0.0.1 only.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, isMainModule, loadConfig } from './lib/config.mjs';
import { livePr, normalizePrRef } from './lib/gh.mjs';
import { liveGit } from './lib/git.mjs';
import { appendLog, getSteps, setStepDone, STATUSES, toApiItem } from './lib/item.mjs';
import { SESSION_ID_RE, validateKey } from './lib/keys.mjs';
import { cleanupOldPrompts, launchSession } from './lib/launch.mjs';
import { isExistingAbsDir } from './lib/paths.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { checkHost, checkOrigin, checkToken, HttpError, parseSteps, readJsonBody } from './lib/security.mjs';
import { ConflictError, FileTooLargeError, listItems, readItem, updateItem } from './lib/store.mjs';
import { resolveTools } from './lib/which.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT']);
const LIVE_TTL_MS = 30000;
const WAITING_ON_MAX = 500;
const SESSION_NOTE_MAX = 300;
export const MAX_LIVE_PROCS = 4; // concurrent git/gh child processes
export const MAX_LIVE_QUEUE = 32; // waiting live requests before answering 503
export const MAX_SSE_CLIENTS = 20;
export const MAX_CONNECTIONS = 64;

// Simple counting semaphore with a bounded queue.
function createLimiter(max, maxQueue) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => {
    if (queue.length >= maxQueue) return Promise.reject(new HttpError(503, 'Too many live requests, try again shortly'));
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function decodeKey(seg) {
  let key;
  try {
    key = decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, 'Invalid key');
  }
  if (!validateKey(key)) throw new HttpError(400, 'Invalid key');
  return key;
}

function requireRev(body) {
  if (typeof body.rev !== 'string' || !/^[0-9a-f]{16}$/.test(body.rev)) throw new HttpError(400, 'Missing or invalid rev');
  return body.rev;
}

export function createServer({
  dir = dataDir(),
  port = 4477,
  cfg = loadConfig(dir),
  token = randomBytes(32).toString('base64url'),
  launch = launchSession,
  tools = resolveTools(), // absolute paths of git, gh, claude, wt, cmd (resolved once)
  live = {
    liveGit: (cwd) => liveGit(cwd, { gitPath: tools.git }),
    livePr: (cwd, ref) => livePr(cwd, ref, { ghPath: tools.gh, ghHosts: cfg.ghHosts || [] }),
  },
  platform = process.platform,
  maxLiveProcs = MAX_LIVE_PROCS,
  maxSseClients = MAX_SSE_CLIENTS,
} = {}) {
  const sseClients = new Set();
  const liveCache = new Map();
  const limitLive = createLimiter(maxLiveProcs, MAX_LIVE_QUEUE);
  let watcher = null;
  let debounce = null;
  let pingTimer = null;
  let rearmTimer = null;
  let rearmDelay = 1000;
  let stopped = false;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof FileTooLargeError) {
        sendJson(res, 422, { error: 'Item file too large (over 1 MB)' });
      } else if (err instanceof ConflictError) {
        sendJson(res, 409, { error: 'Item changed on disk', item: err.current ? toApiItem(err.current.item, err.current.rev, cfg) : null });
      } else {
        sendJson(res, 500, { error: 'Internal error' });
      }
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = MAX_CONNECTIONS;

  const boundPort = () => {
    const a = server.address();
    return a && typeof a === 'object' ? a.port : port;
  };

  function apiItemOrNull(key) {
    const r = readItem(key, dir);
    return r ? { api: toApiItem(r.item, r.rev, cfg), ...r } : null;
  }

  function broadcast(event = 'changed', data = {}) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(msg); } catch { /* ignore */ }
    }
  }

  // Watches the data dir. If the watcher fails (dir deleted, network drive, ...), clients get
  // a `warning` event and the watcher is re-armed with exponential backoff (max 60 s).
  function armWatcher() {
    if (stopped) return;
    try {
      mkdirSync(dir, { recursive: true });
      watcher = watch(dir, (eventType, filename) => {
        const name = filename ? String(filename) : '';
        if (name && (name.startsWith('.') || !name.toLowerCase().endsWith('.md'))) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          liveCache.clear();
          broadcast('changed');
        }, 150);
      });
      watcher.on('error', (err) => onWatchError(err));
      rearmDelay = 1000;
    } catch (err) {
      onWatchError(err);
    }
  }

  function onWatchError(err) {
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    if (stopped) return;
    broadcast('warning', { message: `Not watching the data folder (${err && err.code ? err.code : 'error'}); retrying. Use Refresh meanwhile.` });
    clearTimeout(rearmTimer);
    rearmTimer = setTimeout(() => {
      armWatcher();
      if (watcher) broadcast('changed');
    }, rearmDelay);
    rearmTimer.unref();
    rearmDelay = Math.min(rearmDelay * 2, 60000);
  }
  server.simulateWatchError = (err) => onWatchError(err); // for tests

  function startWatching() {
    armWatcher();
    pingTimer = setInterval(() => {
      for (const res of sseClients) {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }
    }, 25000);
    pingTimer.unref();
  }

  function stopAll() {
    stopped = true;
    clearTimeout(rearmTimer);
    clearTimeout(debounce);
    clearInterval(pingTimer);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
    sseClients.clear();
  }

  server.on('listening', startWatching);
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    stopAll();
    return origClose(cb);
  };

  async function handle(req, res) {
    setCommonHeaders(res);
    const p = boundPort();
    if (!checkHost(req, p) || !checkOrigin(req, p)) {
      req.resume();
      return sendJson(res, 403, { error: 'Forbidden' });
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      req.resume();
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      throw new HttpError(400, 'Bad URL');
    }
    const path = url.pathname;
    let body = null;
    if (req.method !== 'GET') {
      if (!checkToken(req, token)) {
        req.resume();
        return sendJson(res, 403, { error: 'Missing or invalid token' });
      }
      body = await readJsonBody(req);
    }

    // Static files (fixed map; request paths never reach the filesystem).
    if (Object.prototype.hasOwnProperty.call(STATIC, path)) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const s = STATIC[path];
      let content;
      try {
        content = readFileSync(join(PUBLIC_DIR, s.file), 'utf8');
      } catch {
        throw new HttpError(404, 'Not found');
      }
      const headers = { 'Content-Type': s.type };
      if (s.file === 'index.html') {
        content = content.replaceAll('{{TOKEN}}', token);
        headers['Content-Security-Policy'] = CSP;
      }
      headers['Content-Length'] = Buffer.byteLength(content);
      res.writeHead(200, headers);
      res.end(content);
      return;
    }

    if (path === '/api/config') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return sendJson(res, 200, { jiraBaseUrl: cfg.jiraBaseUrl ?? null, port: p, platform, canStart: platform === 'win32' });
    }

    if (path === '/api/items') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const items = listItems(dir).map((e) => (e.parseError ? { key: e.key, rev: e.rev, parseError: e.parseError } : toApiItem(e.item, e.rev, cfg)));
      return sendJson(res, 200, { items });
    }

    if (path === '/api/events') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      if (sseClients.size >= maxSseClients) throw new HttpError(503, 'Too many open board tabs');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    const m = /^\/api\/items\/([^/]+)(?:\/(live|prompt|start|steps|sessions)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) throw new HttpError(404, 'Not found');
    const key = decodeKey(m[1]);
    const sub = m[2] ?? '';
    const extra = m[3];
    if ((sub === 'steps' || sub === 'sessions') !== (extra !== undefined)) throw new HttpError(404, 'Not found');

    if (sub === '') {
      if (req.method === 'GET') {
        const cur = apiItemOrNull(key);
        if (!cur) throw new HttpError(404, 'Item not found');
        return sendJson(res, 200, cur.api);
      }
      if (req.method === 'PATCH') return patchItem(res, key, body);
      throw new HttpError(405, 'Method not allowed');
    }
    if (sub === 'live') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return getLive(res, key, url.searchParams.get('refresh') === '1');
    }
    if (sub === 'prompt') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const cur = apiItemOrNull(key);
      if (!cur) throw new HttpError(404, 'Item not found');
      const steps = selectedOpenSteps(cur.api, url.searchParams.get('steps') ?? '');
      return sendJson(res, 200, { prompt: buildPrompt(cur.api, steps) });
    }
    if (sub === 'steps') {
      if (req.method !== 'PUT') throw new HttpError(405, 'Method not allowed');
      if (!/^\d{1,4}$/.test(extra)) throw new HttpError(400, 'Invalid step index');
      return putStep(res, key, Number(extra), body);
    }
    if (sub === 'sessions') {
      if (req.method !== 'PATCH') throw new HttpError(405, 'Method not allowed');
      let id;
      try { id = decodeURIComponent(extra); } catch { throw new HttpError(400, 'Invalid session id'); }
      if (!SESSION_ID_RE.test(id)) throw new HttpError(400, 'Invalid session id');
      return patchSession(res, key, id, body);
    }
    if (sub === 'start') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      return startSession(res, key, body);
    }
    throw new HttpError(404, 'Not found');
  }

  function selectedOpenSteps(api, input) {
    const steps = parseSteps(input, api.steps.length);
    for (const i of steps) {
      if (api.steps[i].done) throw new HttpError(400, `Step ${i} is already done`);
    }
    return steps;
  }

  async function patchItem(res, key, body) {
    const rev = requireRev(body);
    const changes = {};
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
      changes.status = body.status;
    }
    if (body.waitingOn !== undefined) {
      if (body.waitingOn !== null && typeof body.waitingOn !== 'string') throw new HttpError(400, 'Invalid waitingOn');
      const w = body.waitingOn === null ? null : body.waitingOn.replace(/[\r\n]+/g, ' ').trim();
      if (w !== null && w.length > WAITING_ON_MAX) throw new HttpError(400, 'waitingOn is too long');
      changes.waitingOn = w === '' ? null : w;
    }
    if (!readItem(key, dir)) throw new HttpError(404, 'Item not found');
    const now = new Date();
    const r = await updateItem(key, rev, (item) => {
      if (!item) throw new HttpError(404, 'Item not found');
      const before = item.data.status;
      if ('status' in changes) item.data.status = changes.status;
      if ('waitingOn' in changes) item.data.waitingOn = changes.waitingOn;
      if (changes.status === 'done' && before !== 'done') appendLog(item, 'archived from board', now);
      item.data.updated = now.toISOString();
      return item;
    }, dir);
    return sendJson(res, 200, toApiItem(r.item, r.rev, cfg));
  }

  async function patchSession(res, key, id, body) {
    const rev = requireRev(body);
    const changes = {};
    if (body.open !== undefined) {
      if (typeof body.open !== 'boolean') throw new HttpError(400, 'open must be a boolean');
      changes.open = body.open;
    }
    if (body.note !== undefined) {
      if (body.note !== null && typeof body.note !== 'string') throw new HttpError(400, 'Invalid note');
      const n = body.note === null ? '' : body.note.replace(/\s*[\r\n]+\s*/g, ' ').trim();
      if (n.length > SESSION_NOTE_MAX) throw new HttpError(400, 'note is too long');
      changes.note = n === '' ? null : n;
    }
    if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change (open or note)');
    if (!readItem(key, dir)) throw new HttpError(404, 'Item not found');
    const r = await updateItem(key, rev, (item) => {
      if (!item) throw new HttpError(404, 'Item not found');
      const sessions = Array.isArray(item.data.sessions) ? item.data.sessions : [];
      const s = sessions.find((x) => x && typeof x === 'object' && x.id === id);
      if (!s) throw new HttpError(404, 'Session not found');
      if ('open' in changes) s.open = changes.open;
      if ('note' in changes) s.note = changes.note;
      item.data.updated = new Date().toISOString();
      return item;
    }, dir);
    return sendJson(res, 200, toApiItem(r.item, r.rev, cfg));
  }

  async function putStep(res, key, index, body) {
    const rev = requireRev(body);
    if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean');
    if (!readItem(key, dir)) throw new HttpError(404, 'Item not found');
    const r = await updateItem(key, rev, (item) => {
      if (!item) throw new HttpError(404, 'Item not found');
      const steps = getSteps(item);
      if (index >= steps.length) throw new HttpError(400, 'Invalid step index');
      if (steps[index].done === body.done) return null;
      setStepDone(item, index, body.done);
      item.data.updated = new Date().toISOString();
      return item;
    }, dir);
    return sendJson(res, 200, toApiItem(r.item, r.rev, cfg));
  }

  async function startSession(res, key, body) {
    const rev = requireRev(body);
    const r = readItem(key, dir);
    if (!r) throw new HttpError(404, 'Item not found');
    if (r.rev !== rev) throw new ConflictError({ item: r.item, rev: r.rev });
    const api = toApiItem(r.item, r.rev, cfg);
    const steps = selectedOpenSteps(api, body.steps === undefined ? [] : body.steps);
    if (platform !== 'win32') {
      throw new HttpError(501, 'Starting sessions is only supported on Windows. Use "Copy prompt" and paste it into Claude instead.');
    }
    if (!isExistingAbsDir(api.cwd)) throw new HttpError(422, 'The item has no existing local working directory (cwd); network (UNC) paths are not supported');
    const prompt = buildPrompt(api, steps);
    let result;
    try {
      result = await launch({ cwd: api.cwd, key, prompt, cfg, dir, tools });
    } catch (err) {
      throw new HttpError(500, `Launch failed: ${err && err.message ? err.message : err}`);
    }
    return sendJson(res, 202, { via: result && result.via === 'cmd' ? 'cmd' : 'wt' });
  }

  async function getLive(res, key, refresh) {
    const cur = apiItemOrNull(key);
    if (!cur) throw new HttpError(404, 'Item not found');
    const cached = liveCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < LIVE_TTL_MS) return sendJson(res, 200, cached.value);
    const cwd = cur.api.cwd;
    const gitFail = (error) => ({ ok: false, branch: null, ahead: 0, behind: 0, dirty: 0, upstream: null, error });
    // Only existing local directories are ever handed to git/gh (no UNC paths: no SMB/NTLM).
    if (!isExistingAbsDir(cwd, platform)) {
      const value = { git: gitFail(cwd ? 'working directory missing or not a local path' : 'no working directory recorded'), pr: null };
      liveCache.set(key, { at: Date.now(), value });
      return sendJson(res, 200, value);
    }
    let git;
    try {
      git = await limitLive(() => live.liveGit(cwd));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      git = gitFail(String(err && err.message ? err.message : err));
    }
    const ghOpts = { ghHosts: cfg.ghHosts || [] };
    const ref = normalizePrRef(cur.api.pr, ghOpts)
      ?? normalizePrRef(git && git.ok ? git.branch : null, ghOpts)
      ?? normalizePrRef(cur.api.branch, ghOpts);
    let pr = null;
    if (ref) {
      try {
        pr = await limitLive(() => live.livePr(cwd, ref));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        pr = { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }
    const value = { git, pr };
    liveCache.set(key, { at: Date.now(), value });
    return sendJson(res, 200, value);
  }

  return server;
}

function main() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig(dir);
  cleanupOldPrompts(dir);
  const tools = resolveTools();
  for (const [name, p] of Object.entries(tools)) {
    if (!p && (name !== 'wt' && name !== 'cmd' || process.platform === 'win32')) console.warn('Loose Ends: ' + name + ' not found on PATH' + (name === 'claude' ? ' (Start session will not work)' : name === 'wt' ? ' (falling back to cmd)' : ' (live facts limited)'));
  }
  const server = createServer({ dir, port: cfg.port, cfg, tools });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Loose Ends already running? Port ${cfg.port} in use`);
      process.exit(1);
    }
    console.error(`Loose Ends server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`Loose Ends running at http://127.0.0.1:${cfg.port}`);
    console.log(`Data directory: ${dir}`);
  });
}

if (isMainModule(import.meta.url)) main();
