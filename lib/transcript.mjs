import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { SESSION_ID_RE } from './keys.mjs';

export const TRANSCRIPT_CHUNK_BYTES = 65536;
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
export { SESSION_ID_RE };

// A forked or resumed session's transcript starts with entries copied from its ancestors,
// which carry their own `sessionId`s, followed by the session's own entries.
// The parent is the LAST foreign sessionId seen before the first own-id entry
// (for a fork of a fork: A... B... C... -> parent of C is B).
// Reads in chunks (first 64 KB, then more) up to `maxBytes`; if no own-id entry is found
// within that window, the last foreign id seen is used. Never throws; returns null if unknown.
export function findParentSessionId(transcriptPath, sessionId, { chunkBytes = TRANSCRIPT_CHUNK_BYTES, maxBytes = TRANSCRIPT_MAX_BYTES } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    let lastForeign = null;
    let carry = '';
    let pos = 0;
    const buf = Buffer.alloc(Math.max(1, chunkBytes));
    const decoder = new StringDecoder('utf8');
    const consider = (line) => {
      if (!line.trim()) return false;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return false;
      }
      if (!entry || typeof entry !== 'object') return false;
      const id = entry.sessionId;
      if (typeof id !== 'string') return false;
      if (id === sessionId) return true; // reached our own entries
      if (SESSION_ID_RE.test(id)) lastForeign = id;
      return false;
    };
    while (pos < maxBytes) {
      const want = Math.min(buf.length, maxBytes - pos);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) {
        // End of file: the remaining text is a complete last line.
        consider(carry + decoder.end());
        return lastForeign;
      }
      pos += n;
      const text = carry + decoder.write(buf.subarray(0, n));
      const lines = text.split(/\r?\n/);
      carry = lines.pop();
      for (const line of lines) {
        if (consider(line)) return lastForeign;
      }
    }
    // Read window exhausted: the trailing partial line is ignored.
    return lastForeign;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}
