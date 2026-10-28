import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { planInstall, REPO_ROOT, writeAtomicSync } from '../install.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { hookCommand, isOurHook, mergeHook, removeHook } from '../lib/settings-merge.mjs';
import { cleanupTempDirs, tempDir } from './helpers.mjs';

after(cleanupTempDirs);

const INSTALL = fileURLToPath(new URL('../install.mjs', import.meta.url));
const CMD = hookCommand('C:\\code\\loose-ends');
const SKILLS = ['checkpoint', 'pickup', 'wip'];

function runInstall(args, extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...extraEnv } });
}

function sessionEndHooks(settings) {
  return (settings.hooks?.SessionEnd ?? []).flatMap((g) => g.hooks ?? []);
}

describe('settings merge', () => {
  test('Given_RepoRoot_When_HookCommand_Then_ForwardSlashesAndMarker', () => {
    assert.equal(CMD, 'node "C:/code/loose-ends/hooks/session-end.mjs" --loose-ends-hook');
    assert.equal(isOurHook({ type: 'command', command: CMD }), true);
  });

  test('Given_EmptySettings_When_MergeHookTwice_Then_OneEntryAndSecondUnchanged', () => {
    const first = mergeHook({}, CMD);


    const second = mergeHook(first.settings, CMD);


    assert.equal(first.changed, true);
    assert.deepEqual(first.settings, { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: CMD, timeout: 5 }] }] } });
    assert.equal(second.changed, false);
    assert.deepEqual(second.settings, first.settings);
  });

  test('Given_OtherHooks_When_MergeHook_Then_Preserved', () => {
    const other = { hooks: [{ type: 'command', command: 'echo bye', shell: 'powershell' }] };
    const input = {
      model: 'x',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionEnd: [other],
      },
    };
    const snapshot = structuredClone(input);


    const r = mergeHook(input, CMD);


    assert.deepEqual(input, snapshot, 'input must not be mutated');
    assert.deepEqual(r.settings.hooks.Stop, snapshot.hooks.Stop);
    assert.deepEqual(r.settings.hooks.PreToolUse, snapshot.hooks.PreToolUse);
    assert.deepEqual(r.settings.hooks.SessionEnd[0], other);
    assert.equal(r.settings.hooks.SessionEnd.length, 2);
    assert.equal(r.settings.model, 'x');
  });

  test('Given_EntryFromRenamedRepo_When_MergeHook_Then_ReplacedNotDuplicated', () => {
    const old = hookCommand('C:\\code\\organizer-old');
    const input = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: old, timeout: 5 }] }] } };


    const r = mergeHook(input, CMD);


    assert.equal(r.changed, true);
    const ours = sessionEndHooks(r.settings).filter(isOurHook);
    assert.deepEqual(ours.map((h) => h.command), [CMD]);
    assert.equal(r.settings.hooks.SessionEnd.length, 1);
  });

  test('Given_OursAndOthers_When_RemoveHook_Then_OnlyOursRemovedAndEmptyContainersDropped', () => {
    const merged = mergeHook({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, CMD).settings;
    merged.hooks.SessionEnd.unshift({ hooks: [{ type: 'command', command: 'echo other' }, { type: 'command', command: CMD }] });


    const r = removeHook(merged);


    assert.equal(r.changed, true);
    assert.deepEqual(r.settings.hooks.SessionEnd, [{ hooks: [{ type: 'command', command: 'echo other' }] }]);
    assert.ok(r.settings.hooks.Stop);

    const onlyOurs = removeHook(mergeHook({}, CMD).settings);
    assert.deepEqual(onlyOurs.settings, {});
  });

  test('Given_WrongHooksType_When_MergeHook_Then_Throws', () => {
    assert.throws(() => mergeHook({ hooks: [] }, CMD));
    assert.throws(() => mergeHook({ hooks: { SessionEnd: {} } }, CMD));
  });
});

