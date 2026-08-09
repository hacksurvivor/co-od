---
name: co-od
description: Open-source CLI for connecting local development environments to co-od rooms
version: 0.2.0
---

# co-od CLI

Run coding agents together in co-od rooms from the command line.

## Commands

- `co-od` / `co-od tui` -- open the terminal workspace
- `co-od opentui` -- open the experimental Bun/OpenTUI workspace
- `co-od tui --renderer opentui` -- opt into the experimental OpenTUI renderer
- `co-od web` / `co-od --open` -- open the browser workspace
- `co-od login` -- authenticate via browser (or `--token <t>` for CI)
- `co-od rooms` -- list rooms (supports `--json`)
- `co-od run <room> <goal>` -- execute a single task, fire-and-forget
- `co-od join <room>` -- join a room as an interactive agent (PTY + WebSocket)
- `co-od daemon <room>` -- autonomous watch mode, polls for events and executes
- `co-od share` -- generate a relay code for teammates
- `co-od connect <code>` -- connect to a shared relay
- `co-od status` -- show login state and session info
- `co-od doctor` -- check local CLI, Node, OpenTUI/Bun, cache policy, and live QA readiness
- `co-od tui-qa` -- run deterministic terminal flow QA (`--live` is opt-in)

## Terminal Workspace

The default local experience is the TUI. Start with `co-od` or `co-od tui`.

Offline room dashboard fallback is enabled by default for recent room data.
Use `CO_OD_TUI_DISABLE_DASHBOARD_CACHE=true` to disable cached dashboard data or
`CO_OD_TUI_DASHBOARD_CACHE_MAX_AGE=3h` to tune the freshness window.

Useful slash commands inside the TUI:

- `/provider`, `/model`, `/agent`, `/rooms`, `/room`, `/runs`, `/run`
- `/terminal`, `/connect`, `/reconnect`
- `/runtime`, `/env status`, `/env start`, `/env touch`, `/env stop`
- `/history`, `/use-history`, `/again`
- `/sessions`, `/session`
- `/context`, `/git`, `/files`, `/view`, `/peek`, `/find`, `/search`,
  `/symbols`, `/diagnostics`
- `/attach`, `/attach-image`, `/detach`, `/attachments`
- `/continue`, `/resume`, `/fork`, `/rerun`, `/retry`, `/stop`
- `/fanout`, `/handoff`, `/agent-start`, `/agent-stop`, `/agent-pause`,
  `/agent-resume`
- `/safety`, `/safety audit`, `/safety toggle`, `/undo`

Run `pnpm verify:tui` from the repo root before shipping TUI changes. The gate
smokes the default Node renderer, `co-od opentui`, and
`co-od tui --renderer opentui`.

Run `pnpm release:tui -- --room <room-id>` only when a configured beta room is
available. It adds a fresh-install smoke, `doctor --strict`, read-only live room
QA, and guarded mutating live room QA. The release gate also accepts
`--server <url>`, `--dir <path>`, `--bridge-url <url>`, `--agent <id>`, and
`--skip-terminal`.

Live room QA is opt-in and requires a current login plus a configured room:
`pnpm qa:tui:live` runs read-only checks, and `pnpm qa:tui:live:mutate` runs
the guarded disposable mutation scenarios.

## Provider Support

Use `--provider claude|codex|opencode|openclaw|zeroclaw` on `tui`, `run`, `daemon`, and `share` commands.

- `claude` (default) -- spawns `claude -p --dangerously-skip-permissions`
- `codex` -- spawns `codex exec --full-auto`
- `opencode` -- spawns `opencode run <goal>`
- `openclaw` / `zeroclaw` -- spawns the OpenClaw-compatible local CLI

## Usage with Claude Code

Dispatch tasks to a room from within Claude Code hooks:

```bash
co-od run room_abc123 "Fix the failing tests in src/utils" --json
```

## Environment Variables

- `CO_ODE_SERVER` -- override the server URL (default: https://co-od.dev)

## Session

Sessions are cached at `~/.co-ode/session.json` (valid for 23 hours).
