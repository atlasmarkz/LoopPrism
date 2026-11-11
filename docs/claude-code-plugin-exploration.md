# Claude Code plugin: fit, fixes and listing path

Explored 2026-11-11 on branch `claude/explore-claude-code-plugin-d5129f` with Claude Code 2.1.321 (Windows 11, Node 20.12 on the machine).
Everything marked **verified** was run or read in this session; **unverified** is stated as such.

## 1. Current state (verified)

| Question | Result |
|---|---|
| Does `/plugin marketplace add atlasmarkz/LoopPrism` + `/plugin install loopprism@loopprism` work as the README says? | **Yes.** There already is a root `.claude-plugin/marketplace.json` (source `./npm/plugin`), on `main` too. Run with the CLI equivalents (`claude plugin marketplace add atlasmarkz/LoopPrism`, `claude plugin install loopprism@loopprism`) in an isolated `CLAUDE_CONFIG_DIR`: cloned, installed, enabled, 3 skills (`loopprism`, `open`, `status`), 6 hooks, 1 MCP server. The premise that the marketplace file was only under `npm/` was wrong: `npm/.claude-plugin/marketplace.json` is a second copy used by `npx loopprism install` and the desktop bundle. Both validate. |
| `claude plugin validate` | Plugin, root marketplace and `npm/` marketplace pass (`--strict`). Before the fixes the plugin had one directory-profile warning: `ICON_MISSING`. After: `--profile directory --strict` reports nothing. |
| MCP server health | `claude mcp list` → `plugin:loopprism:loopprism: npx -y loopprism@0.2.0 mcp - Connected` (Windows, so the `npx` `.cmd` shim is not a problem here; macOS/Linux not tested). |
| Token cost | `claude plugin details`: about 165 tokens always-on (skill descriptions), hooks cost nothing in context. |
| Versions | `npm/package.json`, `pyproject.toml`, `plugin.json`, both marketplace entries: all 0.2.0. `loopprism@0.2.0` is on npm (`latest`). (The desktop app is versioned separately, 0.7.0.) |

Note: this machine's own install (`~/.claude/plugins`, source `~/.loopprism/claude-marketplace`) is still 0.1.2. Nothing there was touched.

## 2. Problems found and what was changed

Fixed on this branch:

1. **No icon** (`ICON_MISSING` from the directory checks). Added `npm/plugin/assets/icon.png` (512×512, 160 KB, downsized from `desktop/build/icon.png`) and `"icon": "./assets/icon.png"`.
2. **Unpinned `npx -y loopprism mcp`** in `npm/plugin/.mcp.json`. The directory's pre-submission checklist says npx/uvx packages must be pinned to exact versions (`@latest` and ranges block). Now `loopprism@0.2.0`. The local validator does not check this; the portal does (per docs, **not run** by us). Side benefit: an installed plugin version always runs the matching package. `lpa install` still rewrites `.mcp.json` to the local copy when one exists, so that path is unchanged.
3. **Directory-read fields missing** in `plugin.json`: added `documentationUrl`, `supportUrl` (GitHub issues) and `privacyPolicyUrl` (the "What is sent, and where" section of the plugin README). The docs say Claude Code ignores these and only the directory reads them. `--strict` accepts them.
4. **Plugin README was stale and its privacy sentence was too broad.** It described only the hooks ("If LoopPrism is not running, the plugin does nothing") and claimed the plugin "never makes any other network request", while the plugin also ships a skill and an MCP server started through `npx` (which contacts the npm registry). README now describes both parts, the Node ≥ 22.15 requirement, and the offline behaviour, and says what the MCP server reads and sends.
5. **Nothing kept the manifests in sync.** Added `npm/test/plugin.test.js`: package version == `plugin.json` == both marketplace entries == the `.mcp.json` pin; both marketplace `source` paths resolve to a folder with `plugin.json`; the icon exists; every hook goes through `${CLAUDE_PLUGIN_ROOT}`. 3 tests pass.

Checked and judged fine (no change):