describe('install script (temp dirs only)', () => {
  test('Given_TempDirs_When_InstalledTwice_Then_SingleEntryAndBackupExists', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } }, null, 2));


    const r1 = runInstall(['--claude-dir', claude, '--data-dir', data]);
    const r2 = runInstall(['--claude-dir', claude, '--data-dir', data]);


    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r2.status, 0, r2.stderr);
    const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
    assert.equal(sessionEndHooks(settings).filter(isOurHook).length, 1);
    assert.equal(settings.hooks.Stop.length, 1);
    const backups = readdirSync(claude).filter((n) => n.startsWith('settings.json.loose-ends-backup-'));
    assert.equal(backups.length, 1, 'only the first (changing) run makes a backup');
    for (const s of SKILLS) {
      const text = readFileSync(join(claude, 'skills', s, 'SKILL.md'), 'utf8');
      assert.ok(text.includes('<!-- installed by loose-ends -->'));
      assert.equal(text.includes('{{REPO}}'), false);
    }
    const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    assert.equal(cfg.port, 4477);
  });

  test('Given_ExistingConfig_When_Installed_Then_ConfigNotOverwritten', () => {
    const claude = tempDir();
    const data = tempDir();
    writeFileSync(join(data, 'config.json'), '{"port":5000}');


    const r = runInstall(['--claude-dir', claude, '--data-dir', data]);


    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), '{"port":5000}');
  });

  test('Given_DryRun_When_Installed_Then_NothingWritten', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');


    const r = runInstall(['--dry-run', '--claude-dir', claude, '--data-dir', data]);


    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] writeSettings/);
    assert.match(r.stdout, /\[dry-run\] copySkill/);
    assert.deepEqual(readdirSync(claude), []);
    assert.equal(existsSync(data), false);
  });

  test('Given_InstalledAndForeignSkill_When_Uninstalled_Then_OursRemovedForeignKept', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');
    assert.equal(runInstall(['--claude-dir', claude, '--data-dir', data]).status, 0);
    writeFileSync(join(claude, 'skills', 'pickup', 'SKILL.md'), '---\nname: pickup\ndescription: someone else\n---\n');
    mkdirSync(join(claude, 'skills', 'other'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'other', 'SKILL.md'), 'mine');


    const r = runInstall(['--uninstall', '--claude-dir', claude, '--data-dir', data]);


    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(claude, 'skills', 'checkpoint')), false);
    assert.equal(existsSync(join(claude, 'skills', 'wip')), false);
    assert.equal(existsSync(join(claude, 'skills', 'pickup', 'SKILL.md')), true);
    assert.equal(existsSync(join(claude, 'skills', 'other', 'SKILL.md')), true);
    const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, {});
    assert.equal(existsSync(join(data, 'config.json')), true);
  });

  test('Given_ForeignSkillWithSameName_When_Installed_Then_BackedUpOutsideSkillsDirFirst', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');
    mkdirSync(join(claude, 'skills', 'wip'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'wip', 'SKILL.md'), 'my own wip skill');
    writeFileSync(join(claude, 'skills', 'wip', 'extra.txt'), 'extra');


    const r = runInstall(['--claude-dir', claude, '--data-dir', data]);


    assert.equal(r.status, 0, r.stderr);
    const backups = readdirSync(join(claude, 'loose-ends-skill-backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^wip\.loose-ends-backup-\d{14}$/);
    assert.equal(readFileSync(join(claude, 'loose-ends-skill-backups', backups[0], 'SKILL.md'), 'utf8'), 'my own wip skill');
    assert.equal(readFileSync(join(claude, 'loose-ends-skill-backups', backups[0], 'extra.txt'), 'utf8'), 'extra');
    assert.ok(readFileSync(join(claude, 'skills', 'wip', 'SKILL.md'), 'utf8').includes('<!-- installed by loose-ends -->'));
    assert.deepEqual(readdirSync(join(claude, 'skills')).sort(), SKILLS);
  });

  test('Given_OurSkillAlreadyInstalled_When_InstalledAgain_Then_NoSkillBackup', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');
    runInstall(['--claude-dir', claude, '--data-dir', data]);


    runInstall(['--claude-dir', claude, '--data-dir', data]);


    assert.equal(existsSync(join(claude, 'loose-ends-skill-backups')), false);
  });

  test('Given_Install_When_SkillsWritten_Then_RepoCommandQuoted', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');


    runInstall(['--claude-dir', claude, '--data-dir', data]);


    const text = readFileSync(join(claude, 'skills', 'wip', 'SKILL.md'), 'utf8');
    const repoFwd = REPO_ROOT.replace(/\\/g, '/');
    assert.ok(text.includes(`node "${repoFwd}/server.mjs"`));
  });

  test('Given_RepoPathWithShellCharacters_When_PlanInstall_Then_Throws', () => {
    for (const bad of ['C:\\code\\loose!ends', 'C:\\code\\100%', 'C:\\code\\$x', 'C:\\code\\a"b', 'C:\\code\\a`b']) {
      assert.throws(() => planInstall({ repoRoot: bad, claudeDir: tempDir(), dataDir: tempDir() }), /unsafe in shell commands/, bad);
    }
  });

  test('Given_TransientRenameErrors_When_WriteAtomicSync_Then_Retried', () => {
    const dir = tempDir();
    const target = join(dir, 'settings.json');
    let attempts = 0;
    const renameImpl = (from, to) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      renameSync(from, to);
    };


    writeAtomicSync(target, '{}\n', { renameImpl });


    assert.equal(attempts, 3);
    assert.equal(readFileSync(target, 'utf8'), '{}\n');
    assert.deepEqual(readdirSync(dir), ['settings.json']);
  });

  test('Given_PermanentRenameError_When_WriteAtomicSync_Then_ThrowsAndRemovesTemp', () => {
    const dir = tempDir();
    let attempts = 0;
    const renameImpl = () => { attempts++; throw Object.assign(new Error('nope'), { code: 'EXDEV' }); };


    assert.throws(() => writeAtomicSync(join(dir, 'x.json'), '{}', { renameImpl }), /nope/);


    assert.equal(attempts, 1);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('Given_InvalidSettingsJson_When_Installed_Then_AbortsAndFileUnchanged', () => {
    const claude = tempDir();
    const data = join(tempDir(), 'data');
    const bad = '{ "hooks": { oops ';
    writeFileSync(join(claude, 'settings.json'), bad);


    const r = runInstall(['--claude-dir', claude, '--data-dir', data]);


    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), bad);
    assert.equal(existsSync(join(claude, 'skills')), false);
  });
});
