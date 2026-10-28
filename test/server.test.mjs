import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { readItem } from '../lib/store.mjs';
import { createServer } from '../server.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const TOKEN = 'test-token-0123456789';

function itemText(cwd) {
  return [
    '---',
    'key: ABC-123',
    'title: Fix login',
    'status: active',
    `cwd: ${cwd}`,
    'branch: feature/abc-123',
    '---',
    '',
    '## Summary',
    'Summary text.',
    '',
    '## Next steps',
    '- [ ] Step zero',
    '- [x] Step one',
    '- [ ] Step two',
    '',
  ].join('\n');
}

let ctx;

function openSse() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Host: `127.0.0.1:${ctx.port}` }, agent: false }, (res) => {
      res.once('data', () => resolve(req));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start({ platform = 'win32', launchImpl, live: liveOverride, maxLiveProcs, maxSseClients } = {}) {
  const dir = tempDir();
  const cwd = tempDir();
  writeFileSync(join(dir, 'ABC-123.md'), itemText(cwd));
  const launches = [];
  const launch = launchImpl ?? (async (args) => { launches.push(args); return { via: 'wt' }; });
  const live = liveOverride ?? {
    liveGit: async () => ({ ok: true, branch: 'feature/abc-123', ahead: 1, behind: 0, dirty: 2, upstream: 'origin/feature/abc-123' }),
    livePr: async () => ({ ok: true, number: 7, url: 'https://example.com/pr/7', state: 'OPEN', isDraft: false, reviewDecision: null, checks: { pass: 1, fail: 0, pending: 0, total: 1 } }),
  };
  const server = createServer({
    dir,
    port: 0,
    cfg: { jiraBaseUrl: null, port: 0, terminal: 'wt', keyPrefixes: [], ghHosts: [] },
    token: TOKEN,
    launch,
    live,
    platform,
    tools: { git: null, gh: null, claude: null, wt: null, cmd: null }, // never resolve real binaries in tests
    ...(maxLiveProcs ? { maxLiveProcs } : {}),
    ...(maxSseClients ? { maxSseClients } : {}),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, dir, cwd, launches };
}

function request(method, path, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${ctx.port}`, ...headers };
    let payload = null;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: ctx.port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const mutHeaders = (extra = {}) => ({ 'X-Loose-Ends-Token': TOKEN, 'Content-Type': 'application/json', ...extra });

function addSessions() {
  const p = join(ctx.dir, 'ABC-123.md');
  const text = readFileSync(p, 'utf8').replace('branch: feature/abc-123\n', [
    'branch: feature/abc-123',
    'sessions:',
    '  - id: root-1',
    '    note: Main work',
    '  - id: fork-1',
    '    parentId: root-1',
    '    open: true',
    '',
  ].join('\n'));
  writeFileSync(p, text);
}

async function currentRev() {
  return (await request('GET', '/api/items/ABC-123')).json.rev;
}

describe('server', () => {
  beforeEach(async () => { ctx = await start(); });
  afterEach(async () => { await new Promise((r) => ctx.server.close(r)); });

  test('Given_ForeignHost_When_Requested_Then_403', async () => {
    const r = await request('GET', '/api/items', { host: 'evil.com:4477' });


    assert.equal(r.status, 403);
  });

  test('Given_MissingToken_When_Patched_Then_403', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: { 'Content-Type': 'application/json' }, body: { rev: await currentRev(), status: 'parked' } });


    assert.equal(r.status, 403);
  });

  test('Given_ForeignOrigin_When_Patched_Then_403', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders({ Origin: 'http://evil.com' }), body: { rev: await currentRev(), status: 'parked' } });


    assert.equal(r.status, 403);
  });

  test('Given_NonJsonContentType_When_Patched_Then_415', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders({ 'Content-Type': 'text/plain' }), body: '{}' });


    assert.equal(r.status, 415);
  });

  test('Given_OversizedBody_When_Patched_Then_413', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders(), body: { rev: 'x', waitingOn: 'a'.repeat(20000) } });


    assert.equal(r.status, 413);
  });

  test('Given_TraversalKey_When_Requested_Then_400', async () => {
    const r = await request('GET', '/api/items/..%2F..');


    assert.equal(r.status, 400);
  });

  test('Given_MissingItem_When_Requested_Then_404', async () => {
    const r = await request('GET', '/api/items/XYZ-9');


    assert.equal(r.status, 404);
  });

  test('Given_UnsupportedMethod_When_Requested_Then_405', async () => {
    const r = await request('DELETE', '/api/items/ABC-123');


    assert.equal(r.status, 405);
  });

  test('Given_Items_When_Listed_Then_ApiItemsReturned', async () => {
    const r = await request('GET', '/api/items');


    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].key, 'ABC-123');
    assert.deepEqual(r.json.items[0].steps.map((s) => s.done), [false, true, false]);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  test('Given_StatusChange_When_Patched_Then_FileWrittenAndNewRevReturned', async () => {
    const rev = await currentRev();


    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders(), body: { rev, status: 'waiting', waitingOn: 'Review\nfrom team' } });


    assert.equal(r.status, 200);
    assert.notEqual(r.json.rev, rev);
    assert.equal(r.json.status, 'waiting');
    assert.equal(r.json.waitingOn, 'Review from team');
    assert.equal(readItem('ABC-123', ctx.dir).rev, r.json.rev);
    assert.ok(readFileSync(join(ctx.dir, 'ABC-123.md'), 'utf8').includes('status: waiting'));
  });

  test('Given_StatusDone_When_Patched_Then_ArchivedLogLineAppended', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders(), body: { rev: await currentRev(), status: 'done' } });


    assert.equal(r.status, 200);
    assert.match(r.json.log, /archived from board/);
  });

  test('Given_InvalidStatus_When_Patched_Then_400', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders(), body: { rev: await currentRev(), status: 'bogus' } });


    assert.equal(r.status, 400);
  });

  test('Given_StaleRev_When_Patched_Then_409WithCurrentItem', async () => {
    const r = await request('PATCH', '/api/items/ABC-123', { headers: mutHeaders(), body: { rev: '0000000000000000', status: 'parked' } });


    assert.equal(r.status, 409);
    assert.equal(r.json.item.key, 'ABC-123');
  });

  test('Given_StepIndex_When_PutDone_Then_CheckboxUpdated', async () => {
    const r = await request('PUT', '/api/items/ABC-123/steps/2', { headers: mutHeaders(), body: { rev: await currentRev(), done: true } });


    assert.equal(r.status, 200);
    assert.equal(r.json.steps[2].done, true);
    assert.ok(readFileSync(join(ctx.dir, 'ABC-123.md'), 'utf8').includes('- [x] Step two'));
  });

  test('Given_OutOfRangeStep_When_PutDone_Then_400', async () => {
    const r = await request('PUT', '/api/items/ABC-123/steps/9', { headers: mutHeaders(), body: { rev: await currentRev(), done: true } });


    assert.equal(r.status, 400);
  });

  test('Given_SelectedSteps_When_Started_Then_StubLaunchedWithCwdAndPromptAnd202', async () => {
    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [2] } });


    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { via: 'wt' });
    assert.equal(ctx.launches.length, 1);
    assert.equal(ctx.launches[0].cwd, ctx.cwd);
    assert.equal(ctx.launches[0].key, 'ABC-123');
    assert.match(ctx.launches[0].prompt, /Do these steps, in this order:\n1\. Step two/);
    assert.match(ctx.launches[0].prompt, /Skip — do NOT do these[^\n]*\n- Step zero/);
  });

  test('Given_DoneStepSelected_When_Started_Then_400', async () => {
    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [1] } });


    assert.equal(r.status, 400);
    assert.equal(ctx.launches.length, 0);
  });

  test('Given_MissingCwd_When_Started_Then_422', async () => {
    const text = readFileSync(join(ctx.dir, 'ABC-123.md'), 'utf8').replace(/^cwd: .*$/m, `cwd: ${join(ctx.cwd, 'does-not-exist')}`);
    writeFileSync(join(ctx.dir, 'ABC-123.md'), text);


    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [0] } });


    assert.equal(r.status, 422);
    assert.equal(ctx.launches.length, 0);
  });

  test('Given_LaunchFails_When_Started_Then_500', async () => {
    await new Promise((r) => ctx.server.close(r));
    ctx = await start({ launchImpl: async () => { throw new Error('boom'); } });


    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [] } });


    assert.equal(r.status, 500);
    assert.match(r.json.error, /boom/);
  });

  test('Given_SelectedSteps_When_PromptRequested_Then_PromptReturned', async () => {
    const r = await request('GET', '/api/items/ABC-123/prompt?steps=0,2');


    assert.equal(r.status, 200);
    assert.match(r.json.prompt, /1\. Step zero\n2\. Step two/);
    assert.match(r.json.prompt, /\/checkpoint ABC-123/);
  });

  test('Given_BadSteps_When_PromptRequested_Then_400', async () => {
    const r = await request('GET', '/api/items/ABC-123/prompt?steps=0,0');


    assert.equal(r.status, 400);
  });

  test('Given_Item_When_LiveRequested_Then_StubFactsReturned', async () => {
    const r = await request('GET', '/api/items/ABC-123/live');


    assert.equal(r.status, 200);
    assert.equal(r.json.git.dirty, 2);
    assert.equal(r.json.pr.number, 7);
  });

  test('Given_Index_When_Requested_Then_TokenInjectedAndCspHeaderSet', async () => {
    const r = await request('GET', '/');


    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`<meta name="le-token" content="${TOKEN}">`));
    assert.match(r.headers['content-security-policy'], /script-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  });

  test('Given_UnknownStaticPath_When_Requested_Then_404', async () => {
    const r = await request('GET', '/../server.mjs');
    const r2 = await request('GET', '/index.html');


    assert.equal(r.status, 404);
    assert.equal(r2.status, 404);
  });

  test('Given_ValidSessionPatch_When_Patched_Then_NoteAndOpenWritten', async () => {
    addSessions();


    const r = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: mutHeaders(), body: { rev: await currentRev(), open: false, note: 'Tests\n  written, waiting for CI' } });


    assert.equal(r.status, 200);
    const s = r.json.sessions.find((x) => x.id === 'fork-1');
    assert.equal(s.open, false);
    assert.equal(s.note, 'Tests written, waiting for CI');
    assert.deepEqual(r.json.sessionTree[0].children.map((n) => n.id), ['fork-1']);
    const fromDisk = readItem('ABC-123', ctx.dir).item.data.sessions.find((x) => x.id === 'fork-1');
    assert.equal(fromDisk.open, false);
    assert.equal(fromDisk.note, 'Tests written, waiting for CI');
  });

  test('Given_MissingToken_When_SessionPatched_Then_403', async () => {
    addSessions();


    const r = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: { 'Content-Type': 'application/json' }, body: { rev: await currentRev(), open: false } });


    assert.equal(r.status, 403);
  });

  test('Given_InvalidSessionPatchInput_When_Patched_Then_400', async () => {
    addSessions();
    const rev = await currentRev();


    const badId = await request('PATCH', '/api/items/ABC-123/sessions/bad%20id', { headers: mutHeaders(), body: { rev, open: false } });
    const longNote = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: mutHeaders(), body: { rev, note: 'n'.repeat(301) } });
    const badOpen = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: mutHeaders(), body: { rev, open: 'no' } });
    const nothing = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: mutHeaders(), body: { rev } });


    assert.deepEqual([badId.status, longNote.status, badOpen.status, nothing.status], [400, 400, 400, 400]);
  });

  test('Given_UnknownSession_When_Patched_Then_404', async () => {
    addSessions();


    const r = await request('PATCH', '/api/items/ABC-123/sessions/nope-1', { headers: mutHeaders(), body: { rev: await currentRev(), open: false } });


    assert.equal(r.status, 404);
  });

  test('Given_StaleRev_When_SessionPatched_Then_409', async () => {
    addSessions();


    const r = await request('PATCH', '/api/items/ABC-123/sessions/fork-1', { headers: mutHeaders(), body: { rev: '0000000000000000', open: false } });


    assert.equal(r.status, 409);
  });

  test('Given_WrongMethod_When_SessionRouteRequested_Then_405', async () => {
    addSessions();


    const r = await request('GET', '/api/items/ABC-123/sessions/fork-1');


    assert.equal(r.status, 405);
  });

  test('Given_OpenThreads_When_Started_Then_PromptMentionsThem', async () => {
    addSessions();


    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [0] } });


    assert.equal(r.status, 202);
    assert.match(ctx.launches[0].prompt, /Other open threads on this item[^\n]*\n- fork-1: \(no note\)\n/);
    assert.equal(ctx.launches[0].prompt.includes('Main work'), false, 'untracked sessions are not threads');
  });

  test('Given_UncCwd_When_LiveRequested_Then_GitAndGhNeverCalled', async () => {
    await new Promise((r) => ctx.server.close(r));
    const calls = [];
    ctx = await start({ live: { liveGit: async () => { calls.push('git'); return {}; }, livePr: async () => { calls.push('gh'); return {}; } } });
    const p = join(ctx.dir, 'ABC-123.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^cwd: .*$/m, 'cwd: \\\\attacker.invalid\\share\\repo'));


    const r = await request('GET', '/api/items/ABC-123/live');


    assert.equal(r.status, 200);
    assert.equal(r.json.git.ok, false);
    assert.equal(r.json.pr, null);
    assert.deepEqual(calls, []);
  });

  test('Given_UncCwd_When_Started_Then_422AndNoLaunch', async () => {
    const p = join(ctx.dir, 'ABC-123.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^cwd: .*$/m, 'cwd: //attacker.invalid/share/repo'));


    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [0] } });


    assert.equal(r.status, 422);
    assert.equal(ctx.launches.length, 0);
  });

  test('Given_DisallowedPrUrl_When_LiveRequested_Then_BranchUsedInstead', async () => {
    await new Promise((r) => ctx.server.close(r));
    const refs = [];
    ctx = await start({ live: { liveGit: async () => ({ ok: true, branch: 'feature/abc-123', ahead: 0, behind: 0, dirty: 0, upstream: null }), livePr: async (cwd, ref) => { refs.push(ref); return { ok: true }; } } });
    const p = join(ctx.dir, 'ABC-123.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('branch: feature/abc-123\n', 'branch: feature/abc-123\npr: https://evil.example.net/x/pull/1\n'));


    await request('GET', '/api/items/ABC-123/live');


    assert.deepEqual(refs, ['feature/abc-123']);
  });

  test('Given_ManyConcurrentLiveRequests_When_Served_Then_ChildProcessesCapped', async () => {
    await new Promise((r) => ctx.server.close(r));
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { ok: false, error: 'stub' };
    };
    ctx = await start({ live: { liveGit: slow, livePr: slow }, maxLiveProcs: 2 });


    const results = await Promise.all(Array.from({ length: 6 }, () => request('GET', '/api/items/ABC-123/live?refresh=1')));


    assert.ok(results.every((r) => r.status === 200));
    assert.ok(peak <= 2, `peak concurrency ${peak}`);
    assert.ok(peak >= 1);
  });

  test('Given_TooManySseClients_When_Connecting_Then_503', async () => {
    await new Promise((r) => ctx.server.close(r));
    ctx = await start({ maxSseClients: 1 });
    const first = await openSse();


    const second = await request('GET', '/api/events');


    first.destroy();
    assert.equal(second.status, 503);
  });

  test('Given_Server_When_Created_Then_MaxConnectionsLimited', () => {
    assert.equal(ctx.server.maxConnections, 64);
  });

  test('Given_ItemFileOverOneMegabyte_When_Listed_Then_ParseErrorAndGet422', async () => {
    writeFileSync(join(ctx.dir, 'XYZ-9.md'), '---\ntitle: big\n---\n' + 'x'.repeat(1024 * 1024 + 10));


    const list = await request('GET', '/api/items');
    const one = await request('GET', '/api/items/XYZ-9');


    const big = list.json.items.find((i) => i.key === 'XYZ-9');
    assert.equal(big.parseError, 'file too large');
    assert.equal(one.status, 422);
  });

  test('Given_WatcherFails_When_SseConnected_Then_WarningEventSent', async () => {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Host: `127.0.0.1:${ctx.port}` }, agent: false }, (res) => {
        let buf = '';
        const timer = setTimeout(() => { req.destroy(); reject(new Error('no warning event')); }, 3000);
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes(': connected') && !res.fired) {
            res.fired = true;
            ctx.server.simulateWatchError(Object.assign(new Error('gone'), { code: 'ENOENT' }));
          }
          if (buf.includes('event: warning')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', () => {});
      req.end();
    });


    assert.match(received, /event: warning\ndata: \{"message":"Not watching the data folder \(ENOENT\)/);
  });

  test('Given_SseClient_When_ItemFileWritten_Then_ChangedEventReceived', async () => {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Host: `127.0.0.1:${ctx.port}` }, agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        const timer = setTimeout(() => { req.destroy(); reject(new Error('no changed event within 5s')); }, 5000);
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes(': connected') && !res.wrote) {
            res.wrote = true;
            writeFileSync(join(ctx.dir, 'XYZ-9.md'), '---\ntitle: new\n---\n');
          }
          if (buf.includes('event: changed')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', () => {});
      req.end();
    });


    assert.match(received, /event: changed\ndata: \{\}/);
  });
});

describe('server on non-Windows platform', () => {
  beforeEach(async () => { ctx = await start({ platform: 'linux' }); });
  afterEach(async () => { await new Promise((r) => ctx.server.close(r)); });

  test('Given_LinuxPlatform_When_Started_Then_501', async () => {
    const r = await request('POST', '/api/items/ABC-123/start', { headers: mutHeaders(), body: { rev: await currentRev(), steps: [0] } });


    assert.equal(r.status, 501);
    assert.equal(ctx.launches.length, 0);
  });

  test('Given_LinuxPlatform_When_ConfigRequested_Then_CanStartFalse', async () => {
    const r = await request('GET', '/api/config');


    assert.equal(r.status, 200);
    assert.equal(r.json.canStart, false);
    assert.equal(r.json.platform, 'linux');
  });
});
