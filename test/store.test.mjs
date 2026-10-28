import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { getSection, setSection } from '../lib/item.mjs';
import { ConflictError, listItems, readItem, updateItem, writeFileAtomic } from '../lib/store.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const SAMPLE = '---\nkey: ABC-123\ntitle: Sample\nstatus: active\n---\n\n## Summary\nHello\n';

describe('store', () => {
  test('Given_ExistingFile_When_WriteFileAtomic_Then_ReplacedWithoutTmpLeftBehind', async () => {
    const dir = tempDir();
    const p = join(dir, 'ABC-123.md');
    writeFileSync(p, 'old');


    await writeFileAtomic(p, 'new content');


    assert.equal(readFileSync(p, 'utf8'), 'new content');
    assert.deepEqual(readdirSync(dir), ['ABC-123.md']);
  });

  test('Given_StaleRev_When_UpdateItem_Then_ThrowsConflictError', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABC-123.md'), SAMPLE);


    const attempt = updateItem('ABC-123', '0000000000000000', (item) => item, dir);


    await assert.rejects(attempt, ConflictError);
  });

  test('Given_CurrentRev_When_UpdateItem_Then_WritesAndReturnsNewRev', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABC-123.md'), SAMPLE);
    const { rev } = readItem('ABC-123', dir);


    const r = await updateItem('ABC-123', rev, (item) => { item.data.status = 'parked'; return item; }, dir);


    assert.notEqual(r.rev, rev);
    assert.equal(readItem('ABC-123', dir).rev, r.rev);
    assert.ok(readFileSync(join(dir, 'ABC-123.md'), 'utf8').includes('status: parked'));
  });

  test('Given_TwoConcurrentUpdates_When_UpdateItem_Then_BothApplied', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABC-123.md'), SAMPLE);
    const slowAppend = (line) => async (item) => {
      const cur = getSection(item, 'Notes');
      await new Promise((r) => setTimeout(r, 20));
      setSection(item, 'Notes', cur ? `${cur}\n${line}` : line);
      return item;
    };


    await Promise.all([
      updateItem('ABC-123', null, slowAppend('one'), dir),
      updateItem('ABC-123', null, slowAppend('two'), dir),
    ]);


    const notes = getSection(readItem('ABC-123', dir).item, 'Notes');
    assert.equal(notes, 'one\ntwo');
  });

  test('Given_MixedDirectoryContents_When_ListItems_Then_OnlyValidMarkdownItemsAndParseErrorReported', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABC-123.md'), SAMPLE);
    writeFileSync(join(dir, '.hidden.md'), SAMPLE);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'CON.md'), SAMPLE);
    writeFileSync(join(dir, 'config.json'), '{}');
    mkdirSync(join(dir, 'XYZ-9.md')); // a directory named like an item cannot be read


    const items = listItems(dir);


    assert.deepEqual(items.map((i) => i.key).sort(), ['ABC-123', 'XYZ-9']);
    const bad = items.find((i) => i.key === 'XYZ-9');
    assert.ok(bad.parseError);
    const good = items.find((i) => i.key === 'ABC-123');
    assert.equal(good.item.data.title, 'Sample');
    assert.match(good.rev, /^[0-9a-f]{16}$/);
  });

  test('Given_CrlfFile_When_ReadItem_Then_TextNormalized', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ABC-123.md'), '﻿' + SAMPLE.replace(/\n/g, '\r\n'));


    const r = readItem('ABC-123', dir);


    assert.equal(r.text, SAMPLE);
    assert.equal(r.item.data.title, 'Sample');
  });

  test('Given_MissingDir_When_ListItems_Then_Empty', () => {
    assert.deepEqual(listItems(join(tempDir(), 'nope')), []);
  });
});
