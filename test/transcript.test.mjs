import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { findParentSessionId } from '../lib/transcript.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const GRANDPARENT = '00000000-aaaa-bbbb-cccc-000000000000';
const PARENT = '11111111-aaaa-bbbb-cccc-000000000001';
const CHILD = '22222222-aaaa-bbbb-cccc-000000000002';

function transcript(lines) {
  const p = join(tempDir(), 'session.jsonl');
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

describe('transcript parent detection', () => {
  test('Given_ForkedTranscript_When_FindParent_Then_ReturnsParentSessionId', () => {
    const p = transcript([
      { type: 'summary', summary: 'x' },
      { type: 'user', sessionId: PARENT, message: { content: 'hi' } },
      { type: 'assistant', sessionId: PARENT },
      { type: 'user', sessionId: CHILD },
    ]);


    const parent = findParentSessionId(p, CHILD);


    assert.equal(parent, PARENT);
  });

  test('Given_ForkOfAFork_When_FindParent_Then_ReturnsLastForeignIdBeforeOwnEntries', () => {
    const p = transcript([
      { sessionId: GRANDPARENT },
      { sessionId: GRANDPARENT },
      { sessionId: PARENT },
      { sessionId: CHILD },
      { sessionId: 'later-foreign-id' },
    ]);


    const parent = findParentSessionId(p, CHILD);


    assert.equal(parent, PARENT);
  });

  test('Given_OwnEntriesOnly_When_FindParent_Then_ReturnsNull', () => {
    const p = transcript([{ type: 'user', sessionId: CHILD }, { type: 'assistant', sessionId: CHILD }]);


    const parent = findParentSessionId(p, CHILD);


    assert.equal(parent, null);
  });

  test('Given_ForeignIdOnlyAfterOwnEntries_When_FindParent_Then_ReturnsNull', () => {
    const p = transcript([{ sessionId: CHILD }, { sessionId: PARENT }]);


    const parent = findParentSessionId(p, CHILD);


    assert.equal(parent, null);
  });

  test('Given_GarbageAndNonObjectLines_When_FindParent_Then_SkippedAndParentFound', () => {
    const p = transcript(['not json at all', '{"broken": ', '42', 'null', '', { sessionId: 'bad id with spaces' }, { sessionId: PARENT }, { sessionId: CHILD }]);


    const parent = findParentSessionId(p, CHILD);


    assert.equal(parent, PARENT);
  });

  test('Given_MissingFile_When_FindParent_Then_ReturnsNull', () => {
    const missing = join(tempDir(), 'nope.jsonl');


    const parent = findParentSessionId(missing, CHILD);


    assert.equal(parent, null);
  });

  test('Given_DirectoryInsteadOfFile_When_FindParent_Then_ReturnsNull', () => {
    const dir = tempDir();


    const parent = findParentSessionId(dir, CHILD);


    assert.equal(parent, null);
  });

  test('Given_MissingSessionIdOrPath_When_FindParent_Then_ReturnsNull', () => {
    const p = transcript([{ sessionId: PARENT }]);


    const withoutId = findParentSessionId(p, null);
    const withoutPath = findParentSessionId(undefined, CHILD);


    assert.equal(withoutId, null);
    assert.equal(withoutPath, null);
  });

  test('Given_ParentEntriesSpanSeveralChunks_When_FindParent_Then_KeepsReadingUntilOwnEntry', () => {
    const filler = { sessionId: GRANDPARENT, pad: 'x'.repeat(200) };
    const p = transcript([filler, filler, filler, { sessionId: PARENT, pad: 'y'.repeat(200) }, { sessionId: CHILD }]);


    const parent = findParentSessionId(p, CHILD, { chunkBytes: 64 });


    assert.equal(parent, PARENT);
  });

  test('Given_OwnEntryBeyondReadWindow_When_FindParent_Then_LastCompleteForeignIdUsed', () => {
    const first = JSON.stringify({ sessionId: GRANDPARENT });
    const p = transcript([first, { sessionId: PARENT, pad: 'y'.repeat(500) }, { sessionId: CHILD }]);


    const parent = findParentSessionId(p, CHILD, { chunkBytes: 16, maxBytes: first.length + 30 });


    assert.equal(parent, GRANDPARENT);
  });
});
