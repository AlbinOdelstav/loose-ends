import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { handleSessionEnd } from '../hooks/session-end.mjs';
import { readItem } from '../lib/store.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const HOOK = fileURLToPath(new URL('../hooks/session-end.mjs', import.meta.url));

function makeRepo(root, name, branch) {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return repo;
}

// Writes a transcript whose entries carry the given session ids in order (parent entries first).
function writeTranscript(root, ids) {
  const p = join(root, `${ids[ids.length - 1]}.jsonl`);
  writeFileSync(p, ids.map((id, i) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', sessionId: id })).join('\n') + '\n');
  return p;
}

function setup(branch = 'feature/abc-123-fix') {
  const root = tempDir();
  const dir = join(root, 'data');
  const repo = makeRepo(root, 'app', branch);
  return { root, dir, repo };
}

describe('session-end hook', () => {
  test('Given_BranchWithKeyAndNoItem_When_SessionEnds_Then_StubCreated', async () => {
    const { dir, repo } = setup();


    const r = await handleSessionEnd({ session_id: 'sess-1', cwd: repo }, { dir, now: new Date('2026-03-01T10:00:00Z') });


    assert.deepEqual(r, { action: 'created', key: 'ABC-123', parentId: null, inherited: false });
    const { item } = readItem('ABC-123', dir);
    assert.equal(item.data.status, 'active');
    assert.equal(item.data.title, 'feature/abc-123-fix');
    assert.equal(item.data.sessionsSinceCheckpoint, 1);
    assert.equal(item.data.cwd, repo);
    assert.equal(item.data.repo, repo);
    assert.equal(item.data.branch, 'feature/abc-123-fix');
    assert.deepEqual(item.data.sessions, [{ id: 'sess-1', parentId: null, cwd: repo, branch: 'feature/abc-123-fix', endedAt: '2026-03-01T10:00:00.000Z' }]);
  });

  test('Given_ExistingItem_When_SecondSessionEnds_Then_SessionAppendedAndCounterIs2', async () => {
    const { dir, repo } = setup();
    await handleSessionEnd({ session_id: 'sess-1', cwd: repo }, { dir });


    const r = await handleSessionEnd({ session_id: 'sess-2', cwd: repo }, { dir });


    assert.equal(r.action, 'updated');
    const { item } = readItem('ABC-123', dir);
    assert.equal(item.data.sessionsSinceCheckpoint, 2);
    assert.deepEqual(item.data.sessions.map((s) => s.id), ['sess-1', 'sess-2']);
  });

  test('Given_SameSessionIdTwice_When_SessionEnds_Then_DedupedAndCounterUnchanged', async () => {
    const { dir, repo } = setup();
    await handleSessionEnd({ session_id: 'sess-1', cwd: repo }, { dir, now: new Date('2026-03-01T10:00:00Z') });


    await handleSessionEnd({ session_id: 'sess-1', cwd: repo }, { dir, now: new Date('2026-03-01T11:00:00Z') });


    const { item } = readItem('ABC-123', dir);
    assert.equal(item.data.sessionsSinceCheckpoint, 1);
    assert.equal(item.data.sessions.length, 1);
    assert.equal(item.data.sessions[0].endedAt, '2026-03-01T11:00:00.000Z');
  });

  test('Given_WorktreeGitFile_When_SessionEnds_Then_RepoIsMainDirAndCwdIsWorktreeRoot', async () => {
    const root = tempDir();
    const dir = join(root, 'data');
    const main = join(root, 'main');
    const wtGitDir = join(main, '.git', 'worktrees', 'wt1');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature/xyz-9-thing\n');
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n');
    const wt = join(root, 'wt-folder');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitDir}\n`);


    const r = await handleSessionEnd({ session_id: 's', cwd: join(wt, 'src') }, { dir });


    assert.equal(r.key, 'XYZ-9');
    const { item } = readItem('XYZ-9', dir);
    assert.equal(item.data.repo, main);
    assert.equal(item.data.cwd, wt);
    assert.equal(item.data.branch, 'feature/xyz-9-thing');
  });

  test('Given_CheckpointAfterTranscriptMtime_When_SessionEnds_Then_CounterNotIncremented', async () => {
    const { root, dir, repo } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), `---\nkey: ABC-123\ntitle: T\nstatus: active\nlastCheckpoint: ${new Date().toISOString()}\nsessionsSinceCheckpoint: 0\n---\n`);
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, '{}\n');


    await handleSessionEnd({ session_id: 'sess-9', cwd: repo, transcript_path: transcript }, { dir });


    const { item } = readItem('ABC-123', dir);
    assert.equal(item.data.sessionsSinceCheckpoint, 0);
    assert.equal(item.data.sessions.length, 1);
    assert.equal(item.data.title, 'T');
  });

  test('Given_OldCheckpoint_When_SessionEnds_Then_CounterIncremented', async () => {
    const { root, dir, repo } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), '---\nkey: ABC-123\ntitle: T\nlastCheckpoint: 2020-01-01T00:00:00.000Z\nsessionsSinceCheckpoint: 0\n---\n');
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, '{}\n');


    await handleSessionEnd({ session_id: 'sess-9', cwd: repo, transcript_path: transcript }, { dir });


    assert.equal(readItem('ABC-123', dir).item.data.sessionsSinceCheckpoint, 1);
  });

  test('Given_NoKeyInBranchOrDir_When_SessionEnds_Then_NoFileWritten', async () => {
    const root = tempDir();
    const dir = join(root, 'data');
    const repo = makeRepo(root, 'plain', 'main');


    const r = await handleSessionEnd({ session_id: 's', cwd: repo }, { dir });


    assert.equal(r.action, 'none');
    assert.equal(existsSync(dir), false);
  });

  test('Given_MissingCwd_When_SessionEnds_Then_NothingHappens', async () => {
    const dir = join(tempDir(), 'data');


    const r = await handleSessionEnd({ session_id: 's' }, { dir });


    assert.equal(r.action, 'none');
  });

  test('Given_ForkTranscript_When_SessionEnds_Then_ParentIdRecordedAndSessionUntracked', async () => {
    const { root, dir, repo } = setup();
    const t = writeTranscript(root, ['parent-1', 'fork-1']);


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: repo, transcript_path: t }, { dir });


    assert.equal(r.parentId, 'parent-1');
    const s = readItem('ABC-123', dir).item.data.sessions[0];
    assert.equal(s.parentId, 'parent-1');
    assert.equal('open' in s, false);
    assert.equal('note' in s, false);
  });

  test('Given_ForkOfAFork_When_SessionEnds_Then_ParentIsTheNearestAncestor', async () => {
    const { root, dir, repo } = setup();
    const t = writeTranscript(root, ['sess-a', 'sess-a', 'sess-b', 'sess-b', 'sess-c']);


    const r = await handleSessionEnd({ session_id: 'sess-c', cwd: repo, transcript_path: t }, { dir });


    assert.equal(r.parentId, 'sess-b');
  });

  test('Given_MissingSessionId_When_SessionEnds_Then_NoRecordButCounterAndUpdatedChange', async () => {
    const { dir, repo } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), '---\nkey: ABC-123\nupdated: 2020-01-01T00:00:00.000Z\nsessions: []\nsessionsSinceCheckpoint: 0\n---\n');


    const r = await handleSessionEnd({ cwd: repo }, { dir, now: new Date('2026-03-01T10:00:00Z') });


    assert.equal(r.action, 'updated');
    const d = readItem('ABC-123', dir).item.data;
    assert.deepEqual(d.sessions, []);
    assert.equal(d.sessionsSinceCheckpoint, 1);
    assert.equal(d.updated, '2026-03-01T10:00:00.000Z');
  });

  test('Given_MissingSessionIdAndNoItem_When_SessionEnds_Then_StubWithoutSessions', async () => {
    const { dir, repo } = setup();


    await handleSessionEnd({ session_id: 'not a valid id!', cwd: repo }, { dir });


    const d = readItem('ABC-123', dir).item.data;
    assert.deepEqual(d.sessions, []);
    assert.equal(d.sessionsSinceCheckpoint, 1);
  });

  test('Given_UncTranscriptPath_When_SessionEnds_Then_TranscriptNotTouched', async () => {
    const { dir, repo } = setup();


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: repo, transcript_path: '\\\\attacker.invalid\\share\\t.jsonl' }, { dir });


    assert.equal(r.parentId, null);
    assert.equal(r.action, 'created');
  });

  test('Given_ParentOnlyInDoneItem_When_ForkWithoutKeyEnds_Then_NotInherited', async () => {
    const root = tempDir();
    const dir = join(root, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), '---\nkey: ABC-123\nstatus: done\nsessions:\n  - id: parent-1\n---\n');
    const fork = makeRepo(root, 'fresh-worktree', 'claude/quirky-name');
    const t = writeTranscript(root, ['parent-1', 'fork-1']);


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: fork, transcript_path: t }, { dir });


    assert.equal(r.action, 'none');
    assert.equal(readItem('ABC-123', dir).item.data.sessions.length, 1);
  });

  test('Given_MalformedNoteInSessions_When_SessionEnds_Then_ExistingRecordsKept', async () => {
    const { dir, repo } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), "---\nkey: ABC-123\nsessions:\n  - id: s1\n    note: [WIP] refactor 'auth'\n    open: true\n---\n");


    await handleSessionEnd({ session_id: 's2', cwd: repo }, { dir });


    const sessions = readItem('ABC-123', dir).item.data.sessions;
    assert.deepEqual(sessions.map((s) => s.id), ['s1', 's2']);
    assert.equal(sessions[0].note, "[WIP] refactor 'auth'");
  });

  test('Given_ForkWithoutKeyAndParentOnItem_When_SessionEnds_Then_AttachedToParentItem', async () => {
    const root = tempDir();
    const dir = join(root, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), '---\nkey: ABC-123\ntitle: T\nstatus: active\nsessions:\n  - id: parent-1\n    cwd: C:\\x\n---\n');
    writeFileSync(join(dir, 'XYZ-9.md'), '---\nkey: XYZ-9\ntitle: Other\nsessions: []\n---\n');
    const fork = makeRepo(root, 'fresh-worktree', 'claude/quirky-name');
    const t = writeTranscript(root, ['parent-1', 'fork-1']);


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: fork, transcript_path: t }, { dir });


    assert.deepEqual(r, { action: 'updated', key: 'ABC-123', parentId: 'parent-1', inherited: true });
    const sessions = readItem('ABC-123', dir).item.data.sessions;
    assert.deepEqual(sessions.map((s) => [s.id, s.parentId ?? null]), [['parent-1', null], ['fork-1', 'parent-1']]);
    assert.deepEqual(readItem('XYZ-9', dir).item.data.sessions, []);
  });

  test('Given_ForkWithoutKeyAndUnknownParent_When_SessionEnds_Then_NothingWritten', async () => {
    const root = tempDir();
    const dir = join(root, 'data');
    const fork = makeRepo(root, 'fresh-worktree', 'claude/quirky-name');
    const t = writeTranscript(root, ['parent-x', 'fork-1']);


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: fork, transcript_path: t }, { dir });


    assert.equal(r.action, 'none');
    assert.equal(existsSync(dir), false);
  });

  test('Given_ExplicitKeyAndParentInOtherItem_When_SessionEnds_Then_ExplicitKeyWinsAndParentIdKept', async () => {
    const { root, dir, repo } = setup('feature/xyz-9-split');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ABC-123.md'), '---\nkey: ABC-123\nsessions:\n  - id: parent-1\n---\n');
    const t = writeTranscript(root, ['parent-1', 'fork-1']);


    const r = await handleSessionEnd({ session_id: 'fork-1', cwd: repo, transcript_path: t }, { dir });


    assert.equal(r.key, 'XYZ-9');
    assert.equal(r.inherited, false);
    assert.equal(readItem('XYZ-9', dir).item.data.sessions[0].parentId, 'parent-1');
    assert.equal(readItem('ABC-123', dir).item.data.sessions.length, 1);
  });

  test('Given_FullSessionListWithOldOpenSession_When_SessionEnds_Then_ClosedDroppedOpenKept', async () => {
    const { dir, repo } = setup();
    mkdirSync(dir, { recursive: true });
    const lines = ['---', 'key: ABC-123', 'sessions:', '  - id: old-open', '    open: true'];
    for (let i = 0; i < 20; i++) lines.push(`  - id: closed-${i}`, '    open: false');
    lines.push('---', '');
    writeFileSync(join(dir, 'ABC-123.md'), lines.join('\n'));


    await handleSessionEnd({ session_id: 'new-1', cwd: repo }, { dir });


    const ids = readItem('ABC-123', dir).item.data.sessions.map((s) => s.id);
    assert.equal(ids.length, 21);
    assert.equal(ids[0], 'old-open');
    assert.equal(ids.includes('closed-0'), false);
    assert.equal(ids[ids.length - 1], 'new-1');
  });

  test('Given_GarbageStdin_When_ScriptRuns_Then_Exits0AndWritesHookLog', () => {
    const dir = tempDir();


    const res = spawnSync(process.execPath, [HOOK, '--loose-ends-hook'], {
      input: 'this is not json',
      env: { ...process.env, LOOSE_ENDS_DIR: dir },
      timeout: 10000,
    });


    assert.equal(res.status, 0);
    assert.ok(existsSync(join(dir, '.hook.log')));
    assert.match(readFileSync(join(dir, '.hook.log'), 'utf8'), /session-end hook error/);
  });

  test('Given_ValidPayload_When_ScriptRuns_Then_Exits0AndCreatesItem', () => {
    const { dir, repo } = setup();


    const res = spawnSync(process.execPath, [HOOK, '--loose-ends-hook'], {
      input: JSON.stringify({ session_id: 'abc', cwd: repo, hook_event_name: 'SessionEnd', reason: 'other' }),
      env: { ...process.env, LOOSE_ENDS_DIR: dir },
      timeout: 10000,
    });


    assert.equal(res.status, 0);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.md')), ['ABC-123.md']);
  });
});
