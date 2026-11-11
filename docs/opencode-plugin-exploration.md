# Publishing LoopPrism as an OpenCode plugin: findings

Date of the checks: 2026-11-11. Prototype: [`opencode-plugin/`](../opencode-plugin) (package
`opencode-loopprism`, **not published**, nothing pushed).

Evidence levels used below: **Tested** (run on this machine), **Source** (read in the OpenCode
repo / npm tarballs, not run), **Unverified**.

## Short answer

Yes. LoopPrism can ship as a normal npm plugin that `opencode plugin add` installs. The prototype
does that, reuses the existing live-reporting logic, and registers the MCP server and the skill from
inside the plugin, so the install no longer has to edit `opencode.json`.

The more urgent finding: **the plugin LoopPrism ships today does not load on OpenCode 2.x.** On the
machine used here (OpenCode 2.0.32) the log says, on every start:

```
failed to load plugin  target=...\plugins\loopprism.js
PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function.
```

So `npx loopprism install` puts a file there that OpenCode 2.x skips; live OpenCode runs are not
reported for 2.x users. (**Tested**; the V2 loader code that produces this message is in
`packages/core/src/plugin/module.ts`, **Source**.)

## Which plugin API is "current"

| | OpenCode 1.x | OpenCode 2.x |
|---|---|---|
| npm CLI (`opencode-ai`) | `latest` = 1.19.5 (npm, 2026-11-09) | not on `opencode-ai`; the machine here has a 2.0.32 binary (`opencode v2.0.32`, channel `latest`) |
| Plugin SDK package | `@opencode-ai/plugin` 1.19.5 | `@opencode/plugin` 2.2.7 (npm, published 2026-11-10 by the OpenCode maintainer account) |
| Config key | `plugin` | `plugins` |
| Plugin shape | `export const X = async (input) => ({ hooks })` | `export default { id, setup(ctx) }` |
| Install command | `opencode plugin <npm-module>` ("install plugin and update config") | `opencode plugin add\|list\|check\|update\|remove` |

