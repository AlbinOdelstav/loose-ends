import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseFrontmatter, parseScalar, serializeFrontmatter, serializeScalar } from '../lib/frontmatter.mjs';

const ALL_FIELDS = [
  '---',
  'key: ABC-123',
  'title: Fix the login timeout',
  'status: waiting',
  'waitingOn: "Review: platform team"',
  'jiraStatus: In Review',
  'repo: C:\\src\\app',
  'cwd: C:\\src\\app-worktrees\\abc-123',
  'branch: feature/abc-123-login',
  'pr: 42',
  'updated: 2026-01-31T14:05:00.000Z',
  'lastCheckpoint: 2026-01-30T10:00:00.000Z',
  'sessions:',
  '  - id: 0f6c2a9e-1111-2222-3333-444455556666',
  '    cwd: C:\\src\\app-worktrees\\abc-123',
  '    branch: feature/abc-123-login',
  '    endedAt: 2026-01-31T14:06:10.000Z',
  'sessionsSinceCheckpoint: 2',
  '---',
  '',
  '## Summary',
  'Body text.',
  '',
].join('\n');

function values(fm) {
  const out = {};
  for (const [k, e] of fm.fields) if (!e.pseudo && e.ok) out[k] = e.value;
  return out;
}

describe('frontmatter', () => {
  test('Given_EveryKnownFieldType_When_RoundTripped_Then_OutputIsByteIdentical', () => {
    const fm = parseFrontmatter(ALL_FIELDS);
    const out = serializeFrontmatter(fm.fields, fm.order, values(fm)) + fm.body;
    assert.equal(out, ALL_FIELDS);
    assert.equal(fm.fields.get('pr').value, 42);
    assert.equal(fm.fields.get('waitingOn').value, 'Review: platform team');
    assert.equal(fm.fields.get('sessions').value[0].endedAt, '2026-01-31T14:06:10.000Z');
  });

  test('Given_UnknownScalarAndBlockScalar_When_TitleChanged_Then_BothKeptVerbatim', () => {
    const text = [
      '---',
      'key: ABC-123',
      'title: Old title',
      'customField: keep me',
      'notes2: |',
      '  line one',
      '  line two',
      '# a comment',
      'status: active',
      '---',
      'body',
    ].join('\n');
    const fm = parseFrontmatter(text);
    assert.equal(fm.fields.get('notes2').ok, false);
    const vals = values(fm);
    vals.title = 'New title';


    const out = serializeFrontmatter(fm.fields, fm.order, vals) + fm.body;


    assert.equal(out, text.replace('title: Old title', 'title: New title'));
  });

  test('Given_AmbiguousStrings_When_Serialized_Then_QuotedAndParsedBackUnchanged', () => {
    const samples = ['123', '-5', 'true', 'false', 'null', '~', 'a: b', 'value #comment', ' leading', 'trailing ', '- dash', '[x]', '"quoted"', ''];
    for (const s of samples) {
      const out = serializeScalar(s);


      const back = parseScalar(out);


      assert.ok(out.startsWith('"'), `expected ${JSON.stringify(s)} to be quoted, got ${out}`);
      assert.equal(back, s);
    }
  });

  test('Given_WindowsPath_When_Serialized_Then_WrittenPlainAndBackslashesPreserved', () => {
    const p = 'C:\\code\\src\\repo';


    const out = serializeScalar(p);
    const fm = parseFrontmatter(`---\ncwd: ${out}\n---\n`);


    assert.equal(out, p);
    assert.equal(fm.fields.get('cwd').value, p);
  });

  test('Given_EmptyListAndListOfMaps_When_Parsed_Then_BothParse', () => {
    const fm = parseFrontmatter([
      '---',
      'sessions: []',
      'other:',
      '  - id: s1',
      '    cwd: C:\\a',
      '  - id: s2',
      '    branch: main',
      'tags:',
      '- one',
      '- "two: 2"',
      '---',
      '',
    ].join('\n'));


    assert.deepEqual(fm.fields.get('sessions').value, []);
    assert.deepEqual(fm.fields.get('other').value, [{ id: 's1', cwd: 'C:\\a' }, { id: 's2', branch: 'main' }]);
    assert.deepEqual(fm.fields.get('tags').value, ['one', 'two: 2']);
  });

  test('Given_CrlfAndBom_When_Parsed_Then_Normalized', () => {
    const text = '\uFEFF---\r\ntitle: Hello\r\nstatus: active\r\n---\r\n## Summary\r\nText\r\n';


    const fm = parseFrontmatter(text);


    assert.equal(fm.hasFrontmatter, true);
    assert.equal(fm.fields.get('title').value, 'Hello');
    assert.equal(fm.body, '## Summary\nText\n');
  });

  test('Given_NoFrontmatter_When_Parsed_Then_EmptyFieldsAndBodyIntact', () => {
    const text = '## Summary\nJust a body\n';


    const fm = parseFrontmatter(text);


    assert.equal(fm.hasFrontmatter, false);
    assert.equal(fm.fields.size, 0);
    assert.equal(fm.body, text);
  });

  test('Given_DuplicateKey_When_Parsed_Then_LastOneWinsAndRoundTripIsIdentical', () => {
    const text = '---\ntitle: first\ntitle: second\n---\n';


    const fm = parseFrontmatter(text);
    const out = serializeFrontmatter(fm.fields, fm.order, values(fm)) + fm.body;


    assert.equal(fm.fields.get('title').value, 'second');
    assert.equal(out, text);
  });

  test('Given_NewKeys_When_Serialized_Then_AppendedInCanonicalOrder', () => {
    const fm = parseFrontmatter('---\ncustom: x\n---\n');


    const out = serializeFrontmatter(fm.fields, fm.order, { custom: 'x', sessionsSinceCheckpoint: 1, status: 'active', key: 'ABC-123', sessions: [] });


    assert.equal(out, '---\ncustom: x\nkey: ABC-123\nstatus: active\nsessions: []\nsessionsSinceCheckpoint: 1\n---\n');
  });
});