- **Hooks and session speed.** All hooks are `type: command`, `async: true` except `SessionEnd`. Docs (hooks reference): `timeout` is in seconds; `async` means "runs in the background without blocking"; a SessionEnd hook has a default 1.5 s budget and "plugin-provided timeouts do not raise it" (so the `2` in `hooks.json` is harmless, not effective). `hook.js` caps its HTTP call at 1 s, backs off 10 s after an unreachable server or two timeouts, always prints `{}` and exits 0. Measured: about 80 ms per hook invocation with the server unreachable (mostly Node start-up). One Node process per tool call is the real cost; it is off the critical path because the hooks are async.
- **Privacy text vs code.** Hook sends session id, cwd, model, prompt text (unless `LOOPPRISM_NO_PROMPTS=1`), tool name/input/result clipped to 4,000 chars, to `LOOPPRISM_URL` (default `http://127.0.0.1:8080`); `Stop` reads token numbers and model names from `transcript_path`. Matches the README. The only other `fetch` calls in `npm/` are the viewer (localhost), the dashboard health check (localhost), the optional AI endpoint and GitHub tool lookup in `core/optimize_extras.js`; neither is reachable from the MCP tools (`find_savings` calls `ins.optimize`, which does not use them; they are used by the desktop server only).
- **`commands/`**: docs say "Prefer `skills/` for new plugins"; `commands/` still loads (they show up as skills). Optional later cleanup.

## 3. Behaviour to know about (verified unless noted)

- **MCP cold start**: first run with an empty npm cache answered `initialize` in about 2.5 s; warm about 2 s (`npx` revalidates with the registry each time).
- **Offline**: with the registry unreachable, `npx -y loopprism@0.2.0 mcp` exits with `ECONNREFUSED` after about 1.5 s, even with the package in the cache and even with `--prefer-offline` (npm 10.5). Docs: a stdio server that fails to start does not stop the session; it is marked failed, `/mcp` can reconnect, and a failed stdio plugin server is skipped for 15 minutes. So offline users lose the MCP tools but not the session or hooks. `npx loopprism install` (local copy in `~/.loopprism/app`) is the offline-safe route.
- **Requirements the plugin does not declare**: `node` on `PATH` (hooks, commands) and Node ≥ 22.15 (`engines`). With Node 20 `npx` only prints `EBADENGINE` and the server still answered `initialize`; whether every tool works on 20 was **not tested**. A Claude Code user on the native installer may have no Node at all; a missing `node` makes each hook fail (non-blocking). There is no plugin manifest field for runtime requirements that we found (**unverified** that none exists).
- **Updates**: `plugin.json` has `version`, so users only get a new copy when it changes ("users keep the old copy" otherwise, per the publish docs). Edits under `npm/plugin` without a version bump never reach installed users. The marketplace `version` is redundant (plugin.json wins) but kept in sync by the new test.
- **Clone URL**: `marketplace add atlasmarkz/LoopPrism` cloned `git@github.com:atlasmarkz/LoopPrism.git` (SSH) on this machine, which has a key. Whether Claude Code falls back to HTTPS for users without SSH keys was **not tested**. The repo is public and MIT; the local `origin` remote is `AMark-CS/LoopPrism` (GitHub redirects; worth checking which name is canonical before submitting).

## 4. Ways to get listed

Verified from the docs and pages read (URLs in section 6):

1. **Self-hosted marketplace (what exists now).** "Once the file is in the repository, the plugin is published, with no submission form." Anthropic does not review third-party marketplaces. Users add it with `/plugin marketplace add atlasmarkz/LoopPrism`. Teams can pre-register it with `extraKnownMarketplaces` in `.claude/settings.json`; managed settings can allow-list it with `strictKnownMarketplaces`. Auto-update is off by default for third-party marketplaces.
2. **Anthropic plugin directory (claude.ai/directory, mirrored to the `claude-community` marketplace).** Submit through the developer portal `claude.ai/directory/manage` → Submit new → Plugin bundle (the old `clau.de/plugin-directory-submission` link redirects to the docs for this). Needs a paid claude.ai plan (Pro, Max, Ultra, Team, Enterprise; Owner on Team/Enterprise). The form asks for: the GitHub repo (`atlasmarkz/LoopPrism`), the plugin path (`npm/plugin`), optional branch/tag, then listing details read from `plugin.json` and the README; data-handling questions (reads/stores personal data? sends data to services other than declared ones? retention? for under-18s?); a contact email and four acknowledgements; and a publish mode (GitHub push webhook or scheduled check). Every version gets automated validation and a security scan; a person reviews a new listing; versions can be "held for a reviewer". The community mirror `anthropics/claude-plugins-community` says PRs are closed automatically; install is `claude plugin marketplace add anthropics/claude-plugins-community` then `claude plugin install loopprism@claude-community`.
3. **`claude-plugins-official`.** The official docs say it "doesn't take submissions through the directory portal" and point to Anthropic partner contacts; the repo README still points to the form. These two statements conflict and could not be reconciled from public pages. Do not open a PR against it for now.

