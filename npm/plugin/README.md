# LoopPrism for Claude Code

Shows what your agent actually did, in two parts:

- **Review tools (no app needed).** A skill and a local MCP server (`npx -y loopprism@<version> mcp`)
  that read the session transcripts Claude Code, Codex, Gemini CLI, OpenCode, Cursor and others keep on
  your machine, and answer: what did this session cost, what filled the context window, where did the
  agent loop or fail, and how to spend less. Ask in plain words ("why was this session expensive?").
- **Live runs.** Hooks that record each prompt, tool call and error from your Claude Code sessions as a
  **run** in [LoopPrism](https://github.com/atlasmarkz/LoopPrism), a local observability tool, so the
  dashboard shows every step while it happens. This part needs LoopPrism running on your machine (the
  desktop app, or `lprism proxy`). If it is not running, the hooks do nothing and do not slow Claude Code down.

**Requirements:** Node.js 22.15 or newer on your `PATH` (the hooks run `node`; the MCP server runs
through `npx`). The first start downloads the `loopprism` package from the npm registry; later starts
use npm's cache, but `npx` still asks the registry, so with no network the MCP server fails to start
(Claude Code carries on without its tools). `npx loopprism install` puts a local copy in
`~/.loopprism/app` so the MCP server starts offline.

## What it runs

Six hooks run a small Node script (`scripts/hook.js`, no dependencies):

| Hook | Reported |
|---|---|
| `SessionStart`, `SessionEnd` | that a session started or ended |
| `UserPromptSubmit` | the text of your prompt |
| `PostToolUse`, `PostToolUseFailure` | the tool name, its input, a result or error, and how long it took |
| `Stop` | that Claude finished responding, plus the token counts and model names for that turn (see below) |

Two slash commands are included. `/loopprism:status` prints your newest runs and
`/loopprism:open` opens the dashboard. They run `scripts/viewer.js`, which only reads from
your LoopPrism server.

## What is sent, and where

Each hook sends one JSON event over HTTP to **`http://127.0.0.1:8080`** by default: your own
machine, the LoopPrism server. Nothing is sent anywhere else unless **you** point the plugin
at another address by setting `LOOPPRISM_URL` or by running `lpa install --url <address>`.

An event contains the session id, the working directory, the model name when Claude Code provides it, and, depending on
the hook, your prompt, or a tool's name, input and result. When Claude finishes a turn, the `Stop` hook opens **your session's own transcript file**
(the `transcript_path` Claude Code hands to hooks, under `~/.claude/projects/`) and reads only
the token usage numbers and model names from it, so LoopPrism can estimate what the turn cost.
The transcript's text is not sent. For Codex sessions the same hook reads the matching file
under `~/.codex/sessions/`.

Long values are cut before they are
sent (4,000 characters per string), and LoopPrism cuts them again when it stores them. Events
are stored in a SQLite file on your machine, `~/.loopprism/traces.db`.

The hooks and slash commands read only their own `LOOPPRISM_*` settings (and `CODEX_HOME`, to find
Codex sessions) from the environment, never read credentials, never make any network request other than
the one above, and never change Claude Code's permission settings.

The MCP server and the skill's shell fallbacks run `loopprism` locally: they read the agents' session
files under your home folder (`~/.claude`, `~/.codex`, ...) and the LoopPrism database, answer Claude
Code over stdio, and send nothing anywhere. The only network traffic is `npx` fetching the package from
the npm registry. The dashboard (`open_dashboard`, `/loopprism:open`) is served on `127.0.0.1` only.

## Controls

| Setting | Effect |
|---|---|
| `LOOPPRISM_DISABLE=1` | turn the hooks off |
| `LOOPPRISM_NO_PROMPTS=1` | keep your prompt text out of the events |
| `LOOPPRISM_URL` | send events to a different LoopPrism address |
| `LOOPPRISM_DEBUG=1` | print problems to stderr |
| `LOOPPRISM_HOOK_TIMEOUT_MS` | how long the hook waits for LoopPrism (default 1000) |

The hook gives up after one second and always exits successfully, so it cannot block or fail
your session. When LoopPrism is not reachable, or times out twice in a row, the hooks skip
sending for ten seconds; a single slow answer does not pause recording.

## Install

```
/plugin marketplace add atlasmarkz/LoopPrism
/plugin install loopprism@loopprism
```

or from a shell: `npx loopprism install` (this also sets up Codex).
Remove it with `/plugin uninstall loopprism@loopprism`.

MIT licensed. Source: https://github.com/atlasmarkz/LoopPrism (this plugin is in `npm/plugin`).
