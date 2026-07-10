# Machine-local dev notes (semar / DESKTOP-41FE05C)

This file is gitignored — it documents how *this machine* runs pi-web, not
anything about the codebase itself. See `CLAUDE.md` for that.

## Dev server is normally already running

On this machine, pi-web isn't started with `npm run dev` ad hoc — it's kept
running via an external script at `C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1`,
serving at `https://pi.nase-herring.ts.net` (local: `http://127.0.0.1:8505`).

**Before starting a server yourself (`npm run dev`, `preview_start`, etc.), check
whether something is already listening on port 8505.** Starting a second instance
can collide with the running one (e.g. stale `sessiond.sock` causing `EACCES`),
and killing processes to "clean up" risks taking down the user's actual running
instance. Prefer using the script below over starting your own.

## Controlling the server

```powershell
& "C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1"           # start all services + watch loop (re-ups if any go down)
& "C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1" -NoWatch  # one-shot start, no watch loop
& "C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1" -Restart  # stop then start everything (implies -NoWatch) — use this after code changes that need a full restart (non-client changes; Vite HMR handles client-only edits on its own)
& "C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1" -Stop     # stop all pi-web processes
& "C:\Workspace\pi-life\scripts\semar\pi-web-startup.ps1" -Status   # check what's running
```

Three services, three ports:
- `sessiond` — 8506
- web API — 8504
- Vite dev server — 8505 (this is the one you browse to)

## Reading logs

Logs are written to `$env:TEMP\pi-web\` (i.e.
`C:\Users\SER5 5560U\AppData\Local\Temp\pi-web\`):

- `sessiond.log` / `sessiond-err.log`
- `api.log` / `api-err.log` — includes per-request Fastify logs (method, URL,
  reqId); useful for confirming a specific API call actually happened and when
- `vite.log` / `vite-err.log`

Grep `api.log` for a specific route or session id to trace request timing
across a debugging session, e.g.:

```bash
grep -n "mark-read\|<session-id>" "/c/Users/SER5 5560U/AppData/Local/Temp/pi-web/api.log"
```

## Session file storage

Pi coding-agent session JSONL files live under
`C:\Users\SER5 5560U\.pi\agent\sessions\--<cwd-encoded>--\*.jsonl`. The first
line of each file is the session header (JSON) — useful for inspecting
persisted per-session state (e.g. `lastReadAt`/`lastReadMessageCount`) directly
without going through the API.

## Browser verification

The `preview_start`/`preview_*` tool family only knows how to spawn-and-own a
process from `.claude/launch.json` — it refuses to attach to a server it
didn't start itself (correctly: it won't hijack port 8505 out from under the
semar-managed instance). To verify UI changes against the real running
instance, drive it with the `claude-in-chrome` MCP tools instead
(`navigate`, `computer`, `javascript_tool`, etc.) pointed at
`http://localhost:8505`.
