#!/usr/bin/env node
// Installs the Loose Ends skills and SessionEnd hook into Claude Code.
// Usage: node install.mjs [--uninstall] [--dry-run] [--claude-dir <path>] [--data-dir <path>]

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir as defaultClaudeDir, dataDir as defaultDataDir, isMainModule } from './lib/config.mjs';
import { hookCommand, mergeHook, removeHook } from './lib/settings-merge.mjs';

export const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
export const SKILL_MARKER = '<!-- installed by loose-ends -->';
export const SAMPLE_CONFIG = { port: 4477, jiraBaseUrl: '', terminal: 'wt', keyPrefixes: [] };

function timestamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKOFF_MS = [25, 50, 100, 200, 400];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Writes a temp file and renames it over the target. Retries the rename when Windows
// (antivirus, editors, Claude Code itself) briefly holds the file.
export function writeAtomicSync(path, text, { renameImpl = renameSync } = {}) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, text, 'utf8');
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      renameImpl(tmp, path);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code) || attempt === BACKOFF_MS.length) break;
      sleepSync(BACKOFF_MS[attempt]);
    }
  }
  try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  throw lastErr;
}

// The repo path ends up in a shell command (the hook) and in skill text; refuse characters
// that are special to cmd/PowerShell/bash inside double quotes.
export const UNSAFE_REPO_PATH_RE = /["$%`!]/;

export function skillBackupDir(claudeDir, name, now = new Date()) {
  // Kept outside skills/ so Claude Code doesn't load the backup as a second copy of the skill.
  return join(claudeDir, 'loose-ends-skill-backups', `${name}.loose-ends-backup-${timestamp(now)}`);
}

export function listRepoSkills(repoRoot = REPO_ROOT) {
  const dir = join(repoRoot, 'skills');
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n, 'SKILL.md')))
    .sort();
}

