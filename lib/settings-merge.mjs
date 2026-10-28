// Pure helpers for adding/removing the Loose Ends SessionEnd hook in Claude Code settings.

export const HOOK_MARKER = '--loose-ends-hook';
export const DEFAULT_TIMEOUT = 5;

export function hookCommand(repoRoot) {
  const root = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  return `node "${root}/hooks/session-end.mjs" ${HOOK_MARKER}`;
}

export function isOurHook(h) {
  return !!h && typeof h === 'object' && h.type === 'command' && typeof h.command === 'string'
    && h.command.includes('session-end.mjs') && h.command.includes(HOOK_MARKER);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateHooksShape(settings) {
  if (!isPlainObject(settings)) throw new Error('settings.json must contain a JSON object');
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) throw new Error('"hooks" in settings.json is not an object');
  if (settings.hooks && settings.hooks.SessionEnd !== undefined && !Array.isArray(settings.hooks.SessionEnd)) {
    throw new Error('"hooks.SessionEnd" in settings.json is not an array');
  }
}

// Removes our hooks from every group; drops groups that we emptied. Mutates `groups`' elements in place.
function stripOurs(groups) {
  let removed = 0;
  const out = [];
  for (const g of groups) {
    if (!isPlainObject(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const kept = g.hooks.filter((h) => !isOurHook(h));
    const n = g.hooks.length - kept.length;
    removed += n;
    if (n === 0) { out.push(g); continue; }
    if (kept.length === 0) continue;
    out.push({ ...g, hooks: kept });
  }
  return { groups: out, removed };
}

export function mergeHook(settings, command, timeout = DEFAULT_TIMEOUT) {
  const s = structuredClone(settings ?? {});
  validateHooksShape(s);
  const groups = (s.hooks && s.hooks.SessionEnd) || [];
  const ours = [];
  for (const g of groups) {
    if (isPlainObject(g) && Array.isArray(g.hooks)) ours.push(...g.hooks.filter(isOurHook));
  }
  if (ours.length === 1 && ours[0].command === command && ours[0].timeout === timeout) {
    return { settings: s, changed: false, note: 'already installed' };
  }
  const { groups: rest } = stripOurs(groups);
  rest.push({ hooks: [{ type: 'command', command, timeout }] });
  if (!s.hooks) s.hooks = {};
  s.hooks.SessionEnd = rest;
  return { settings: s, changed: true, note: ours.length ? `replaced ${ours.length} existing entr${ours.length === 1 ? 'y' : 'ies'}` : 'added' };
}

export function removeHook(settings) {
  const s = structuredClone(settings ?? {});
  validateHooksShape(s);
  if (!s.hooks || !Array.isArray(s.hooks.SessionEnd)) return { settings: s, changed: false };
  const { groups, removed } = stripOurs(s.hooks.SessionEnd);
  if (!removed) return { settings: s, changed: false };
  if (groups.length) s.hooks.SessionEnd = groups;
  else delete s.hooks.SessionEnd;
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return { settings: s, changed: true };
}
