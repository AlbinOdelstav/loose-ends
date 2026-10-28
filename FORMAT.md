# Loose Ends data format

The files are the source of truth. The server, the SessionEnd hook and the skills all read and write the same files.

## Location

- Data dir: `~/.claude/loose-ends/` (override with the `LOOSE_ENDS_DIR` environment variable).
- One markdown file per item: `<KEY>.md`.
- `KEY` is an issue key (`ABC-123`) or a kebab-case slug for work without a ticket (`cleanup-build-scripts`).
  - Must match `^[A-Za-z0-9._-]{1,100}$`.
  - Must not be `.` or `..`, must not end with `.`, and must not be a Windows device name (`CON`, `NUL`, `COM1`, …).
- Item files larger than 1 MB are not read (the board shows them as unreadable).
- Files and folders starting with `.` are ignored (`.hook.log`, `.prompts/`, temp files).
- Optional local config: `config.json` in the data dir (see README).

## Example

```markdown
---
key: ABC-123
title: "Fix login timeout"
status: waiting
waitingOn: "Review from the platform team"
jiraStatus: "In Review"
repo: C:\src\app
cwd: C:\src\app-worktrees\abc-123
branch: feature/abc-123-login-timeout
pr: https://github.com/example/app/pull/42
updated: 2026-01-31T14:05:00.000Z
lastCheckpoint: 2026-01-31T14:05:00.000Z
sessions:
  - id: 0f6c2a9e-1111-2222-3333-444455556666
    parentId:
    cwd: C:\src\app-worktrees\abc-123
    branch: feature/abc-123-login-timeout
    endedAt: 2026-01-31T14:06:10.000Z
    note: "Found the lock; fix is in the PR"
    open: false
  - id: 7a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff
    parentId: 0f6c2a9e-1111-2222-3333-444455556666
    cwd: C:\src\app-worktrees\abc-123-test
    branch: abc-123-regression-test
    endedAt: 2026-01-31T15:20:00.000Z
    note: "Writing the regression test, flaky on CI"
    open: true
  - id: 9e8d7c6b-1234-5678-9abc-def012345678
    cwd: C:\src\app
    branch: main
    endedAt: 2026-01-31T16:00:00.000Z
sessionsSinceCheckpoint: 0
---

## Summary
Login requests time out after 30 s under load. Root cause is the token cache lock.

## Next steps
- [x] Reproduce the timeout locally
- [ ] Add a regression test
- [ ] Ask for review

## Blockers

## Notes
Load test script: `scripts/load.sh`.

## Log
- 2026-01-30: Reproduced, found the lock
- 2026-01-31: Opened PR
```

## Frontmatter fields

| Field | Meaning |
|---|---|
| `key` | Item key (the file name is authoritative). |
| `title` | Short title (issue summary or description). |
| `status` | `active`, `waiting`, `parked` or `done`. Unknown values are shown under Active with a badge. |
| `waitingOn` | Free text: who or what the item is waiting on. |
| `jiraStatus` | Issue status captured at the last checkpoint. |
| `repo` | Absolute path of the main repository. |
| `cwd` | Absolute path to start sessions in (the worktree, if one is used). |
| `branch` | Git branch. |
| `pr` | Pull request URL or number. |
| `updated` | ISO 8601 time of the last change. |
| `lastCheckpoint` | ISO 8601 time of the last `/checkpoint`. |
| `sessions` | List of session records ("threads"), see below. |
| `sessionsSinceCheckpoint` | Sessions ended since the last checkpoint. `/checkpoint` resets it to 0. |

Unknown fields are preserved as written.

### Session records (threads)

| Field | Written by | Meaning |
|---|---|---|
| `id` | hook | Claude Code session id. |
| `parentId` | hook | Session this one was forked or resumed from, or empty. |
| `cwd` | hook | Directory the session ran in. |
| `branch` | hook | Git branch at session end. |
| `endedAt` | hook | ISO 8601 time the session ended (updated if the same session ends again). |
| `note` | `/checkpoint`, board | One line: what this session/fork was doing or left unfinished (at most 300 characters via the board). Write it as a JSON double-quoted string. |
| `open` | `/checkpoint`, board | `true` = open thread (unfinished work), `false` = finished, missing = untracked. |

