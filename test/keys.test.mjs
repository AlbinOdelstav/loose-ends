import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectKey, extractKey, looksLikeIssueKey, validateKey } from '../lib/keys.mjs';

describe('keys', () => {
  test('Given_FeatureBranchWithKey_When_ExtractKey_Then_ReturnsUppercasedKey', () => {
    assert.equal(extractKey('feature/abc-123-fix'), 'ABC-123');
  });

  test('Given_WorktreeDirName_When_ExtractKey_Then_ReturnsKey', () => {
    assert.equal(extractKey('claude-worktrees-abc-123'), 'ABC-123');
  });

  test('Given_FalsePositiveTokens_When_ExtractKey_Then_ReturnsNull', () => {
    for (const t of ['utf-8', 'sha-256', 'x86-64', 'a-1']) {
      assert.equal(extractKey(t), null, t);
    }
  });

  test('Given_PrefixAllowList_When_ExtractKey_Then_OnlyAllowedPrefixesMatch', () => {
    assert.equal(extractKey('abc-123', { keyPrefixes: ['XYZ'] }), null);
    assert.equal(extractKey('xyz-9', { keyPrefixes: ['XYZ'] }), 'XYZ-9');
  });

  test('Given_DeniedPrefixBeforeRealKey_When_ExtractKey_Then_ReturnsRealKey', () => {
    assert.equal(extractKey('utf-8-fix-for-abc-77'), 'ABC-77');
  });

  test('Given_InvalidKeys_When_ValidateKey_Then_Rejected', () => {
    for (const k of ['.', '..', 'a/b', '..\\x', 'CON', 'nul.txt', 'abc.', 'a'.repeat(101), '', 'a b']) {
      assert.equal(validateKey(k), false, JSON.stringify(k));
    }
  });

  test('Given_ValidSlug_When_ValidateKey_Then_Accepted', () => {
    assert.equal(validateKey('my-slug_1.2'), true);
    assert.equal(validateKey('ABC-123'), true);
  });

  test('Given_IssueKeyAndSlug_When_LooksLikeIssueKey_Then_OnlyIssueKeyMatches', () => {
    assert.equal(looksLikeIssueKey('ABC-123'), true);
    assert.equal(looksLikeIssueKey('abc-123'), false);
    assert.equal(looksLikeIssueKey('my-slug'), false);
    assert.equal(looksLikeIssueKey('UTF-8'), false);
  });

  test('Given_BranchWithoutKey_When_DetectKey_Then_FallsBackToCwdThenWorktreeName', () => {
    assert.equal(detectKey({ branch: 'main', cwd: '/src/abc-5-thing', worktreeRoot: '/src/xyz-6' }), 'ABC-5');
    assert.equal(detectKey({ branch: 'main', cwd: '/src/app/sub', worktreeRoot: '/src/xyz-6' }), 'XYZ-6');
    assert.equal(detectKey({ branch: null, cwd: '/src/app', worktreeRoot: null }), null);
  });
});
