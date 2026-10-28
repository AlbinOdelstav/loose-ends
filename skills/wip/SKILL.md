---
name: wip
description: List all unfinished work items on the Loose Ends board (key, status, waiting on, next step, checkpoint age) and show the board URL. Use when the user asks what they have in progress or what to work on next.
---

# /wip

Show a compact overview of all work in progress.

## Steps

1. Get the current time with `node -e "console.log(new Date().toISOString())"` (UTC) and compute ages from it; don't guess the date.
2. Data dir: `$LOOSE_ENDS_DIR` if set, otherwise `~/.claude/loose-ends/`. Read every `*.md` file there (skip files starting with `.`).
3. For each item, read the frontmatter (`key`, `title`, `status`, `waitingOn`, `lastCheckpoint`, `updated`, `sessionsSinceCheckpoint`, `sessions`) and the first open step (`- [ ]`) in `## Next steps`.
4. Skip items with `status: done`. Group by status in this order: active, waiting, parked. Within a group, most recently updated first.
5. Print one line per item:
   `KEY  status  [waiting on …]  next: <first open step>  (checkpoint 3d ago)`
   - Add `⚠ N sessions since checkpoint` when `sessionsSinceCheckpoint` > 0.
   - Mark items not updated or checkpointed for over 7 days as stale.
   - Under the line, list the item's **open threads**: entries in `sessions` with `open: true` only (records without `open` are untracked and records with `open: false` are finished — skip both), indented under their parent (`parentId`) when the parent is also listed, one short line each: `  ↳ <first 8 chars of id>  <branch>  <note>`.
6. End with the board URL: `http://127.0.0.1:<port>` where the port comes from `<dataDir>/config.json` (default 4477). If the board isn't running, it can be started with `node "{{REPO}}/server.mjs"`.

Do not modify any files.

<!-- installed by loose-ends -->
