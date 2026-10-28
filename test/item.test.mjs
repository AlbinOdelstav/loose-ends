import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appendLog, buildSessionTree, capSessions, normalizeSessions, getSection, getSteps, newStubItem, parseItem, serializeItem, setSection, setStepDone, toApiItem } from '../lib/item.mjs';

const ITEM = [
  '---',
  'key: ABC-123',
  'title: Fix login',
  'status: active',
  '---',
  '',
  '## Summary',
  'Short summary.',
  '',
  '## Custom',
  'Keep this exactly.',
  '',
  '## Next steps',
  '- [x] First done',
  '- [ ] Second open',
  '```',
  '- [ ] Not a step (fenced)',
  '```',
  '* [X] Third done',
  '- [ ] Fourth open',
  '',
  '## Notes',
  'Some notes.',
  '',
].join('\n');

describe('item', () => {
  test('Given_UnknownCustomSection_When_RoundTripped_Then_KeptInPlace', () => {
    const item = parseItem(ITEM, 'ABC-123');


    const out = serializeItem(item);


    assert.equal(out, ITEM);
    assert.deepEqual(item.sections.map((s) => s.heading), [null, 'Summary', 'Custom', 'Next steps', 'Notes']);
  });

  test('Given_MixedCheckboxesAndFencedCheckbox_When_GetSteps_Then_FencedIgnoredAndIndexedCorrectly', () => {
    const item = parseItem(ITEM, 'ABC-123');


    const steps = getSteps(item);


    assert.deepEqual(steps.map(({ index, text, done }) => ({ index, text, done })), [
      { index: 0, text: 'First done', done: true },
      { index: 1, text: 'Second open', done: false },
      { index: 2, text: 'Third done', done: true },
      { index: 3, text: 'Fourth open', done: false },
    ]);
  });

  test('Given_Index1_When_SetStepDone_Then_OnlyThatLineChanges', () => {
    const item = parseItem(ITEM, 'ABC-123');


    setStepDone(item, 1, true);
    const out = serializeItem(item);


    assert.equal(out, ITEM.replace('- [ ] Second open', '- [x] Second open'));
  });

  test('Given_OutOfRangeIndex_When_SetStepDone_Then_Throws', () => {
    const item = parseItem(ITEM, 'ABC-123');


    assert.throws(() => setStepDone(item, 9, true), RangeError);
  });

  test('Given_MissingLogSection_When_AppendLog_Then_CreatedInCanonicalOrder', () => {
    const item = parseItem(ITEM, 'ABC-123');


    appendLog(item, 'did a thing', new Date('2026-02-03T10:00:00Z'));


    assert.deepEqual(item.sections.map((s) => s.heading), [null, 'Summary', 'Custom', 'Next steps', 'Notes', 'Log']);
    assert.equal(getSection(item, 'Log'), '- 2026-02-03: did a thing');
    assert.ok(serializeItem(item).endsWith('Some notes.\n\n## Log\n- 2026-02-03: did a thing\n'));
  });

  test('Given_MissingBlockersSection_When_SetSection_Then_InsertedBeforeLaterKnownSection', () => {
    const item = parseItem(ITEM, 'ABC-123');


    setSection(item, 'Blockers', 'Waiting for access');


    assert.deepEqual(item.sections.map((s) => s.heading), [null, 'Summary', 'Custom', 'Next steps', 'Blockers', 'Notes']);
    assert.ok(serializeItem(item).includes('- [ ] Fourth open\n\n## Blockers\nWaiting for access\n\n## Notes\n'));
  });

  test('Given_JiraBaseAndIssueKey_When_ToApiItem_Then_JiraUrlSet', () => {
    const item = parseItem(ITEM, 'ABC-123');


    const api = toApiItem(item, 'abcdef0123456789', { jiraBaseUrl: 'https://example.atlassian.net' });


    assert.equal(api.jiraUrl, 'https://example.atlassian.net/browse/ABC-123');
    assert.equal(api.summary, 'Short summary.');
    assert.equal(api.steps.length, 4);
    assert.equal(api.rev, 'abcdef0123456789');
  });

  test('Given_NoJiraBase_When_ToApiItem_Then_JiraUrlNull', () => {
    const item = parseItem(ITEM, 'ABC-123');


    const api = toApiItem(item, 'r', {});


    assert.equal(api.jiraUrl, null);
  });

  test('Given_SlugKeyWithJiraBase_When_ToApiItem_Then_JiraUrlNull', () => {
    const item = parseItem(ITEM, 'cleanup-build-scripts');


    const api = toApiItem(item, 'r', { jiraBaseUrl: 'https://example.atlassian.net' });


    assert.equal(api.jiraUrl, null);
  });

  test('Given_SessionsWithUnsafeLastId_When_ToApiItem_Then_LastSessionIdNull', () => {
    const item = parseItem('---\nsessions:\n  - id: good-id-1\n  - id: "bad id; rm"\n---\n', 'ABC-123');


    const api = toApiItem(item, 'r', {});


    assert.equal(api.lastSessionId, null);
    assert.equal(api.sessions.length, 2);
  });

  test('Given_KnownFieldInUnsupportedFormat_When_ToApiItem_Then_NullWithParseWarning', () => {
    const item = parseItem('---\ntitle: |\n  multi\n  line\n---\n', 'ABC-123');


    const api = toApiItem(item, 'r', {});


    assert.equal(api.title, '');
    assert.equal(api.parseWarnings.length, 1);
  });

  test('Given_SessionRecordsWithThreadFields_When_RoundTripped_Then_ByteIdenticalAndValuesParsed', () => {
    const text = [
      '---',
      'key: ABC-123',
      'sessions:',
      '  - id: s1',
      '    parentId:',
      '    cwd: C:\\src\\app',
      '    note: "Fix: lock contention #2"',
      '    open: false',
      '  - id: s2',
      '    parentId: s1',
      '    note: Writing tests',
      '    open: true',
      '---',
      '',
    ].join('\n');
    const item = parseItem(text, 'ABC-123');


    const out = serializeItem(item);
    item.data.sessions[1].note = 'Tests: half done # flaky';
    item.data.sessions.push({ id: 's3', parentId: 's2', note: null, open: true });
    const back = parseItem(serializeItem(item), 'ABC-123');


    assert.equal(out, text);
    assert.deepEqual(item.data.sessions[0], { id: 's1', parentId: null, cwd: 'C:\\src\\app', note: 'Fix: lock contention #2', open: false });
    assert.deepEqual(back.data.sessions, item.data.sessions);
  });

  test('Given_TooManyUntrackedOrClosed_When_CapSessions_Then_OldestOfThoseDroppedAndOpenKept', () => {
    const sessions = [
      { id: 'a', open: true },
      { id: 'b', open: false },
      { id: 'c' },
      { id: 'd', open: false },
      { id: 'e' },
    ];


    const capped = capSessions(sessions, { maxOther: 2, maxTotal: 50 });


    assert.deepEqual(capped.map((s) => s.id), ['a', 'd', 'e']);
  });

  test('Given_ManyOpenThreadsBelowCeiling_When_CapSessions_Then_NoneDropped', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, open: true }));


    const capped = capSessions(sessions, { maxOther: 1, maxTotal: 50 });


    assert.equal(capped.length, 5);
  });

  test('Given_MoreThanHardCeiling_When_CapSessions_Then_OldestDroppedToCeiling', () => {
    const sessions = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, open: true }));


    const capped = capSessions(sessions);


    assert.equal(capped.length, 50);
    assert.equal(capped[0].id, 's10');
  });

  test('Given_NestedForks_When_BuildSessionTree_Then_ChildrenNestedUnderParents', () => {
    const sessions = normalizeSessions([
      { id: 'root' },
      { id: 'fork-a', parentId: 'root' },
      { id: 'fork-a-1', parentId: 'fork-a', open: false },
      { id: 'fork-b', parentId: 'root', note: 'b' },
    ]);


    const tree = buildSessionTree(sessions);


    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, 'root');
    assert.deepEqual(tree[0].children.map((c) => c.id), ['fork-a', 'fork-b']);
    assert.deepEqual(tree[0].children[0].children.map((c) => c.id), ['fork-a-1']);
    assert.equal(tree[0].children[0].children[0].open, false);
    assert.equal(tree[0].children[1].note, 'b');
  });

  test('Given_ParentNotInItem_When_BuildSessionTree_Then_SessionIsRoot', () => {
    const sessions = normalizeSessions([{ id: 'x', parentId: 'elsewhere' }, { id: 'y', parentId: 'x' }, { id: 'z' }]);


    const tree = buildSessionTree(sessions);


    assert.deepEqual(tree.map((n) => n.id), ['x', 'z']);
    assert.deepEqual(tree[0].children.map((n) => n.id), ['y']);
  });

  test('Given_ParentCycle_When_BuildSessionTree_Then_EveryNodeAppearsOnce', () => {
    const sessions = normalizeSessions([{ id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }]);


    const tree = buildSessionTree(sessions);
    const ids = [];
    const walk = (n) => { ids.push(n.id); n.children.forEach(walk); };
    tree.forEach(walk);


    assert.deepEqual(ids.sort(), ['p', 'q']);
  });

  test('Given_SessionsWithThreadFields_When_ToApiItem_Then_SessionsTreeAndOpenCountExposed', () => {
    const item = parseItem('---\nsessions:\n  - id: a\n    note: first\n  - id: b\n    parentId: a\n    open: false\n  - id: c\n    parentId: a\n    open: true\n---\n', 'ABC-123');


    const api = toApiItem(item, 'r', {});


    assert.deepEqual(api.sessions[0], { id: 'a', parentId: null, cwd: null, branch: null, endedAt: null, note: 'first', open: null });
    assert.equal(api.openSessions, 1);
    assert.equal(api.sessionTree.length, 1);
    assert.deepEqual(api.sessionTree[0].children.map((n) => [n.id, n.open]), [['b', false], ['c', true]]);
  });

  test('Given_UnquotedBracketNote_When_Parsed_Then_SessionsKeptAndNoteIsPlainText', () => {
    const text = "---\nkey: ABC-123\nsessions:\n  - id: s1\n    note: [WIP] refactor 'auth'\n    open: true\n  - id: s2\n    note: 'unterminated\n---\n";
    const item = parseItem(text, 'ABC-123');


    const api = toApiItem(item, 'r', {});
    const out = serializeItem(item);


    assert.equal(api.parseWarnings, undefined);
    assert.deepEqual(api.sessions.map((s) => [s.id, s.note, s.open]), [['s1', "[WIP] refactor 'auth'", true], ['s2', "'unterminated", null]]);
    assert.equal(out, text);
  });

  test('Given_ChangedSessionWithBracketNote_When_Serialized_Then_NoteQuotedAndReparses', () => {
    const item = parseItem("---\nsessions:\n  - id: s1\n    note: [WIP] refactor 'auth'\n---\n", 'ABC-123');
    item.data.sessions[0].open = false;


    const out = serializeItem(item);
    const back = parseItem(out, 'ABC-123');


    assert.ok(out.includes(`note: "[WIP] refactor 'auth'"`));
    assert.deepEqual(back.data.sessions[0], { id: 's1', note: "[WIP] refactor 'auth'", open: false });
  });

  test('Given_PrototypeKeys_When_Parsed_Then_Ignored', () => {
    const item = parseItem('---\n__proto__: x\nconstructor: y\nsessions:\n  - id: s1\n    __proto__: polluted\n    prototype: z\n---\n', 'ABC-123');


    const s = item.data.sessions[0];


    assert.equal(Object.prototype.hasOwnProperty.call(item.data, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(item.data, 'constructor'), false);
    assert.equal(Object.getPrototypeOf(s), Object.prototype);
    assert.deepEqual(Object.keys(s), ['id']);
    assert.equal({}.polluted, undefined);
  });

  test('Given_KnownTopLevelFieldUnparseable_When_ToApiItem_Then_WarningListed', () => {
    const item = parseItem('---\ntitle: [WIP] something\n---\n', 'ABC-123');


    const api = toApiItem(item, 'r', {});


    assert.equal(api.parseWarnings.length, 1);
    assert.match(api.parseWarnings[0], /title/);
  });

  test('Given_StubItem_When_Serialized_Then_ParsesBackWithAllSections', () => {
    const stub = newStubItem({ key: 'ABC-123', title: 'feature/abc-123', cwd: 'C:\\w', now: new Date('2026-01-01T00:00:00Z') });


    const back = parseItem(serializeItem(stub), 'ABC-123');


    assert.deepEqual(back.sections.filter((s) => s.heading).map((s) => s.heading), ['Summary', 'Next steps', 'Blockers', 'Notes', 'Log']);
    assert.equal(back.data.status, 'active');
    assert.equal(back.data.cwd, 'C:\\w');
    assert.equal(back.data.updated, '2026-01-01T00:00:00.000Z');
  });
});
