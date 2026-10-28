import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { livePr, normalizePrRef, summarizeChecks } from '../lib/gh.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

describe('gh PR references', () => {
  test('Given_NumbersAndBranches_When_Normalized_Then_Accepted', () => {
    const results = [42, '42', '#42', 'feature/abc-123-fix', 'main'].map((r) => normalizePrRef(r));


    assert.deepEqual(results, ['42', '42', '42', 'feature/abc-123-fix', 'main']);
  });

  test('Given_GithubHttpsUrl_When_Normalized_Then_Accepted', () => {
    const r = normalizePrRef('https://github.com/example/app/pull/42');


    assert.equal(r, 'https://github.com/example/app/pull/42');
  });

  test('Given_ConfiguredEnterpriseHost_When_Normalized_Then_OnlyThatHostAccepted', () => {
    const opts = { ghHosts: ['github.example.com'] };


    const allowed = normalizePrRef('https://github.example.com/team/app/pull/7', opts);
    const other = normalizePrRef('https://evil.example.net/team/app/pull/7', opts);


    assert.equal(allowed, 'https://github.example.com/team/app/pull/7');
    assert.equal(other, null);
  });

  test('Given_UnsafeReferences_When_Normalized_Then_Rejected', () => {
    const bad = [
      '--repo=evil/x', '-R', 'http://github.com/example/app/pull/1', 'https://evil.example.net/pull/1',
      'https://user:pw@github.com/x/y/pull/1', 'https://github.com:8443/x/y/pull/1', 'file:///C:/x',
      'feature branch', 'a..b', '', null, undefined, 0, -3, 1.5, '\\\\server\\share',
    ];


    const results = bad.map((r) => normalizePrRef(r));


    assert.deepEqual(results, bad.map(() => null));
  });

  test('Given_RejectedReference_When_LivePr_Then_FailsSoftWithoutSpawning', async () => {
    let spawned = false;


    const r = await livePr(tempDir(), 'https://evil.example.net/x/pull/1', { ghPath: 'C:/tools/gh.exe', execFileImpl: () => { spawned = true; } });


    assert.equal(r.ok, false);
    assert.equal(spawned, false);
  });

  test('Given_ValidReference_When_LivePr_Then_SpawnsResolvedGhAndMapsChecks', async () => {
    const calls = [];
    const out = JSON.stringify({ number: 7, url: 'https://github.com/x/y/pull/7', state: 'OPEN', isDraft: false, reviewDecision: '', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'PENDING' }, { conclusion: 'FAILURE' }] });
    const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args }); cb(null, out); };


    const r = await livePr(tempDir(), '#7', { ghPath: 'C:/tools/gh.exe', execFileImpl });


    assert.equal(calls[0].file, 'C:/tools/gh.exe');
    assert.equal(calls[0].args[2], '7');
    assert.equal(r.number, 7);
    assert.deepEqual(r.checks, { pass: 1, fail: 1, pending: 1, total: 3 });
    assert.deepEqual(summarizeChecks(null), { pass: 0, fail: 0, pending: 0, total: 0 });
  });
});
