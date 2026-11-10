# LoopPrism: see what your coding agents did

Every Claude Code, Codex, Gemini CLI, OpenCode, Cursor, DeepSeek Harness and WorkBuddy session on
your machine: what it cost, what filled the context, where it looped or failed, and how it could
have cost less. **No app to install.** LoopPrism reads the agents' own session files locally and
sends nothing anywhere.

## Install: one command

```bash
npx loopprism install
```

It finds every coding agent on your machine and gives each one the LoopPrism **skill** and **MCP
server** (Claude Code gets them as a plugin). Restart your agents, then just ask (or say *"open the LoopPrism dashboard"* to see it all in your
browser; in Claude Code, `/loopprism:open`):

> *"Use LoopPrism to review this session: what did it cost and where did the tokens go?"*
> *"What did my coding agents cost this week, and how could I spend less?"*

| Agent | What `install` adds |
|---|---|
| Claude Code | the `loopprism` plugin: skill, MCP server, `/loopprism:status`, live hooks |
| Codex | `~/.codex/skills/loopprism/`, `[mcp_servers.loopprism]` in `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/skills/loopprism/`, `mcpServers.loopprism` in `~/.gemini/settings.json` |
| OpenCode | `~/.config/opencode/skills/loopprism/`, `mcp.loopprism` in `opencode.json` |
| Cursor | `~/.cursor/skills/loopprism/`, `mcpServers.loopprism` in `~/.cursor/mcp.json` |
| WorkBuddy, DeepSeek Harness | their sessions are read; live hooks with `--live` |

`npx loopprism install codex cursor` limits it to some agents; `npx loopprism uninstall` removes
everything it added (your other settings are never touched, and each file is backed up as
`*.loopprism.bak` the first time). The package is copied to `~/.loopprism/app`, so the agents run
it directly, without npx, offline. Live hooks (each step streamed to the LoopPrism desktop app) are
added when the app is installed, or with `--live`.

## From a terminal

The same answers without an agent: `npx loopprism <command>`, or `npm install -g loopprism` for the
short `lpa`.

| Command | What it does |
|---|---|
| `lpa sessions [--agent A] [--project DIR] [-n 20]` | The newest sessions of every agent, with their cost. |
| `lpa search <words>` | Full-text search over every prompt and answer. |
| `lpa show [SESSION]` | Review a session: cost and where it went, context fill and cache hits, loops (the same tool call repeated), error streaks, compactions, the largest tool outputs, subagents, and what would have cost less. |
| `lpa events [SESSION] [--kind tool_call,...] [--grep TEXT] [--full]` | The trajectory: prompts, injected context, thinking, tool calls and results. |
| `lpa context [SESSION] [--step N]` | What filled the context window: system prompt, tool schemas, messages, injected context, skills, tool results. |
| `lpa agents [SESSION]` | The subagent tree (Claude Code): what each was asked, what it returned, its cost. |
| `lpa cost [--days 30] [--agent A]` | Spend by agent, model, project and day; the most expensive sessions. |
| `lpa optimize [--days 30]` | Suggestions (prompt caching, smaller models for simple tasks, repeated calls, huge tool outputs, sessions that ran too long), each with an estimated saving. |
| `lpa export [SESSION] [-o FILE]` | The conversation as Markdown. |
| `lpa ui [SESSION] [--detach]` | The LoopPrism dashboard (sessions, timeline, context, subagent flow, cost and optimize pages) in your browser, served from `127.0.0.1:8765`. `--detach` runs it in the background; it stops after an hour unused. |
| `lpa mcp` | Run as an MCP server, so your agent can ask these questions itself (below). |

`SESSION` is a session id (or a unique prefix), `current` (the newest session whose folder is the
one you are in; the default) or `latest`. Add `--json` to any command for machine-readable output.

## The MCP server by hand

`install` sets this up for you. To add it yourself (another agent, a project-level config), run
`npx -y loopprism mcp`, a stdio MCP server with read-only tools: `list_sessions`, `session_summary`,
`session_events`, `session_context`, `session_agents`, `cost_overview`, `find_savings` and
`export_session`.

