# Loose Ends

A local work-in-progress board for half-done work items — usually Jira tickets, but anything works — across Claude Code sessions.

- **`/checkpoint [KEY]`** saves where you are: summary, blockers, a recommended list of next steps, branch, PR and a log line.
- **A SessionEnd hook** notices sessions that ended on a branch or worktree belonging to an item and records them, so the board can warn you about work that was never checkpointed.
- **The board** (`npm start`) shows everything grouped by status, with live git and PR facts. Pick the next steps you want and start a new Claude session in the right directory with one click, or copy the prompt.
- **`/pickup KEY`** continues an item in the current session; **`/wip`** lists what's open.
- **Session trees:** forked or resumed sessions are grouped under their item as a tree. This works even when the fork's worktree or branch name doesn't contain the ticket key: the parent is found from the transcript. Sessions start as *untracked*. `/checkpoint` (or the board) turns the current session into an *open thread* with a one-line note, or marks it finished. Only open threads are counted, listed in prompts for new sessions, and kept forever.

Zero dependencies: plain Node 22, ES modules, vanilla JS UI.

## Requirements

- Node.js 22 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on your `PATH`)
- Optional: `git` and the GitHub CLI `gh` for live branch/PR facts
- Starting sessions from the board uses Windows Terminal (`wt.exe`) with a `cmd` fallback, so it is Windows-only. On other platforms use **Copy prompt**.

## Install

```sh
git clone <this repo>
cd <the folder you cloned into>
npm run install-hooks          # or: node install.mjs
```

The installer:

1. copies the `checkpoint`, `pickup` and `wip` skills into `~/.claude/skills/` (only those three folders). An existing skill folder with the same name that Loose Ends didn't install is first copied to `~/.claude/loose-ends-skill-backups/`;
2. adds a SessionEnd hook entry to `~/.claude/settings.json` that points at this checkout (a backup `settings.json.loose-ends-backup-<timestamp>` is written first; existing hooks are kept; re-running never adds duplicates; if you move the checkout, re-run it and the old entry is replaced);
3. creates the data dir `~/.claude/loose-ends/` and a sample `config.json` if they don't exist.

The checkout path must not contain any of the characters `"`, `$`, `%`, `` ` `` or `!`, because it is used in the hook command. The installer refuses such paths.

Options:

- `node install.mjs --dry-run` prints what would be done and writes nothing.
- `node install.mjs --uninstall` removes the hook entry and the three skills (only if they were installed by Loose Ends). Your items and config are left in place.

## Run the board

```sh
npm start                      # or: node server.mjs
```

Open http://127.0.0.1:4477. The server listens on 127.0.0.1 only, watches the data dir and pushes changes to the page.

`git`, `gh` and `claude` are located once at startup by searching `PATH`, and are always run by absolute path. Restart the board after installing one of them.

**Start session** first shows the exact prompt and asks you to confirm. Then it opens a new terminal in the item's working directory and starts `claude` with that prompt.

## Configuration

Optional file: `~/.claude/loose-ends/config.json`. Everything works without it.

```json
{
  "port": 4477,
  "jiraBaseUrl": "https://example.atlassian.net",
  "terminal": "wt",
  "keyPrefixes": ["ABC", "XYZ"],
  "ghHosts": ["github.example.com"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `port` | `4477` | Board port. The `LOOSE_ENDS_PORT` environment variable takes precedence. |
| `jiraBaseUrl` | none | If set, issue keys on the board link to `<jiraBaseUrl>/browse/KEY`. |
| `terminal` | `wt` | `wt` (Windows Terminal, falls back to `cmd`) or `cmd`. |
| `keyPrefixes` | `[]` | If non-empty, only keys with these prefixes are detected from branch/folder names. |
| `ghHosts` | `[]` | Extra GitHub Enterprise hosts allowed in `pr` URLs. `github.com` is always allowed. PR numbers and branch names always work. |

Environment variables: `LOOSE_ENDS_DIR` (data dir), `LOOSE_ENDS_PORT` (port), `CLAUDE_CONFIG_DIR` (Claude config dir used by the installer).

## How keys are detected

The hook looks for an issue-key-like token (`[A-Za-z][A-Za-z0-9]+-\d+`, uppercased) in the git branch name, then in the working directory name, then in the worktree folder name. `feature/abc-123-fix` gives `ABC-123`. Obvious false positives such as `utf-8`, `sha-256` or `x86-64` are ignored. Work without a ticket can use any slug as its key via `/checkpoint my-slug`.

If no key is found but the session was forked or resumed from a session already recorded on an item, the new session is attached to that item. An explicit key in the branch or folder name always wins.

## Data format

See [FORMAT.md](FORMAT.md). Item files are plain markdown with a small YAML frontmatter, so you can also edit them by hand.

## Privacy

All data stays on your machine, in `~/.claude/loose-ends/`. The server binds to 127.0.0.1 only and every state-changing request needs a per-process token plus a matching `Host`/`Origin`. The only outbound calls are the ones `git`, `gh` and Claude make on your behalf. Work-specific settings (such as your Jira URL) belong in the local `config.json`, not in this repository.

## Security notes

- **Item files feed prompts.** Summaries, steps, notes and thread notes are written by Claude and may contain text copied from tickets, PRs or web pages. Prompts built by the board put all recorded text in a clearly marked "recorded notes" block and tell Claude to treat it as data. Only the steps you selected are the instructions, and you see the full prompt before launching. Still, review item files you didn't write, and don't paste untrusted instructions into them. `/checkpoint` is told to paraphrase external text instead of copying it.
- **Local only.** The server binds to 127.0.0.1. It checks `Host` and `Origin` on every request (blocking DNS rebinding and cross-site requests). Every change needs a per-process token from the page, and request bodies are small and validated.
- **Single-user machine.** Loose Ends assumes nobody else can write to your home directory or your `PATH` directories. Anyone who can edit `~/.claude/loose-ends/*.md` can influence prompts and the directories sessions start in.
- **Paths and binaries.** Only local paths are used as working directories (no UNC/network paths). Executables are resolved from absolute `PATH` entries only (never the current directory). `pr` values are limited to numbers, branch names and https URLs on allowed GitHub hosts.

## Development

```sh
npm test                       # node --test, no dependencies
```

Tests use temporary directories only.

## License

MIT
