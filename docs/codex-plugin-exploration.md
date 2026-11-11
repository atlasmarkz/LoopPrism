# Distributing LoopPrism for Codex: what exists, what was missing

Explored on Windows 11 with Codex CLI **0.156.1** (`codex doctor` also reports 0.167.1 available),
on 2026-11-11. Everything marked **verified** was run against that CLI with a throwaway
`CODEX_HOME` (the real `~/.codex` was only read). Everything marked **docs** comes from OpenAI's
published pages and was not run. **Unverified** says so.

## 1. Codex's extension system today

Codex has a Claude-Code-style plugin and marketplace system.

| Piece | What it is | Status |
|---|---|---|
| Plugin manifest | `.codex-plugin/plugin.json` (compat form) or a root `plugin.json` with an `extensions.com.openai` block. Fields: `name`, `version`, `description`, `author`, `skills`, `hooks`, `mcpServers`, `interface{displayName, shortDescription, longDescription, category, capabilities, defaultPrompt, ...}` | verified (third-party `ponytail` and OpenAI's bundled plugins use the compat form); docs |
| Skills in a plugin | `skills/<name>/SKILL.md`, declared by `"skills": "./skills/"` | verified |
| MCP in a plugin | `.mcp.json` (`mcpServers`), declared by `"mcpServers": "./.mcp.json"` | verified: `codex mcp list` shows it |
| Hooks in a plugin | `"hooks": "./hooks/<file>.json"`; default `hooks/hooks.json` | verified |
| Marketplace | `.agents/plugins/marketplace.json` at a repo root (also `~/.agents/plugins/...`). Entries: `name`, `source`, `policy{installation,authentication}`, `category`. Sources: `local`, `url`, `git-subdir`, `npm` (docs). The legacy `.claude-plugin/marketplace.json` is read too | verified for `local`; the file order verified (`.agents` wins); `url`/`git-subdir`/`npm` docs only |
| Commands | `codex plugin marketplace add <path \| owner/repo[@ref] \| git URL> [--ref] [--sparse]`, `... marketplace list/upgrade/remove`, `codex plugin add <plugin>@<marketplace>`, `codex plugin list`, `codex plugin remove` | verified in 0.156.1 (the public docs page only mentions `/plugins`; the CLI has more) |
| Where installs go | `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`; `config.toml` gets `[marketplaces.<name>]` and `[plugins."<plugin>@<marketplace>"] enabled = true` | verified |
| Skills outside plugins | `$CODEX_HOME/skills/<name>/SKILL.md` (scope `user`) and `~/.agents/skills` | verified via the app-server `skills/list` |
| MCP outside plugins | `[mcp_servers.<name>]` in `config.toml` (`command`, `args`, `env`, `startup_timeout_sec`, ...) or `codex mcp add <name> -- <cmd>` | docs; the table form is what `lpa install` writes |
| Hooks outside plugins | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or `[[hooks.<Event>]]` in `config.toml` | verified for `~/.codex/hooks.json` |
| Hook events | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, PreCompact, PostCompact, SubagentStart, SubagentStop, PreModelRequest, PostModelRequest, Interrupt. **No PostToolUseFailure.** | docs |
| Hook env | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` (and `CLAUDE_PLUGIN_ROOT/DATA` aliases) are expanded in plugin hook commands. `CODEX_HOME` is not defined for hooks | verified expansion of both aliases; the rest docs |
| Hook trust | New or changed hooks are `trustStatus: "untrusted"` and skipped until reviewed with `/hooks`. This applies to `hooks.json` hooks and to plugin hooks alike. `--dangerously-bypass-hook-trust` exists | verified status via app-server `hooks/list`; the review UI itself not driven |
| Third-party distribution | A Git repo (or local folder) is a marketplace: `codex plugin marketplace add owner/repo`. `ponytail` is installed this way on this machine. OpenAI's public directory goes through a "plugin submission portal"; per the docs, plugins that ship lifecycle hooks are not eligible for it | marketplace add: verified with a local path, and by `ponytail` (git) already present; portal rules: docs, **page not read, unverified** |
| App-server protocol | `plugin/install`, `plugin/list`, `hooks/list`, `skills/list`, ... (`codex app-server generate-json-schema`) | verified |

Not found / unverified: how the Codex **desktop app** surfaces a git marketplace (the docs say it
picks up CLI-installed plugins after a restart); whether `source: "npm"` marketplace entries work in
0.156.1; a way to pre-trust hooks other than `/hooks`.

## 2. Gaps in the existing adaptation

Found by running the current code against 0.156.1 and against this machine's 255 Codex rollouts.

| # | Gap | Evidence | Status |
|---|---|---|---|
| 1 | **Compressed rollouts were invisible.** Codex stores finished rollouts as `rollout-*.jsonl.zst` (under `sessions/` too, not only `archived_sessions/`). `discover()` only matched `.jsonl`: 20 of 255 sessions were visible. | `find ~/.codex/sessions -name '*.zst'` → 235 | **fixed** (`zlib.zstdDecompressSync`, Node 22.15+ = the package's `engines`) |
| 2 | App-injected user messages counted as prompts and became session titles (`<recommended_plugins>`, `<codex_internal_context>`, `<external_codex_apps_*>`, `<in-app-browser-context>`, `<heartbeat>`, `<send_user_message_*>`). | `lpa sessions` showed `<recommended_plugins>` as titles | **fixed** (context prefixes) |
| 3 | Codex's own threads looked like user sessions: 185 auto-review threads (`thread_source: guardian_review`) and spawned agents (`source.subagent.thread_spawn`) listed with a boilerplate title ("The following is the Codex agent history", 89 times). | session_meta of the `.zst` files | **mitigated**: titled `Auto-review: ...` / `Subagent <nickname>: ...`. They are still separate rows; their cost is real and stays in totals |
| 4 | **The Claude Code plugin already installs into Codex, but wrongly.** Codex reads the root `.claude-plugin/marketplace.json` and installs `npm/plugin`; its `hooks/hooks.json` loads with `--agent claude-code`, so Codex runs are recorded as Claude Code, and `PostToolUseFailure` is dropped. | `hooks/list` before the change | **fixed** by a Codex manifest pointing at `hooks/codex-hooks.json` (`--agent codex`) |
| 5 | `lpa install` plus the plugin would register the skill, the MCP server and the hooks twice. | design | **fixed**: `lpa install` skips Codex when `[plugins."loopprism@..."]` is enabled. Not handled: someone who ran `lpa install` first and the plugin second still has both; `lpa uninstall codex` removes the old one |
| 6 | Resume / move-to-trash refused `.jsonl.zst` files. | `core/actions.js` | **fixed** |
| 7 | **Codex agent trees** (`README`: "not read yet"). | data below | **not done**, see section 4 |
| 8 | Python core (`src/loopprism/sessions/codex.py`) has gaps 1-3 too. | not inspected line by line | **not done**; needs `zstandard` or Python 3.14 `compression.zstd` |
| 9 | Session titles for prompts that start with `# Files mentioned by the user:` or `<image name=...>` show that header (the real prompt follows in the same message). | `lpa sessions` | not done, cosmetic |

Checked and fine: `CODEX_HOME` is honoured by the adapter, `lib/paths.js`, the installer and
`usage.js`; Windows paths in hook commands (quoted `node "C:\...\hook.js"`) are accepted; the
current rollout format (`session_meta`, `turn_context`, `token_usage_record`, `response_item`,
paged histories) parses, and `usage.js` prices a real 0.156.1 turn from `transcript_path`
(5 calls, 23k input, 132k cached, 968 output). `SessionEnd` exists and runs synchronously, as the
installer assumes.

## 3. What was built (this branch)

- `npm/plugin/.codex-plugin/plugin.json`: Codex manifest (skills, MCP, Codex-only hooks, `interface`).
- `npm/plugin/hooks/codex-hooks.json`: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd;
  `node "${PLUGIN_ROOT}/scripts/hook.js" --agent codex`. Claude Code ignores both new files.
- `.agents/plugins/marketplace.json` at the repo root: `local` source `./npm/plugin`.
  All three are additions; nothing in the published `npm/` layout moved.
- `lib/codex.js#pluginEnabled` and the guard in `bin/lpa.js`.
- Adapter fixes 1, 2, 3, 6 and tests: `test/codex.test.js`, `test/codexplugin.test.js`
  (manifest/marketplace/hook consistency, version sync), `test/installers.test.js`.
- `node --test` in `npm/`: 72 pass, 3 skipped (the existing skips), 0 fail (Node 22.23).

How it was tested: `CODEX_HOME=<tmp> codex plugin marketplace add <worktree>`, `codex plugin add
loopprism@loopprism`, then `hooks/list`, `skills/list` and `codex mcp list` against the temp home
(via `codex app-server`). Result: five hooks from `hooks/codex-hooks.json`, tagged `--agent codex`,
`source: plugin`, `trustStatus: untrusted`; the MCP server is listed; the installed copy runs a
simulated PostToolUse/SessionEnd payload into a local mock of `/api/ingest/events` and arrives
as `agent: "codex"`.

**Not verified: a real Codex session firing the hooks.** That needs the account's auth in the
throwaway home plus `--dangerously-bypass-hook-trust` (or a human typing `/hooks`); the harness
declined the bypass, so I did not. Also unverified: the first `npx -y loopprism mcp` start against
the 10 s default `startup_timeout_sec` (the legacy installer avoids npx by pointing at
`~/.loopprism/app`); `codex plugin marketplace add atlasmarkz/LoopPrism` from GitHub (nothing was
pushed); macOS/Linux; the desktop app.

## 4. Can the agent tree be read?

Yes, the data is there, but it is a feature rather than a fix.

- Spawned agents are separate rollouts. Their `session_meta.payload.source` is
  `{"subagent":{"thread_spawn":{"parent_thread_id","depth","agent_nickname",...}}}` with
  `thread_source: "subagent"`; 16 such files for 3 parent sessions here. The parent shows
  `collaboration.spawn_agent` / `wait_agent` / `send_message` calls and `agent_message` items
  (author `/root/<task>`); message bodies are `encrypted_content`.
- So the tree is a join on `parent_thread_id`, not a new parser. The existing tree builder
  (`core/agents.js`) assumes Claude Code's `<session>/subagents/` folder; it needs a second source.
- `session_meta.multi_agent_version` and `token_usage_record.root_turn_id` also exist; in the one
  large multi-agent session `root_turn_id` always equalled `turn_id`, so the adapter's `sidechain`
  flag never fires for Codex.
- Auto-review (`guardian`) threads are not part of that tree and arguably should be hidden or
  folded into the parent's cost.

## 5. Recommended distribution

1. **Primary: the Codex plugin from this repo.** Users run
   `codex plugin marketplace add atlasmarkz/LoopPrism` and `codex plugin add loopprism@loopprism`;
   it needs no edits to the user's `config.toml` or `hooks.json` by LoopPrism (Codex writes its own
   plugin entries), upgrades with `codex plugin marketplace upgrade`, removes with
   `codex plugin remove loopprism`. Hooks still need one `/hooks` review. Hooks mean it cannot go in
   OpenAI's public directory (docs, unverified), so the self-hosted marketplace is the route.
2. **Keep `npx loopprism install codex`** for people without a Codex CLI on PATH, older Codex, or
   who want the npx-free `~/.loopprism/app` launcher. It now defers to the plugin when present.
3. **Follow-up worth doing:** make `lpa install codex` drive `codex plugin marketplace add` +
   `plugin add` the way `lib/claude.js` drives `claude plugin ...`, with a rewritten `.mcp.json`
   pointing at `~/.loopprism/app` (avoids the npx cold start), and fall back to the current
   file-editing path if `codex plugin` is missing. Then the desktop app and the CLI share one path.

## 6. One-line description (matches the code)

> LoopPrism for Codex: a skill and MCP tools that read the session files Codex already keeps on
> your machine, including its compressed rollouts, to show what a session cost, what filled its
> context window and where it looped; optional hooks also stream live runs to the LoopPrism app.

Avoid claiming: agent trees for Codex, hooks verified in a live session, or a listing in OpenAI's
directory.
