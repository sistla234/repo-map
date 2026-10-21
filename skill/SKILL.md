---
name: repo-map
description: Launch Repo Map, a local web app that shows the current git repo's branches, PRs, and screens as a visual graph, compares local vs GitHub, and helps push/pull/rebase safely. Use when the user says "repo map", "show my branches", "map my repo", "what's unpushed", "compare branches visually", or asks where a branch stands vs main.
---

# Repo Map

Launches Repo Map for the repo you're in, opens it in the browser, and summarizes where things stand.

Requires the `repo-map` command: `npm install -g github:sistla234/repo-map` (Node 18+, git, and optionally the GitHub CLI).

## Steps

1. **Check the basics** (stop and tell the user if either fails):
   ```bash
   git rev-parse --show-toplevel
   gh auth status
   ```
   - Not a git repo → say so; ask which repo they meant.
   - `gh` not logged in → Repo Map still works, but open PRs won't show. Tell the user to run `gh auth login` (you can't do it for them), then continue.

2. **Restart the server on every invocation** — never reuse an old one (a stale server serves a newer UI and breaks screenshots). Run in the background, because it stays running:
   ```bash
   repo-map "$PWD" --restart
   ```
   `--restart` stops only this repo's previous Repo Map server (found through its registry entry in `~/.repo-map/servers/`) and starts a fresh one on the same port when possible. If the user also has an *older* server that predates the registry (it won't be stopped), run `pkill -f "bin/repo-map.js"` first — that stops every Repo Map server on the machine, so say so. Pass another path instead of `$PWD` if the user names a different repo. Add `--no-open` if the browser shouldn't open automatically.
   Read the output for the `→ http://localhost:<port>` URL.

3. **Summarize the current state in the terminal.** Run:
   ```bash
   repo-map "$PWD" --status
   ```
   (read-only; runs `git fetch`). Relay it briefly: branch, ahead/behind vs GitHub and main, uncommitted changes, open PRs, and the recommended next action.

4. **Tell the user** the URL, and that while the app is open you can:
   - explain any branch state or colour in plain language (and the git command behind it),
   - help with merge/rebase conflicts — if the app shows a paused rebase, read the conflicted files, explain what each side changed, and suggest a resolution (the user stages and presses "continue" in the app, or you can edit the files if asked),
   - help set up `.repo-map.json` for screenshots (see the project README). If screenshots come out blank, the job list says why (e.g. “blank: Missing … environment variables”); the app offers a one-click env fix, and you can help choose routes or storage presets for first-run modals.
   - if the app shows “Repo Map needs a restart”, run the launcher with `--restart` again.

## Rules

- The app is the place for push / pull / rebase / PR; each shows the exact command and waits for the user's confirm. Don't run those git commands yourself unless the user asks.
- Never force-push, `reset --hard`, `clean`, or delete branches without the user typing an explicit confirmation.
- Stop the server with: `pkill -f "bin/repo-map.js"` — but only if the user asks, and note it stops every Repo Map server on the machine.
