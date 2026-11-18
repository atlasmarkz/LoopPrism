# opencode-loopprism

[LoopPrism](https://github.com/atlasmarkz/LoopPrism) for [OpenCode](https://opencode.ai): your OpenCode
sessions show up as live runs in LoopPrism (prompts, tool calls, end of each turn), and the plugin
adds the LoopPrism MCP server and skill, so you can ask OpenCode *"what did this session cost, and
where did the tokens go?"*

Everything stays on your machine. The plugin only talks to a LoopPrism on `127.0.0.1`.

## Install

```bash
opencode plugin add opencode-loopprism
```

or put it in `opencode.json(c)`:

```jsonc
{ "plugins": ["opencode-loopprism"] }
```

Restart OpenCode. (OpenCode 1.x uses `"plugin"` instead of `"plugins"`; see below.)

## What it does

| | |
|---|---|
| Live runs | Reports prompts, tool calls and the end of each turn to the LoopPrism API (`/api/ingest/events`). Needs LoopPrism running (the desktop app, or `lpa`). When it is not running, nothing is sent and OpenCode is not slowed down. |
| MCP server | Registers `loopprism` (`lpa mcp`, from the `loopprism` npm package this plugin depends on) through the plugin API. Nothing is written to `opencode.json`. |
| Skill | Registers the `loopprism` skill. |
| TUI sidebar card (OpenCode 2.x) | A compact "LoopPrism" card in the TUI sidebar: cost, context fill, cache hit rate, and what LoopPrism found (repeated calls, error streaks, compactions). Read locally from OpenCode's session database; needs no running LoopPrism. Refreshes when a turn ends. See `docs/opencode-sidebar-prototype.md`. |

An MCP server or skill you already have under the name `loopprism` is left alone.

## Settings (environment)

- `LOOPPRISM_URL`: where LoopPrism listens. Default: `~/.loopprism/agent.json`, else `http://127.0.0.1:8080`.
- `LOOPPRISM_DISABLE=1`: report nothing.
- `LOOPPRISM_NO_PROMPTS=1`: report that a prompt happened, but not its text.
- `LOOPPRISM_MCP_COMMAND`: a JSON array replacing the MCP server command, e.g. `["lpa","mcp"]`.

## OpenCode versions

- **OpenCode 2.x**: `plugins` config key, `opencode plugin add`. The plugin uses its `setup(ctx)` API.
- **OpenCode 1.x** (1.18.29 and newer): `plugin` config key. The same default export carries a `server()` function that registers the
  1.x hooks (live runs only; MCP server and skill are not registered by the 1.x path).

## Develop

```bash
npm install
npm test
```