function readSettings(path) {
  if (!existsSync(path)) return { settings: {}, exists: false };
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { settings: {}, exists: true };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}); nothing was changed`);
  }
  return { settings, exists: true };
}

function settingsActions(path, exists, result, now) {
  if (!result.changed) return [{ type: 'note', detail: `settings: ${result.note || 'no change'}` }];
  const actions = [];
  if (exists) actions.push({ type: 'backup', path, dest: `${path}.loose-ends-backup-${timestamp(now)}` });
  actions.push({ type: 'writeSettings', path, content: JSON.stringify(result.settings, null, 2) + '\n', detail: result.note || 'updated' });
  return actions;
}

export function planInstall({ repoRoot = REPO_ROOT, claudeDir, dataDir, now = new Date() }) {
  if (UNSAFE_REPO_PATH_RE.test(repoRoot)) {
    throw new Error(`The repository path contains a character that is unsafe in shell commands (" $ % \` !): ${repoRoot}. Move or rename the folder and run the installer again.`);
  }
  const actions = [];
  const repoFwd = repoRoot.replace(/\\/g, '/');
  for (const name of listRepoSkills(repoRoot)) {
    const src = join(repoRoot, 'skills', name, 'SKILL.md');
    const skillDir = join(claudeDir, 'skills', name);
    const dest = join(skillDir, 'SKILL.md');
    let content = readFileSync(src, 'utf8').replaceAll('{{REPO}}', repoFwd);
    if (!content.includes(SKILL_MARKER)) content = content.replace(/\s*$/, `\n\n${SKILL_MARKER}\n`);
    if (existsSync(skillDir)) {
      let ours = false;
      try { ours = readFileSync(dest, 'utf8').includes(SKILL_MARKER); } catch { ours = false; }
      if (!ours) {
        actions.push({ type: 'backupDir', path: skillDir, dest: skillBackupDir(claudeDir, name, now), detail: '(existing skill not installed by loose-ends)' });
      }
    }
    actions.push({ type: 'copySkill', path: dest, content, detail: '' });
  }

  const settingsPath = join(claudeDir, 'settings.json');
  const { settings, exists } = readSettings(settingsPath);
  const result = mergeHook(settings, hookCommand(repoRoot)); // throws on wrong types -> abort
  actions.push(...settingsActions(settingsPath, exists, result, now));

  actions.push({ type: 'mkdir', path: dataDir, detail: '' });
  const cfgPath = join(dataDir, 'config.json');
  if (!existsSync(cfgPath)) {
    actions.push({ type: 'writeConfig', path: cfgPath, content: JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n', detail: 'sample config' });
  }
  return actions;
}

export function planUninstall({ repoRoot = REPO_ROOT, claudeDir, dataDir, now = new Date() }) {
  const actions = [];
  const settingsPath = join(claudeDir, 'settings.json');
  const { settings, exists } = readSettings(settingsPath);
  if (exists) {
    const result = removeHook(settings);
    actions.push(...settingsActions(settingsPath, exists, { ...result, note: result.changed ? 'removed hook' : 'hook not present' }, now));
  }
  for (const name of listRepoSkills(repoRoot)) {
    const dir = join(claudeDir, 'skills', name);
    const file = join(dir, 'SKILL.md');
    let ours = false;
    try { ours = readFileSync(file, 'utf8').includes(SKILL_MARKER); } catch { ours = false; }
    if (ours) actions.push({ type: 'removeSkill', path: dir, detail: '' });
    else if (existsSync(dir)) actions.push({ type: 'note', detail: `skipping ${dir} (not installed by loose-ends)` });
  }
  actions.push({ type: 'note', detail: `data dir and config left in place: ${dataDir}` });
  return actions;
}

export function applyActions(actions, { dryRun = false, log = console.log } = {}) {
  for (const a of actions) {
    if (dryRun) {
      log(`[dry-run] ${a.type}${a.path ? ` ${a.path}` : ''}${a.dest ? ` -> ${a.dest}` : ''}${a.detail ? ` ${a.detail}` : ''}`);
      if (a.type === 'writeSettings') {
        for (const line of a.content.split('\n').filter((l) => /loose-ends-hook|SessionEnd/.test(l))) log(`[dry-run]   ${line.trim()}`);
      }
      continue;
    }
    switch (a.type) {
      case 'copySkill':
        mkdirSync(dirname(a.path), { recursive: true });
        writeAtomicSync(a.path, a.content);
        break;
      case 'backup':
        copyFileSync(a.path, a.dest);
        break;
      case 'backupDir':
        mkdirSync(dirname(a.dest), { recursive: true });
        cpSync(a.path, a.dest, { recursive: true, errorOnExist: true, force: false });
        break;
      case 'writeSettings':
        mkdirSync(dirname(a.path), { recursive: true });
        writeAtomicSync(a.path, a.content);
        break;
      case 'mkdir':
        mkdirSync(a.path, { recursive: true });
        break;
      case 'writeConfig':
        mkdirSync(dirname(a.path), { recursive: true });
        writeFileSync(a.path, a.content, { encoding: 'utf8', flag: 'wx' });
        break;
      case 'removeSkill':
        if (existsSync(a.path) && statSync(a.path).isDirectory()) rmSync(a.path, { recursive: true, force: true });
        break;
      case 'note':
        break;
      default:
        throw new Error(`Unknown action ${a.type}`);
    }
    log(`${a.type}${a.path ? ` ${a.path}` : ''}${a.dest ? ` -> ${a.dest}` : ''}${a.detail ? ` ${a.detail}` : ''}`);
  }
}

export function parseArgs(argv) {
  const opts = { uninstall: false, dryRun: false, claudeDir: null, dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--claude-dir' || a === '--data-dir') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      opts[a === '--claude-dir' ? 'claudeDir' : 'dataDir'] = resolve(v);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

export function run(argv, { log = console.log } = {}) {
  const opts = parseArgs(argv);
  const claudeDir = opts.claudeDir ?? defaultClaudeDir();
  const dataDir = opts.dataDir ?? defaultDataDir();
  const plan = opts.uninstall ? planUninstall({ claudeDir, dataDir }) : planInstall({ claudeDir, dataDir });
  applyActions(plan, { dryRun: opts.dryRun, log });
  if (!opts.dryRun) {
    log(opts.uninstall ? 'Loose Ends uninstalled.' : `Loose Ends installed. Start the board with: node "${REPO_ROOT}/server.mjs"`);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`Loose Ends install aborted: ${err.message}`);
    process.exit(1);
  }
}
