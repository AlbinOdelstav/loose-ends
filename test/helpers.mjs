// Shared test helpers (no tests in this file).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];

export function tempDir(prefix = 'loose-ends-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

export function cleanupTempDirs() {
  while (created.length) {
    const d = created.pop();
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
