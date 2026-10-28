import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { resolveExecutable, resolveTools, systemCmdPath } from '../lib/which.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

function binDir(files) {
  const d = tempDir();
  for (const f of files) writeFileSync(join(d, f), '');
  return d;
}

describe('executable resolver', () => {
  test('Given_ExeInPathDir_When_Resolved_Then_AbsolutePathReturned', () => {
    const bin = binDir(['git.exe']);


    const p = resolveExecutable('git', { env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, platform: 'win32', cwd: tempDir() });


    assert.equal(p, join(bin, 'git.exe'));
  });

  test('Given_PlantedBinaryInCwd_When_Resolved_Then_CwdSkipped', () => {
    const repo = binDir(['git.exe']);
    const realBin = binDir(['git.exe']);


    const p = resolveExecutable('git', { env: { PATH: `${repo};${realBin}`, PATHEXT: '.EXE' }, platform: 'win32', cwd: repo });


    assert.equal(p, join(realBin, 'git.exe'));
  });

  test('Given_RelativeAndEmptyPathEntries_When_Resolved_Then_Skipped', () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'rel'));
    writeFileSync(join(cwd, 'rel', 'gh.exe'), '');


    const p = resolveExecutable('gh', { env: { PATH: `;rel;.;`, PATHEXT: '.EXE' }, platform: 'win32', cwd });


    assert.equal(p, null);
  });

  test('Given_OnlyCmdShim_When_ResolvedWithExeOnly_Then_NotFound', () => {
    const bin = binDir(['claude.cmd']);


    const exeOnly = resolveExecutable('claude', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32', cwd: tempDir(), extensions: ['.exe'] });
    const anyExt = resolveExecutable('claude', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32', cwd: tempDir() });


    assert.equal(exeOnly, null);
    assert.equal(anyExt, join(bin, 'claude.cmd'));
  });

  test('Given_PathextOrder_When_Resolved_Then_FirstExtensionWins', () => {
    const bin = binDir(['claude.cmd', 'claude.exe']);


    const p = resolveExecutable('claude', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32', cwd: tempDir() });


    assert.equal(p, join(bin, 'claude.exe'));
  });

  test('Given_DirectoryNamedLikeExecutable_When_Resolved_Then_Ignored', () => {
    const bin = tempDir();
    mkdirSync(join(bin, 'git.exe'));


    const p = resolveExecutable('git', { env: { PATH: bin, PATHEXT: '.EXE' }, platform: 'win32', cwd: tempDir() });


    assert.equal(p, null);
  });

  test('Given_NameWithPathSeparator_When_Resolved_Then_Null', () => {
    assert.equal(resolveExecutable('..\\git', { env: { PATH: tempDir() }, platform: 'win32', cwd: tempDir() }), null);
  });

  test('Given_PosixPath_When_Resolved_Then_NoExtensionsUsed', { skip: process.platform === 'win32' && 'POSIX PATH syntax cannot express drive-letter temp dirs' }, () => {
    const bin = binDir(['gh']);


    const p = resolveExecutable('gh', { env: { PATH: `relative:${bin}` }, platform: 'linux', cwd: tempDir() });


    assert.equal(p, join(bin, 'gh'));
  });

  test('Given_EmptyPath_When_ResolveTools_Then_AllMissingButCmdFromSystemRoot', () => {
    const tools = resolveTools({ env: { PATH: '', SystemRoot: 'C:\\Windows' }, platform: 'win32', cwd: tempDir() });


    assert.deepEqual(tools, { git: null, gh: null, claude: null, wt: null, cmd: systemCmdPath({ SystemRoot: 'C:\\Windows' }) });
    assert.match(tools.cmd, /System32[\\/]cmd\.exe$/);
  });
});