| Agent | Add it |
|---|---|
| Claude Code | `claude mcp add --scope user loopprism -- npx -y loopprism mcp` |
| Codex | `codex mcp add loopprism -- npx -y loopprism mcp`, or in `~/.codex/config.toml`: `[mcp_servers.loopprism]` with `command = "npx"` and `args = ["-y", "loopprism", "mcp"]` |
| Gemini CLI | `gemini mcp add loopprism npx -y loopprism mcp`, or `"mcpServers": {"loopprism": {"command": "npx", "args": ["-y", "loopprism", "mcp"]}}` in `~/.gemini/settings.json` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"loopprism": {"command": "npx", "args": ["-y", "loopprism", "mcp"]}}}` |
| OpenCode | `opencode.json`: `{"mcp": {"loopprism": {"type": "local", "command": ["npx", "-y", "loopprism", "mcp"]}}}` |

## Where the data comes from

| Agent | Read from | Moved with |
|---|---|---|
| Claude Code | `~/.claude/projects/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/sessions/` | `CODEX_HOME` |
| Gemini CLI | `~/.gemini/tmp/` | `GEMINI_CLI_HOME` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `XDG_DATA_HOME` |
| Cursor | Cursor's `User/globalStorage/state.vscdb` (no token usage, so no cost) | `CURSOR_USER_DIR` |
| DeepSeek Harness | `~/.dsh/sessions/` and DSH Desktop's own folder | `DSH_HOME`, `DSH_DESKTOP_HOME` |
| WorkBuddy | `~/.workbuddy/projects/` | `WORKBUDDY_CONFIG_DIR` |

The files are only read. An index for listing and search is kept in
`~/.loopprism/sessions-index-node.db` (`LOOPPRISM_INDEX` moves it); after the first run only new and
changed sessions are read again.

**Cost** is an estimate at the providers' API list prices (`~/.loopprism/pricing.json` overrides a
model's price). Subscription plans (Claude Pro/Max, ChatGPT) bill differently; models without a
published price show no cost.

## Live runs (optional, with the LoopPrism app)

Live hooks record each prompt, tool call and error **as it happens** and send it to a running
LoopPrism (the desktop app, or `lprism proxy`). Nothing above needs them. `install` adds them when
the desktop app is installed or with `--live` (`--no-live` skips them): Codex gets entries in
`~/.codex/hooks.json`, Gemini CLI in `~/.gemini/settings.json`, Cursor in `~/.cursor/hooks.json`,
WorkBuddy in `~/.workbuddy/settings.json`, OpenCode a plugin file in `~/.config/opencode/plugins/`.
`lpa status` shows the newest runs and `lpa open` opens the app.

- **Codex asks you to trust new hooks.** After `lpa install`, open Codex and run `/hooks` once to review and trust them.
- **DeepSeek Harness:** `lpa install dsh` only writes `~/.loopprism/dsh-hooks.json`; it never edits DSH's own profile. In DSH Desktop install the plugin `dsh-hooks-claude-code`, set its `configPath` to that file, and restart. The bridge supports session start, prompt, tool and stop events (no tool failures).
- **Cursor:** `lpa install cursor` adds hooks to `~/.cursor/hooks.json` (Cursor reloads it by itself).
- **Gemini CLI:** `lpa install gemini` adds hooks to the `hooks` key of `~/.gemini/settings.json` (`$GEMINI_CLI_HOME` moves the folder); restart Gemini CLI afterwards.
- **OpenCode:** restart it after `lpa install` so it loads the plugin. Uninstall removes only the file LoopPrism wrote.
- **WorkBuddy:** restart it after `lpa install` so it reads the hooks. They run `node`, so Node.js must be on the PATH WorkBuddy uses.
- **Claude Code without npm:** `/plugin marketplace add atlasmarkz/LoopPrism`, then `/plugin install loopprism@loopprism`.
- **It never slows your agent.** The hook gives up after one second, backs off for ten seconds after a failure, always exits 0, and does nothing when LoopPrism is not running.
- **Privacy:** events go only to your own LoopPrism (`http://127.0.0.1:8080`; set `LOOPPRISM_URL` or `lpa install --url ...` to change it). Set `LOOPPRISM_NO_PROMPTS=1` to keep prompt text out of the recorded runs. Long tool inputs and outputs are cut before they are sent. Set `LOOPPRISM_DISABLE=1` to turn the hooks off.
- **What a run is:** one user prompt up to the agent's `Stop`. A run still open when the next prompt or the session end arrives is marked `abandoned`.

## Requirements

Node.js 22.15 or newer (it ships the SQLite and zstd support used to read OpenCode, Cursor and
DeepSeek Harness sessions). macOS, Windows and Linux.

## How it works

`core/` is a dependency-free Node port of LoopPrism's Python session core (the one behind the
desktop app). CI checks that both read every agent's sessions identically
(`node parity/compare.js`, on sessions made by `scripts/make_parity_fixtures.py`).
