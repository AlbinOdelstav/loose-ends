import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// True for absolute paths on a local drive. On Windows this means "X:\..." or "X:/...";
// UNC paths (\\server\share, //server/share) and device paths (\\?\, \\.\) are rejected so
// that touching an item's path can never trigger an SMB connection (NTLM credential leak).
export function isSafeLocalPath(p, platform = process.platform) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false;
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) return false; // \\server, //server, \\?\, \\.\
    return /^[A-Za-z]:[\\/]/.test(p);
  }
  return p.startsWith('/') && isAbsolute(p);
}

export function isExistingAbsDir(p, platform = process.platform) {
  if (!isSafeLocalPath(p, platform)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
