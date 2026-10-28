import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { liveGit, gitStatusArgs, readGitInfo } from '../lib/git.mjs';
import { isExistingAbsDir, isSafeLocalPath } from '../lib/paths.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

describe('local path checks', () => {
  test('Given_DriveLetterPaths_When_IsSafeLocalPathOnWindows_Then_Accepted', () => {
    const results = ['C:\\src\\app', 'd:/work', 'C:\\'].map((p) => isSafeLocalPath(p, 'win32'));


    assert.deepEqual(results, [true, true, true]);
  });

  test('Given_UncDeviceOrRelativePaths_When_IsSafeLocalPathOnWindows_Then_Rejected', () => {
    const bad = ['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'relative\\dir', '\\rooted-no-drive', 'C:relative', '', null, 'C:\\a\0b'];


    const results = bad.map((p) => isSafeLocalPath(p, 'win32'));


    assert.deepEqual(results, bad.map(() => false));
  });

  test('Given_PosixPaths_When_IsSafeLocalPathOnLinux_Then_OnlyAbsoluteAccepted', () => {
    assert.equal(isSafeLocalPath('/home/x/src', 'linux'), true);
    assert.equal(isSafeLocalPath('src', 'linux'), false);
  });

  test('Given_UncPath_When_IsExistingAbsDir_Then_FalseWithoutTouchingIt', () => {
    assert.equal(isExistingAbsDir('\\\\attacker.invalid\\share', 'win32'), false);
  });

  test('Given_ExistingTempDir_When_IsExistingAbsDir_Then_True', () => {
    assert.equal(isExistingAbsDir(tempDir()), true);
  });
});

describe('git helpers', () => {
  test('Given_UncCwd_When_ReadGitInfo_Then_Nothing', () => {
    assert.deepEqual(readGitInfo('\\\\attacker.invalid\\share\\repo', { platform: 'win32' }), { branch: null, worktreeRoot: null, repo: null });
  });

  test('Given_GitFilePointingToUnc_When_ReadGitInfo_Then_NotFollowed', () => {
    const wt = tempDir();
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: \\\\attacker.invalid\\share\\.git\\worktrees\\x\n');


    const info = readGitInfo(join(wt, 'src'), { platform: 'win32' });


    assert.deepEqual(info, { branch: null, worktreeRoot: null, repo: null });
  });

  test('Given_Cwd_When_GitStatusArgs_Then_NoOptionalLocksAndNoFsmonitor', () => {
    const args = gitStatusArgs('C:\\src\\app');


    assert.deepEqual(args, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', 'C:\\src\\app', 'status', '--porcelain=v2', '--branch']);
  });

  test('Given_ResolvedGitPath_When_LiveGit_Then_SpawnsAbsolutePathWithSafeArgs', async () => {
    const cwd = tempDir();
    const calls = [];
    const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, '# branch.head main\n# branch.ab +2 -1\n1 .M x\n'); };


    const r = await liveGit(cwd, { gitPath: 'C:/tools/git.exe', execFileImpl });


    assert.deepEqual(r, { ok: true, branch: 'main', ahead: 2, behind: 1, dirty: 1, upstream: null });
    assert.equal(calls[0].file, 'C:/tools/git.exe');
    assert.deepEqual(calls[0].args, gitStatusArgs(cwd));
  });

  test('Given_GitNotResolved_When_LiveGit_Then_FailsSoftWithoutSpawning', async () => {
    let spawned = false;


    const r = await liveGit(tempDir(), { gitPath: null, execFileImpl: () => { spawned = true; } });


    assert.equal(r.ok, false);
    assert.match(r.error, /not found/);
    assert.equal(spawned, false);
  });
});
