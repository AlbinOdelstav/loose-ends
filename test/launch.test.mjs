import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildCmdStartLine, buildWtArgs, LAUNCHER_PATH, launchSession, writePromptFile } from '../lib/launch.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const TOOLS = { wt: 'C:/fake/wt.exe', cmd: 'C:/fake/cmd.exe', claude: 'C:/fake/claude.exe' };

function stubSpawn(behaviour) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    const b = behaviour(cmd);
    setImmediate(() => {
      if (b === 'ok') child.emit('spawn');
      else {
        const err = new Error(`spawn ${cmd} ENOENT`);
        err.code = 'ENOENT';
        child.emit('error', err);
      }
    });
    return child;
  };
  return { impl, calls };
}

describe('launch', () => {
  test('Given_CwdWithSemicolon_When_BuildWtArgs_Then_EscapedAndOrderedCorrectly', () => {
    const cwd = resolve(tempDir(), 'a;b');


    const args = buildWtArgs({ cwd, key: 'ABC-123', nodeExe: 'C:\\node\\node.exe', launcher: 'C:\\le\\bin\\launch-claude.mjs', promptFile: 'C:\\d\\.prompts\\p.txt' });


    assert.deepEqual(args, [
      '-w', 'new', 'new-tab', '--title', 'Loose Ends ABC-123', '-d', cwd.replace(';', '\\;'),
      'C:\\node\\node.exe', 'C:\\le\\bin\\launch-claude.mjs', 'C:\\d\\.prompts\\p.txt',
    ]);
  });

  test('Given_UnsafeCharacters_When_BuildCmdStartLine_Then_Throws', () => {
    const base = { cwd: tempDir(), key: 'ABC-123', nodeExe: 'C:\\node\\node.exe', launcher: 'C:\\le\\l.mjs', promptFile: 'C:\\d\\p.txt' };
    for (const bad of ['C:\\a&b', 'C:\\a"b', 'C:\\a%PATH%']) {
      assert.throws(() => buildCmdStartLine({ ...base, promptFile: bad }), /unsafe/, bad);
    }
    assert.throws(() => buildCmdStartLine({ ...base, cwd: resolve(base.cwd, 'x&y') }), /unsafe/);
  });

  test('Given_OrdinaryPaths_When_BuildCmdStartLine_Then_AllPartsQuoted', () => {
    const cwd = resolve(tempDir(), 'with space');


    const line = buildCmdStartLine({ cwd, key: 'ABC-123', nodeExe: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'C:\\le\\l.mjs', promptFile: 'C:\\d\\p.txt' });


    assert.equal(line, `start "Loose Ends ABC-123" /D "${cwd}" "C:\\Program Files\\nodejs\\node.exe" "C:\\le\\l.mjs" "C:\\d\\p.txt"`);
  });

  test('Given_WtMissing_When_LaunchSession_Then_FallsBackToCmd', async () => {
    const dir = tempDir();
    const cwd = tempDir();
    const { impl, calls } = stubSpawn((cmd) => (cmd === TOOLS.wt ? 'enoent' : 'ok'));


    const r = await launchSession({ cwd, key: 'ABC-123', prompt: 'Hello "world"; & %PATH%', cfg: {}, dir, spawnImpl: impl, tools: TOOLS, nodeExe: 'C:\\node\\node.exe', launcher: 'C:\\le\\l.mjs' });


    assert.equal(r.via, 'cmd');
    assert.deepEqual(calls.map((c) => c.cmd), [TOOLS.wt, TOOLS.cmd]);
    assert.ok(calls[1].args[3].endsWith(' "C:/fake/claude.exe"'));
    assert.deepEqual(calls[1].args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(calls[1].opts.windowsVerbatimArguments, true);
    assert.equal(calls[1].opts.detached, true);
    assert.ok(!calls[1].args[3].includes('world'), 'prompt text must never appear on the command line');
    assert.equal(readFileSync(r.promptFile, 'utf8'), 'Hello "world"; & %PATH%');
  });

  test('Given_WtAvailable_When_LaunchSession_Then_UsesWtDetached', async () => {
    const dir = tempDir();
    const cwd = tempDir();
    const { impl, calls } = stubSpawn(() => 'ok');


    const r = await launchSession({ cwd, key: 'ABC-123', prompt: 'p', cfg: {}, dir, spawnImpl: impl, tools: TOOLS });


    assert.equal(r.via, 'wt');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].cmd, TOOLS.wt);
    assert.deepEqual(calls[0].args.slice(-2), [r.promptFile, TOOLS.claude]);
  });

  test('Given_BothTerminalsFail_When_LaunchSession_Then_RejectsAndRemovesPromptFile', async () => {
    const dir = tempDir();
    const { impl } = stubSpawn(() => 'enoent');


    await assert.rejects(launchSession({ cwd: tempDir(), key: 'ABC-123', prompt: 'p', cfg: {}, dir, spawnImpl: impl, tools: TOOLS }));
    assert.deepEqual(readdirSync(join(dir, '.prompts')), []);
  });

  test('Given_ClaudeNotResolved_When_LaunchSession_Then_RejectsWithoutSpawning', async () => {
    const { impl, calls } = stubSpawn(() => 'ok');


    const attempt = launchSession({ cwd: tempDir(), key: 'ABC-123', prompt: 'p', cfg: {}, dir: tempDir(), spawnImpl: impl, tools: { ...TOOLS, claude: null } });


    await assert.rejects(attempt, /claude CLI not found/);
    assert.equal(calls.length, 0);
  });

  test('Given_UncCwd_When_LaunchSession_Then_RejectsWithoutSpawning', async () => {
    const { impl, calls } = stubSpawn(() => 'ok');


    const attempt = launchSession({ cwd: '\\\\attacker.invalid\\share', key: 'ABC-123', prompt: 'p', cfg: {}, dir: tempDir(), spawnImpl: impl, tools: TOOLS });


    await assert.rejects(attempt, /local directory/);
    assert.equal(calls.length, 0);
  });

  test('Given_WtNotResolved_When_LaunchSession_Then_GoesStraightToCmd', async () => {
    const { impl, calls } = stubSpawn(() => 'ok');


    const r = await launchSession({ cwd: tempDir(), key: 'ABC-123', prompt: 'p', cfg: {}, dir: tempDir(), spawnImpl: impl, tools: { ...TOOLS, wt: null } });


    assert.equal(r.via, 'cmd');
    assert.deepEqual(calls.map((c) => c.cmd), [TOOLS.cmd]);
  });

  test('Given_MissingOrRelativeClaudePath_When_LauncherRuns_Then_Exits1AndKeepsPromptFile', () => {
    const promptFile = writePromptFile(tempDir(), 'ABC-123', 'prompt text');


    const missing = spawnSync(process.execPath, [LAUNCHER_PATH, promptFile, join(tempDir(), 'no-claude.exe')], { encoding: 'utf8', timeout: 10000 });
    const relative = spawnSync(process.execPath, [LAUNCHER_PATH, promptFile, 'claude'], { encoding: 'utf8', timeout: 10000 });


    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /claude CLI was not found/);
    assert.equal(relative.status, 1);
    assert.ok(existsSync(promptFile));
  });

  test('Given_Text_When_WritePromptFile_Then_CreatedUnderPromptsDir', () => {
    const dir = tempDir();


    const p = writePromptFile(dir, 'ABC-123', 'prompt text');


    assert.equal(dirname(p), join(dir, '.prompts'));
    assert.match(basename(p), /^ABC-123-\d+-[0-9a-f]{6}\.txt$/);
    assert.ok(existsSync(p));
    assert.equal(readFileSync(p, 'utf8'), 'prompt text');
  });
});