- **Thread states:**
  - The hook writes new records *without* `open`, so they start as untracked.
  - Only `/checkpoint` or the board makes a session an open thread (`open: true`).
  - Only open threads count: they appear in the board's "N open threads" badge, in the "other open threads" part of start prompts, and they are protected by the cap.
  - `/checkpoint` also marks ancestors of the current session that have no `note` as finished.
- **No session id:** if the hook gets no valid session id, it records no session. It still updates `updated` and the counter.
- **Parent detection:**
  - The hook reads the start of the session transcript: the first 64 KB, then further chunks up to 4 MB, until it reaches the session's own entries.
  - Entries copied from earlier sessions carry their own `sessionId`.
  - The parent is the *last* foreign `sessionId` before the first own entry. For a fork of a fork (A, then B, then C) the parent of C is B.
- **Which item a session is attached to:**
  - The key detected from the branch, directory or worktree name wins.
  - If no key is found and the parent session is recorded in an item that is not `done`, the session is attached to that item.
- **Tree:** sessions form a tree through `parentId`. A session whose parent is not in the same item is a root.
- **Cap:** the list keeps every open thread plus the last 20 untracked or finished records. There is also a hard ceiling of 50 records in total, enforced by dropping the oldest first.
- **Unparseable values:** a value inside a session record that isn't valid quoted syntax (e.g. `note: [WIP] refactor 'auth'`) is read as plain text, so one sloppy value never hides the whole list.

## Frontmatter grammar (YAML subset)

```
file        := ["---" NL fmline* "---" NL] body
fmline      := blank | comment | entry
comment     := "#" ...                         (full-line only; preserved verbatim in place)
entry       := KEY ":" ( SP scalar | SP "[]" | "" ) NL listitem*
KEY         := [A-Za-z_][A-Za-z0-9_]*
listitem    := IND "- " ( mappair | scalar ) NL ( IND2 mappair NL )*   IND >= 0, IND2 > IND
mappair     := KEY ":" [ SP scalar ]
scalar      := dq | sq | plain | ""            ("" / no value => null)
dq          := JSON string literal  "..."   (JSON escapes)
sq          := '...'  with '' as escaped quote
plain       := rest of line, trimmed; no escapes, no inline comments
               "true"/"false" -> bool; "null"/"~" -> null; /^-?\d{1,15}$/ -> number; else string
```

- Round-trips are lossless: every entry keeps its raw text, and an entry whose value didn't change is written back byte for byte.
- Entries outside the subset (block scalars `|`/`>`, nested maps, flow lists other than `[]`) are kept verbatim but ignored. If such an entry is a known field, the board shows a warning chip on the card. Inside list items the parser is lenient: a value that does not parse is kept as plain text.
- With a duplicate key, the last one wins.
- Existing fields keep their position. New fields are appended at the end of the frontmatter (several new known fields among themselves in the order of the table above).
- Strings are written plain when that is unambiguous; otherwise as JSON double-quoted strings. Windows paths stay plain (plain scalars have no escapes).
- Files are written with LF line endings; CRLF and a UTF-8 BOM are accepted when reading.

## Body

- Split into sections on `## Heading` lines outside fenced code blocks. Headings match case-insensitively.
- Known sections, in canonical order: `## Summary`, `## Next steps`, `## Blockers`, `## Notes`, `## Log`. Missing sections are added in this order.
- Unknown sections and any text before the first heading are kept verbatim and in place.

### Next steps

- Markdown checklist in recommended order. Only lines matching `^( {0,3})[-*] \[([ xX])\] (.*)$` outside code fences are steps.
- Steps are numbered from 0 in file order (this is the index used by the board API).
- `- [ ]` is open, `- [x]` is done. Marking a step done only changes the checkbox character.

### Log

- One line per checkpoint (or board archive): `- YYYY-MM-DD: what happened`.
