#!/usr/bin/env node
// Claude Code SessionEnd hook for Loose Ends.
// Reads the hook payload from stdin, detects the work item key from the git branch or
// directory name, and records the session on the item. No LLM calls, no spawning,
// never fails the session: always exits 0 and logs errors to <dataDir>/.hook.log.

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, isMainModule, loadConfig } from '../lib/config.mjs';
import { readGitInfo } from '../lib/git.mjs';
import { capSessions, newStubItem } from '../lib/item.mjs';
import { detectKey, SESSION_ID_RE, validateKey } from '../lib/keys.mjs';
import { isSafeLocalPath } from '../lib/paths.mjs';
import { listItems, updateItem } from '../lib/store.mjs';
import { findParentSessionId } from '../lib/transcript.mjs';

const isEmpty = (v) => v === null || v === undefined || v === '';
const CHECKPOINT_GRACE_MS = 120000;

function checkpointCoversSession(lastCheckpoint, transcriptPath) {
  if (typeof lastCheckpoint !== 'string' || typeof transcriptPath !== 'string' || !transcriptPath) return false;
  const cp = Date.parse(lastCheckpoint);
  if (Number.isNaN(cp)) return false;
  let mtime;
  try {
    mtime = statSync(transcriptPath).mtimeMs;
  } catch {
    return false;
  }
  return cp >= mtime - CHECKPOINT_GRACE_MS;
}

// Finds the (not done) item whose sessions list contains `sessionId`.
// Done items are skipped: a fork of finished work starts nothing on the board.
export function findItemKeyBySession(dir, sessionId) {
  if (!sessionId) return null;
  for (const e of listItems(dir)) {
    if (!e.item || e.item.data.status === 'done') continue;
    const sessions = e.item.data.sessions;
    if (Array.isArray(sessions) && sessions.some((s) => s && s.id === sessionId)) return e.key;
  }
  return null;
}

export async function handleSessionEnd(payload, { dir = dataDir(), now = new Date(), cfg = {} } = {}) {
  if (!payload || typeof payload !== 'object') return { action: 'none' };
  const cwd = payload.cwd;
  if (typeof cwd !== 'string' || !cwd) return { action: 'none' };
  const g = readGitInfo(cwd);
  const sessionId = typeof payload.session_id === 'string' && SESSION_ID_RE.test(payload.session_id) ? payload.session_id : null;
  const transcriptPath = isSafeLocalPath(payload.transcript_path) ? payload.transcript_path : null;
  const parentId = findParentSessionId(transcriptPath, sessionId);
  // An explicit key (branch / directory name) wins; otherwise inherit the parent session's item.
  let key = detectKey({ branch: g.branch, cwd, worktreeRoot: g.worktreeRoot }, cfg);
  let inherited = false;
  if (!key && parentId) {
    key = findItemKeyBySession(dir, parentId);
    inherited = !!key;
  }
  if (!key || !validateKey(key)) return { action: 'none' };

  const endedAt = now.toISOString();
  // New records are "untracked" (no `open` field): only /checkpoint or the board make a
  // session an open thread. Without a session id no record is written at all.
  const record = sessionId ? { id: sessionId, parentId, cwd, branch: g.branch ?? null, endedAt } : null;
  let action = 'none';

  await updateItem(key, null, (item) => {
    if (!item) {
      const stub = newStubItem({
        key,
        title: g.branch ?? key,
        cwd: g.worktreeRoot ?? cwd,
        repo: g.repo ?? null,
        branch: g.branch ?? null,
        now,
      });
      stub.data.sessions = record ? [record] : [];
      stub.data.sessionsSinceCheckpoint = 1;
      action = 'created';
      return stub;
    }
    const d = item.data;
    const sessions = Array.isArray(d.sessions) ? d.sessions.filter((s) => s && typeof s === 'object' && !Array.isArray(s)) : [];
    const existing = sessionId ? sessions.find((s) => s.id === sessionId) : null;
    if (existing) {
      existing.endedAt = endedAt;
      if (!existing.parentId && parentId) existing.parentId = parentId;
    } else if (record) {
      sessions.push(record);
    }
    if (record || existing) d.sessions = capSessions(sessions);
    if (isEmpty(d.cwd)) d.cwd = g.worktreeRoot ?? cwd;
    if (isEmpty(d.branch) && g.branch) d.branch = g.branch;
    if (isEmpty(d.repo) && g.repo) d.repo = g.repo;
    if (!existing && !checkpointCoversSession(d.lastCheckpoint, transcriptPath)) {
      const n = Number.isInteger(d.sessionsSinceCheckpoint) && d.sessionsSinceCheckpoint > 0 ? d.sessionsSinceCheckpoint : 0;
      d.sessionsSinceCheckpoint = n + 1;
    }
    d.updated = endedAt;
    action = 'updated';
    return item;
  }, dir);

  return { action, key, parentId, inherited };
}

function logError(dir, msg) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '.hook.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* swallow */
  }
}

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  let dir;
  try {
    dir = dataDir();
  } catch {
    process.exit(0);
  }
  try {
    const raw = await readStdin();
    let text = raw;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const payload = JSON.parse(text);
    const cfg = loadConfig(dir);
    await handleSessionEnd(payload, { dir, cfg });
  } catch (err) {
    logError(dir, `session-end hook error: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main().catch(() => process.exit(0));
}
