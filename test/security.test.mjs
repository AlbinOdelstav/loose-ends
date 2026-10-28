import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { checkHost, checkOrigin, checkToken, HttpError, parseSteps, readJsonBody } from '../lib/security.mjs';

const req = (headers, method = 'POST') => ({ headers, method });

function fakeBodyReq(body, headers) {
  const r = Readable.from(body === null ? [] : [Buffer.from(body)]);
  r.headers = headers;
  return r;
}

describe('security', () => {
  test('Given_LocalHostHeaders_When_CheckHost_Then_Pass', () => {
    assert.equal(checkHost(req({ host: '127.0.0.1:4477' }), 4477), true);
    assert.equal(checkHost(req({ host: 'localhost:4477' }), 4477), true);
  });

  test('Given_ForeignOrWrongPortOrMissingHost_When_CheckHost_Then_Fail', () => {
    assert.equal(checkHost(req({ host: 'evil.com:4477' }), 4477), false);
    assert.equal(checkHost(req({ host: '127.0.0.1:80' }), 4477), false);
    assert.equal(checkHost(req({ host: '127.0.0.1' }), 4477), false);
    assert.equal(checkHost(req({}), 4477), false);
  });

  test('Given_LocalOrMissingOrigin_When_CheckOrigin_Then_Pass', () => {
    assert.equal(checkOrigin(req({ origin: 'http://localhost:4477' }), 4477), true);
    assert.equal(checkOrigin(req({ origin: 'http://127.0.0.1:4477' }), 4477), true);
    assert.equal(checkOrigin(req({}), 4477), true);
    assert.equal(checkOrigin(req({ 'sec-fetch-site': 'same-origin' }), 4477), true);
  });

  test('Given_ForeignOrNullOrigin_When_CheckOrigin_Then_Fail', () => {
    assert.equal(checkOrigin(req({ origin: 'http://evil.com' }), 4477), false);
    assert.equal(checkOrigin(req({ origin: 'null' }), 4477), false);
    assert.equal(checkOrigin(req({ origin: 'http://localhost:4478' }), 4477), false);
    assert.equal(checkOrigin(req({ 'sec-fetch-site': 'cross-site' }), 4477), false);
  });

  test('Given_CrossSiteNavigationToBoardPage_When_CheckOrigin_Then_Pass', () => {
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };


    const ok = checkOrigin({ headers: nav, method: 'GET', url: '/' }, 4477);


    assert.equal(ok, true);
  });

  test('Given_CrossSiteNavigationToOtherPathOrMethod_When_CheckOrigin_Then_Fail', () => {
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };


    const results = [
      checkOrigin({ headers: nav, method: 'GET', url: '/api/items' }, 4477),
      checkOrigin({ headers: nav, method: 'GET', url: '/app.js' }, 4477),
      checkOrigin({ headers: nav, method: 'POST', url: '/' }, 4477),
      checkOrigin({ headers: nav, method: 'HEAD', url: '/' }, 4477),
    ];


    assert.deepEqual(results, [false, false, false, false]);
  });

  test('Given_CorrectToken_When_CheckToken_Then_Pass', () => {
    assert.equal(checkToken(req({ 'x-loose-ends-token': 'secret-token' }), 'secret-token'), true);
  });

  test('Given_WrongLengthWrongValueOrMissingToken_When_CheckToken_Then_Fail', () => {
    assert.equal(checkToken(req({ 'x-loose-ends-token': 'short' }), 'secret-token'), false);
    assert.equal(checkToken(req({ 'x-loose-ends-token': 'secret-tokeX' }), 'secret-token'), false);
    assert.equal(checkToken(req({}), 'secret-token'), false);
  });

  test('Given_ValidSteps_When_ParseSteps_Then_ReturnsIndices', () => {
    assert.deepEqual(parseSteps([2, 0], 3), [2, 0]);
    assert.deepEqual(parseSteps('0,2', 3), [0, 2]);
    assert.deepEqual(parseSteps('', 3), []);
  });

  test('Given_InvalidSteps_When_ParseSteps_Then_Throws400', () => {
    const is400 = (err) => err instanceof HttpError && err.status === 400;
    const bad = [[1, 1], [-1], [3], [1.5], ['1'], '1,,2', '-1', 'a', null, { 0: 1 }];
    for (const input of bad) {
      assert.throws(() => parseSteps(input, 3), is400, JSON.stringify(input));
    }
    assert.throws(() => parseSteps(Array.from({ length: 201 }, (_, i) => i), 300), is400);
  });

  test('Given_NonJsonContentType_When_ReadJsonBody_Then_Rejects415', async () => {
    await assert.rejects(readJsonBody(fakeBodyReq('{}', { 'content-type': 'text/plain' })), (e) => e.status === 415);
  });

  test('Given_OversizedBody_When_ReadJsonBody_Then_Rejects413', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(20000) });
    await assert.rejects(readJsonBody(fakeBodyReq(big, { 'content-type': 'application/json' })), (e) => e.status === 413);
    await assert.rejects(readJsonBody(fakeBodyReq('{}', { 'content-type': 'application/json', 'content-length': '999999' })), (e) => e.status === 413);
  });

  test('Given_InvalidJsonOrNonObject_When_ReadJsonBody_Then_Rejects400', async () => {
    await assert.rejects(readJsonBody(fakeBodyReq('{bad', { 'content-type': 'application/json' })), (e) => e.status === 400);
    await assert.rejects(readJsonBody(fakeBodyReq('[1,2]', { 'content-type': 'application/json' })), (e) => e.status === 400);
  });

  test('Given_ValidJsonObject_When_ReadJsonBody_Then_Resolves', async () => {
    const body = await readJsonBody(fakeBodyReq('{"rev":"x"}', { 'content-type': 'application/json; charset=utf-8' }));
    assert.deepEqual(body, { rev: 'x' });
  });
});
