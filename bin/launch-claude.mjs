#!/usr/bin/env node
// Runs inside the new terminal window: reads the prompt file and starts claude with the
// prompt as a single argv element (no shell involved).
// Usage: node launch-claude.mjs <promptFile> <absolute path of claude>
// The claude path is resolved by the server at startup from PATH (never a bare name, which
// Windows would also look up in the current directory, i.e. the item's repo).

import { spawn } from 'node:child_process';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

const MAX_ARG = 30000;
const SAFE_PATH_RE = /^[A-Za-z0-9 :._~\\/()-]+$/;

// Ctrl+C reaches every process attached to the console. Ignore it here so the
// terminal pane (and claude with it) does not close when the user interrupts claude.
process.on('SIGINT', () => {});

const [promptFile, claudePath] = process.argv.slice(2);

function die(msg) {
  console.error(`Loose Ends: ${msg}`);
  if (promptFile) console.error(`The prompt is saved in: ${promptFile}`);
  process.exit(1);
}

if (!promptFile) die('usage: node launch-claude.mjs <promptFile> <claudePath>');
let claudeOk = false;
try {
  claudeOk = typeof claudePath === 'string' && isAbsolute(claudePath) && !/^[\\/]{2}/.test(claudePath) && statSync(claudePath).isFile();
} catch {
  claudeOk = false;
}
if (!claudeOk) die('the claude CLI was not found (expected an absolute path to an existing file). Is claude on your PATH? Restart the board after installing it.');

let prompt;
try {
  prompt = readFileSync(promptFile, 'utf8');
} catch (err) {
  die(`cannot read prompt file: ${err.message}`);
}

const removePrompt = () => {
  try { unlinkSync(promptFile); } catch { /* ignore */ }
};

// Used for npm-style shims (claude.cmd/.bat, which can't be spawned without a shell) and
// very long prompts: claude is asked to read the prompt file instead.
function fileReferenceFallback() {
  if (!SAFE_PATH_RE.test(promptFile) || !SAFE_PATH_RE.test(claudePath)) {
    die('could not start claude directly. Start claude yourself and ask it to read the prompt file.');
  }
  const child = spawn(`"${claudePath}" "Read the file ${promptFile} and follow the instructions in it."`, { shell: true, stdio: 'inherit' });
  child.on('error', (err) => die(`failed to start claude: ${err.message}`));
  child.on('exit', (code) => {
    removePrompt();
    process.exit(code ?? 0);
  });
}

const isShim = /^\.(cmd|bat)$/i.test(extname(claudePath));
if (prompt.length > MAX_ARG || isShim) {
  fileReferenceFallback();
} else {
  const child = spawn(claudePath, [prompt], { stdio: 'inherit' });
  child.on('spawn', removePrompt);
  child.on('error', (err) => {
    if (err.code === 'ENOENT' || err.code === 'EINVAL') fileReferenceFallback();
    else die(`failed to start claude: ${err.message}`);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
