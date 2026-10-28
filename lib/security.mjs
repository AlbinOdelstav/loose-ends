import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const BODY_LIMIT = 16384;
export const MAX_STEPS = 200;

export function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function checkHost(req, port) {
  const host = req.headers && req.headers.host;
  if (typeof host !== 'string' || !host) return false;
  return allowedHosts(port).has(host.toLowerCase());
}

export function checkOrigin(req, port) {
  const h = req.headers || {};
  const site = h['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    // A top-level GET navigation to the board page itself (e.g. clicking a link to it) is
    // allowed; it cannot read the response cross-origin. Nothing else is.
    const path = String(req.url || '').split('?')[0];
    const isNavigation = h['sec-fetch-mode'] === 'navigate' && req.method === 'GET' && path === '/';
    if (!isNavigation) return false;
  }
  const origin = h.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function checkToken(req, token) {
  const got = req.headers && req.headers['x-loose-ends-token'];
  if (typeof got !== 'string' || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      req.resume();
      reject(new HttpError(415, 'Content-Type must be application/json'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    const onData = (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        done = true;
        chunks.length = 0;
        req.removeListener('data', onData);
        req.resume();
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(new HttpError(400, `Request error: ${err.message}`));
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'JSON body must be an object'));
        return;
      }
      resolve(parsed);
    });
  });
}

export function parseSteps(input, stepCount) {
  let list;
  if (typeof input === 'string') {
    if (input === '') return [];
    if (!/^\d+(,\d+)*$/.test(input)) throw new HttpError(400, 'Invalid steps');
    list = input.split(',').map(Number);
  } else if (Array.isArray(input)) {
    list = input;
  } else {
    throw new HttpError(400, 'Invalid steps');
  }
  if (list.length > MAX_STEPS) throw new HttpError(400, 'Too many steps');
  const seen = new Set();
  for (const n of list) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= stepCount) {
      throw new HttpError(400, 'Invalid step index');
    }
    if (seen.has(n)) throw new HttpError(400, 'Duplicate step index');
    seen.add(n);
  }
  return list;
}