- The official docs site now labels **V2 "latest"** and shows V1 as "previous version"
  (opencode.ai/docs/plugins, /docs/build/plugins, `llms.txt` titled "OpenCode V2 Documentation").
  The earlier sub-agent report was about the V2 docs; it was accurate for V2, but V2 is not the
  only version in use: V1 (1.19.5) is still what `npm i opencode-ai` gives. **Both exist, and the
  plugin APIs are not interchangeable** (the V2 migration guide says "V1 plugin implementations do
  not run in V2"; confirmed by the load failure above).
- Docs describe a bridge: a default export carrying both `Plugin.define({id, setup})` fields and a
  V1 `server()` function; V1 >= 1.18.29 calls `server()`, V2 reads `id`/`setup()` and ignores
  `server()`. **Tested both ways** with the prototype (below).

## What was confirmed

**Tested on OpenCode 2.0.32** (isolated config/cache dirs, a local fake LoopPrism ingest endpoint, a
free `opencode-go` model, one small prompt each):

1. `opencode plugin add <spec>` installs a package into OpenCode's npm cache, appends it to
   `opencode.json` under `"plugins"`, and the plugin loads on the next start. Tested with a git
   spec served by a local `git daemon` (`git://127.0.0.1:.../repo#main`), which is the same install
   path as an npm name: dependencies (`loopprism`) were installed next to it.
   `git+file:///C:/...` failed with "unknown git error" on Windows; `git+git://` is rejected as not
   a package specifier. Neither says anything about npm-registry installs, which could not be tested
   before publishing.
2. After install, the plugin reported `prompt`, `tool` (with result and duration) and `stop` events to
   the endpoint, with model id and cwd.
3. The plugin registered the MCP server `loopprism` through `ctx.mcp.transform`; OpenCode logged
   `mcp connected server=loopprism tools=9`. No `opencode.json` edit was involved.
4. The plugin registered the skill through `ctx.skill.transform`: asking the model to list its skills
   showed `loopprism` with the plugin installed, and not without it (control run).
5. A plain `export default { id, setup }` object loads. **`@opencode/plugin` is not needed at
   runtime**: `Plugin.define()` is an identity helper, the loader only checks `id` + `setup`.
   (**Source** for the schema; **Tested** by running the prototype without that dependency.)
6. Event/hook payloads (V2), captured with a probe plugin:
   - `session.hook("prompt")`: `{ sessionID, messageID, prompt: { text, files }, delivery }`; no model.
   - `tool.hook("execute.before"/"execute.after")`: `{ tool, sessionID, id, input }`, after adds
     `status: "completed"|"error"` and `result.content[].text` / `error.message`.
   - `ctx.event.subscribe()` events carry the payload under `.data`. Turn end is
     `session.execution.succeeded|failed|interrupted` (**there was no `session.idle` event** in the
     capture; the V1 name does not apply). The model arrives on `session.step.started`
     (`data.model.id`).
7. **Tested on OpenCode 1.19.5** (npm `opencode-ai`, fully isolated XDG dirs, a local mock
   OpenAI-compatible server): the same default export, loaded via `"plugin": ["file:///.../src/index.js"]`,
   ran its `server()` hooks and reported prompt/tool/stop.
8. **Local plugin directory gotcha (V2)**: a directory under `plugins/` whose `package.json` has
   both `name` and `exports` was skipped **silently** (no log line); the same package works when
   installed through `plugin add`, and a directory without `name`/`exports` works with a root
   `index.js`. Reading `Host.resolve` (**Source**) it looks like self-referencing resolution does not
   work for a local directory. Only matters for `plugins/` drop-in use, not for `plugin add`.

**Source only**: V2 config accepts `{ "package": "...", "options": {...} }` entries; `ctx.options`
carries them. `ctx.mcp.transform` accepts `{ type: "local", command: [...] }` or `{ type: "remote", url }`.
Skills registered by a plugin need `id`, `name`, `path` (absolute) and `content`.

## Not verified

- Installing from the **npm registry** (`opencode plugin add opencode-loopprism`): the package is not
  published. Registry installs go through the same installer as the git spec that worked, but this
  exact command is untested.
- `opencode plugin add` writes `"plugins"` into the global config; whether it also handles
  `opencode.jsonc` (comments) correctly was not looked at. The one global config on this machine is
  JSONC; the test used an isolated, empty config dir.
- Whether `editor.get("loopprism")` sees an `mcp.loopprism` entry written by `npx loopprism install`
  in `opencode.json` (the dedupe in `index.js` assumes it does). Unit-tested with a fake context only.
- OpenCode Desktop (GUI) behaviour, the TUI, and `session.error`-style failures in a real run
  (`execution.failed` / `interrupted` payloads come from the type definitions, not from a capture).
- V1 `opencode plugin <module>` with the published package; V1 MCP/skill are not registered on the V1
  path (V1 has no equivalent API used here).
- In the V1 run the `model` field was empty on events; the old file had the same code, cause not
  investigated.
- Windows only. macOS/Linux not run.
- The size of `loopprism` as a dependency: `loopprism@0.2.0` unpacked is about 1 MB; each user's
  OpenCode installs it next to the plugin. It requires Node >= 22.15 for `lpa mcp`, which is spawned
  with the system `node`; a machine with an older/no `node` gets an MCP server that fails to start
  (the plugin does not check). Unverified how OpenCode surfaces that.

## The prototype

`opencode-plugin/`:

- `package.json`: name `opencode-loopprism` (free on npm, checked 2026-11-11), `type: module`,
  `exports: { ".": "./src/index.js" }`, `files: [src, README.md, LICENSE]`, one dependency (`loopprism`).
  `npm pack`: 5 files, 5.5 kB.
- `src/reporter.js`: the existing reporting code (clip, 1 s timeout, 10 s back-off), moved out of
  the hook so both APIs share it. Tool errors now go out as `tool_failure` (the old plugin sent
  `tool` with the output); the server's ingest route already accepts that event.
- `src/index.js`: default export `{ id, setup, server }` (V2 + V1).
- `test/plugin.test.js`: 7 tests (`npm test` in that folder): V2 with a fake context, V1 hooks,
  dedupe, back-off paths. All pass.

Not done on purpose: no change to `npm/` (the published `loopprism` package keeps its shape), no CI
publish job, no icon/screenshot assets.

## Relation to `npx loopprism install`

They overlap and, as written, they would **conflict or duplicate**:

| Situation | Result |
|---|---|
| OpenCode 2.x, old `plugins/loopprism.js` only | file does not load (logged warning); no live runs. MCP + skill from the install work. |
| OpenCode 2.x, old file + `opencode-loopprism` | harmless extra load-failure warning; plugin works. MCP: the plugin skips registering if `loopprism` already exists. |
| OpenCode 1.x, old file + `opencode-loopprism` | **both load: every event is reported twice.** |

Suggested change to `lpa install opencode` (not implemented here):

1. Read the OpenCode major version (`opencode --version`). On 2.x do not copy `loopprism.js`.
2. If `opencode-loopprism` is in `plugin`/`plugins` of the OpenCode config, skip the file, and skip
   writing `mcp.loopprism` and the skill (the plugin provides them); on uninstall, remove the old file
   if it is ours (it carries the `loopprism-opencode-plugin` marker).
3. Keep today's behaviour as the fallback when the user does not want a package (offline/no registry).
4. The desktop app's OpenCode toggle (it also copies the file, via the same `npm/lib/opencode.js`)
   needs the same rule.

## Submitting to the ecosystem lists

There is no marketplace; installation is by package name, so **publishing to npm is the actual
distribution step** and the lists below only add discoverability.

| Where | How | Requirements found | LoopPrism today |
|---|---|---|---|
| opencode.ai/docs/ecosystem | PR to the OpenCode docs repo ("Want to add your OpenCode related project to this list? Submit a PR") | name + one-line description; table lists npm names (e.g. `opencode-dynamic-context-pruning`) | Possible after publish. PR content and exact file not checked. |
| awesome-opencode (github.com/awesome-opencode/awesome-opencode) | PR adding `data/plugins/<name>.yaml` with `name`, `repo`, `tagline` (<= 120 chars), `description`, optional `min_version`; the description must say which OpenCode majors (V1/V2) are supported | public repo; not archived, commit in the last 90 days; **>= 25 stars and repo >= 30 days old**; unique; OpenCode setup docs present | `atlasmarkz/LoopPrism` has **5 stars** (created 2026-06-15): **does not meet the 25-star rule yet**. |
| opencode.cafe | submit form on the site (login method and fields not checked); categories include Plugins, MCP Servers, Hooks | not verified | The site currently shows 0 extensions. |

Info to prepare for any of them:

- npm name `opencode-loopprism`, repo `https://github.com/atlasmarkz/LoopPrism` (directory `opencode-plugin`), MIT, supports OpenCode 1.18.29+ (live runs) and 2.x (live runs + MCP + skill) on the evidence above.
- a screenshot of the LoopPrism dashboard with an OpenCode run (not produced here).
- the install snippet:
  `opencode plugin add opencode-loopprism` (2.x) / `"plugin": ["opencode-loopprism"]` (1.x).

Draft description (matches the code):

> Live runs for OpenCode in LoopPrism: reports your prompts, tool calls and the end of each turn to
> a local LoopPrism, and adds the LoopPrism MCP server and skill so you can ask what a session cost
> and where the tokens went. Local only; works with OpenCode 1.x and 2.x.

awesome-opencode tagline (<= 120 chars): `See what your OpenCode sessions cost and where they loop, in a local LoopPrism dashboard.` (89 chars)

## Next steps, in order

1. Decide the name and ownership (`opencode-loopprism` vs a scope) and publish `0.1.0`. Then run
   the real `opencode plugin add opencode-loopprism` on 2.x and the V1 `opencode plugin` route.
2. Fix `lpa install opencode` and the desktop toggle per the table above; it is a bug today on 2.x.
3. Re-test against the newest `@opencode/plugin` before publishing (the SDK moved from 2.0.16 to
   2.2.7 in the packages seen on this machine; the prototype uses only `session.hook("prompt")`,
   `tool.hook`, `event.subscribe`, `mcp.transform`, `skill.transform`).
4. Submit to the ecosystem page and opencode.cafe; wait for 25 stars for awesome-opencode.