Checklist from `pre-submission-checklist` and how LoopPrism stands:

| Requirement (per the checklist) | Status |
|---|---|
| `.claude-plugin/plugin.json`, kebab-case name not reserved, description/author/version | Done (`loopprism`) |
| README ≥ 40 words | Done, now describes all components |
| LICENSE in plugin folder or `license` field | Done (both) |
| Non-image files ≤ 256 KiB, ≤ 512 files | Done (largest source file `hook.js`/`usage.js`, a few KB) |
| npx/uvx pinned to an exact version | **Fixed** (`loopprism@0.2.0`) |
| No hardcoded credentials | Done (none) |
| Readable source (no minified/packed code) | Done. Note `opencode/loopprism.js` ships inside the plugin folder though Claude Code never uses it; explain it in the submission or move it out so the reviewer's scan does not read it as unrelated code (not done: `lpa install` and tests reference it) |
| Icon | **Fixed** (not stated as required by the checklist; the validator warns) |
| Undisclosed behaviour: "sending data elsewhere, running hidden code, changing permission settings" | Disclosed in README; hooks send prompts/tool I/O only to localhost by default, `LOOPPRISM_URL` can change that (documented) |

Release order that keeps the pin valid: publish `loopprism@X` to npm first, then push the version bump in `plugin.json`, both marketplace entries and `.mcp.json` (the new test fails if one is missed). Not done here by design: npm publish, push, submission.

## 5. One-sentence description (matches the code)

> Review what your coding agents did and cost: a skill and local MCP tools that read your session transcripts for cost, context use, loops and errors, plus optional hooks that stream live runs to the LoopPrism app on 127.0.0.1.

(The current manifest text says "plus live runs for the LoopPrism app"; it is accurate, the draft just makes the localhost and optional parts explicit.)

## 6. Sources

Read: code.claude.com/docs/en/ plugins, plugin-marketplaces, plugins-reference, discover-plugins, plugins/marketplace-reference, plugins/components, plugins/org, plugins/publish, plugins/loading, plugins/anthropic-marketplaces, hooks, mcp; claude.com/docs/plugins/submit, claude.com/docs/plugins/pre-submission-checklist, claude.com/docs/directory/publish; github.com/anthropics/claude-plugins-official and anthropics/claude-plugins-community (README); a local clone of `claude-plugins-official` in `~/.claude/plugins/marketplaces`.

**Not verified / not found**: the portal itself (`claude.ai/directory/manage` and `claude.ai/directory` were not opened; the latter returned 403); the text of the four acknowledgements; the Software Directory Terms and Policy; the portal's checks beyond the local `--profile directory` subset (the docs say a clean local run does not guarantee a clean portal validation); any icon or privacy-policy requirement (none found on the pages read); community aggregators or awesome lists (no web search was available); Windows `cmd /c` guidance for npx servers (none found in the docs; it works here without); macOS/Linux behaviour; HTTPS fallback of `marketplace add`.

## 7. Suggested next steps (owner's call)

1. Review and merge this branch; release `loopprism` to npm only when you want the next version, bumping all pins together.
2. Decide the canonical GitHub name (`atlasmarkz` vs `AMark-CS`) and whether to move or document `opencode/loopprism.js`.
3. Try the portal with `claude plugin validate npm/plugin --strict --profile directory` clean first; answer the data-handling questions from the README section "What is sent, and where".
4. Optional: declare the Node requirement in the README top line of the repo's Claude Code section; convert `commands/` to skills.
