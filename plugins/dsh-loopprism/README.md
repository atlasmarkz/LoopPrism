# dsh-loopprism

[LoopPrism](https://github.com/atlasmarkz/LoopPrism) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). One plugin, two parts, each can be switched off:

1. **Live steps.** It subscribes to the harness's interception points and sends what it sees to the LoopPrism app on your machine (`POST /api/ingest/events`, the same endpoint LoopPrism's Claude Code and Codex hooks use), so the app's live view shows a DeepSeek Harness run while it happens:

   | Harness point | LoopPrism event |
   |---|---|
   | `agent/created` | `session_start` |
   | `agent/pre-step` (a new prompt) | `prompt` |
   | `tools/post-execute`, success | `tool` |
   | `tools/post-execute`, failure | `tool_failure` |
   | `agent/turn-stopping` | `stop` |

   It only observes: every listener hands the decision on (`next()`) unchanged, and sending is queued in the background, so a stopped or slow LoopPrism app never delays the agent. While the app is unreachable, sending pauses for 10 seconds at a time.

2. **Review tools.** It registers the tools `lpa mcp` serves as DeepSeek Harness tools named `loopprism_<tool>`: `list_sessions`, `session_summary`, `session_events`, `session_context`, `session_agents`, `cost_overview`, `find_savings`, `export_session` and `open_dashboard`. They run in the harness process (no MCP server is started) against the session files on this machine, so the agent can answer "what did this session cost?" itself. `open_dashboard` starts LoopPrism's local dashboard server in the background; the others only read.

Both parts come from the published [`loopprism`](https://www.npmjs.com/package/loopprism) npm package (this package depends on it), so the event mapping and the tool list are not copied.

## Install

```sh
dsh plugin --profile web add dsh-loopprism
# or straight from this repository:
dsh plugin --profile web add github:atlasmarkz/LoopPrism#path:/plugins/dsh-loopprism
```

It needs Node.js 22.15 or newer (DeepSeek Harness itself needs newer) and, for the live part, the [LoopPrism app](https://github.com/atlasmarkz/LoopPrism/releases) running (`npx loopprism ui` also works). The harness reads `dsh.bundle` in `package.json` and applies `cordis.patch.yml`, which adds one row, `loopprism`, to the profile.

## Configuration

All keys are optional. Set them on the `loopprism` row:

```yaml
- id: loopprism
  config:
    url: http://127.0.0.1:8080   # default: LOOPPRISM_URL, then ~/.loopprism/agent.json, then this
    live: true                    # false: do not send steps
    sendPrompts: true             # false: send the event but not the prompt text
    tools: true                   # false: do not register the review tools
```

Environment variables `LOOPPRISM_URL`, `LOOPPRISM_DISABLE=1` (send nothing), `LOOPPRISM_NO_PROMPTS=1`, `LOOPPRISM_HOOK_TIMEOUT_MS` (default 1000) and `LOOPPRISM_DEBUG=1` (print send problems to stderr) work as they do for LoopPrism's hooks.

## What leaves the process

Only to the LoopPrism URL (default `127.0.0.1`): session id, working directory, prompt text (unless `sendPrompts: false`), tool name, tool input and tool output (each clipped to 4000 characters by LoopPrism's event builder). Nothing else is sent anywhere. The review tools read session files under your home folder.

## Relation to `lpa install dsh`

`lpa install dsh --live` writes a hooks file for the harness's `dsh-hooks-claude-code` bridge. That route needs you to point the bridge at the file and only carries four Claude Code hook events. This plugin replaces it: no hooks file, tool failures included. Use one or the other, not both, or every step is sent twice.

## Develop

```sh
cd plugins/dsh-loopprism && node --test
```

The tests use a stand-in for the Cordis context and the LoopPrism code in this repository's `npm/` folder. They do not start the harness.
