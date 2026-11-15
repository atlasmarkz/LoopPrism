# LoopPrism card in the OpenCode TUI sidebar: prototype

Date of the checks: 2026-11-15. Machine: Windows 11, OpenCode **2.0.32** (Bun 1.4.2 inside), Node 22.23.
Code: [`opencode-plugin/`](../opencode-plugin) (the `./tui` export) and
[`npm/core/adapters/opencode.js`](../npm/core/adapters/opencode.js). Local commits only; nothing pushed
or published.

Evidence levels: **Tested** (run here), **Source** (read in the published `@opencode/plugin@2.3.0` /
`@opencode/client` / `@opencode/theme` type packages, not run), **Unverified**.

## Result

It works on OpenCode 2.0.32. After `opencode plugin add` (from a local git server standing in for the
registry), the TUI loads the plugin and the right-hand sidebar shows a card. Captured from a headless
terminal (text of the screen, not a screenshot):

```
LoopPrism                          LoopPrism                          LoopPrism
$0.00  1 step                      $0.00  0 steps                     $1.74  151 steps
ctx 7.5k                           ctx n/a                            ctx 371k / ~128k
cache hit 0%                       cache n/a                          cache hit 93%
no loops or error streaks          ! 1 repeated call (worst 1064x)    ! 3 repeated calls (worst 6x)
```

The first two are from the sandbox (a one-word reply; a session where a free model read a file 1064
times in a row). The third is what `lpa show` returns for a real 151-step session, formatted by the
card code; it was **not** captured from the TUI.

**Rendering is verified only as text** (the screen text above, 150x45 terminal, via a pseudo-terminal
and a terminal emulator). Colours, the look on other themes and narrow terminals were **not
visually verified**.

## What was built

| Piece | File | Notes |
|---|---|---|
| TUI plugin | `opencode-plugin/src/tui.tsx` (source), `src/tui.js` (compiled, shipped) | `id: "loopprism.sidebar"`, claims `append: "sidebar.content"`. Draws the card lines only. |
| Card | `src/tui/card.js` | Pure: summary to lines with tones (title / base / muted / warn / error). |
| Refresh | `src/tui/controller.js` | Per root session: first read when the sidebar shows, again after a turn ends. Throttled. |
| Data | `src/tui/worker.js`, `client.js`, `summary.js` | A worker thread runs LoopPrism's `Inspector.summary()`; only a small object crosses to the TUI thread. |
| Package | `package.json` | `exports["./tui"] = "./src/tui.js"`; OpenTUI/Solid as optional peers. |
| 2.x reader | `npm/core/adapters/opencode.js` | **Needed for any data on OpenCode 2.x**, see below. |

### Card content

| Line | Source (`Inspector.summary`) |
|---|---|
| `$1.74  151 steps` | `cost.total_usd` (LoopPrism's price table first, else the cost OpenCode recorded); a `+` marks unpriced steps; sub-agent cost on its own line when present |
| `ctx 45k / 200k  23%` | `stats.current_context` of the last step against `stats.window`; a window LoopPrism only guessed is shown as `~200k`, and no percentage when the context already exceeds a guessed window |
| `cache hit 93%` | `stats.cache_hit_pct` |
| `! N repeated calls (worst Mx)` | findings `repeated_call` |
| `x N error streaks (longest M)` | findings `error_streak` |
| `~ compacted Nx` | findings `compaction` |
| `no loops or error streaks` | none of the above |
| `no data for this session yet` and other one-liners | the session is not in the database yet, `loopprism` missing, `node:sqlite` missing, worker failed |

Prices are not recomputed in the plugin.

### How it refreshes (and stays cheap)

- Events used (**Tested** that the first two fire; the payload `data.sessionID` is from the **Source** types):
  `session.execution.succeeded | failed | interrupted` and `session.compaction.ended`, via
  `ctx.data.on(type, handler)`. Not used while the model streams.
- After an event the controller waits 800 ms (OpenCode writes the turn to its database around then), then reads.
  At most one read per session every 5 s; requests during a read collapse into one follow-up read.
- The read runs in a `worker_threads` worker (**Tested** inside OpenCode's Bun: 1.1 s for the first read of a
  76-session database including the index build, then the index makes it incremental). Reading inline on the
  TUI thread was not pursued (a direct `require` of LoopPrism's CJS entry failed in Bun with "async module
  unsupported").
- A sub-agent's session maps to its root session (`ctx.data.session.root`), because LoopPrism lists sub-agents
  inside the root session.
- State is `ctx.storage.memory(...)`, a Solid store the render reads reactively, so the plugin does not import
  `solid-js` for state.
- Failure keeps the last good card; with nothing to show it prints one quiet line.

## Things found on the way (they change the plan)

1. **LoopPrism could not read OpenCode 2.x sessions at all.** Its adapter read the 1.x tables
   (`session`, `message`, `part`); OpenCode 2.x writes `session_v2` and `session_message` (the real
   database here has 76 sessions and 4476 messages there and no `session` table). `lpa sessions --agent
   opencode` and the MCP tools would show nothing for 2.x. Commit `c2b378e` adds a reader: each assistant
   message is one model call with `tokens`, `cost` and a `content` list of reasoning / text / tool items;
   `compaction` messages (only completed ones count). A database upgraded from 1.x holds both layouts and both
   are read. Checked by hand against the real database (151-step session: $1.744425, three repeated-call
   findings, 0.6 s) and by `npm/test/opencode_v2.test.js`. **The published `loopprism@0.2.0` does not have
   this**: Tested with the installed package, the card says `no data for this session yet` for a 2.x session until
   a `loopprism` release containing the adapter is published (the plugin's `loopprism` dependency range must then be raised to it; not done here).
2. **A TUI package must ship compiled JavaScript.** The same `tui.tsx` loads from a folder
   (`<config>/plugins/<name>/`) with no build step, but when it is installed as a package under `node_modules`
   OpenCode 2.0.32 does not apply the Solid JSX transform: `Cannot find package 'react'`. So `scripts/build-tui.cjs`
   (Babel, `babel-preset-solid` with `moduleName: "@opentui/solid"`, `generate: "universal"`) compiles it to
   `src/tui.js`, which only imports `@opentui/solid` and `solid-js`. **Tested**: that compiled file loads
   from the installed package and renders **without** installing those two packages (OpenCode resolves them
   itself), so they are only optional peers. Installing them next to the plugin would add about 28 MB
   (`@opentui/core` + its Windows binary) for nothing. `src/tui.js` is committed and a test fails if it is
   stale. The docs' example has non-optional peers; that was not needed here.
3. **OpenCode's installer rejects git packages with a `build`/`prepack` script or `devDependencies`**
   (`git dep preparation failed`, **Tested** by elimination). So there is no such script or dependency in
   `package.json`; the build tools are installed on demand (see the comment in the build script). Registry
   installs are not "prepared", so this matters for git specs only.
4. **Config location.** A `cli.json` with a `file:///...` entry in `OPENCODE_CONFIG_DIR` did **not** load the
   plugin in this test (cause not found). Loading worked from `<config>/plugins/<name>/tui.(js|tsx)` and from
   `opencode plugin add`, which wrote `"plugins": [...]` to `opencode.json`; the TUI part of the package
   loaded from there with no `cli.json`. Whether TUI-only packages need `cli.json` (as the docs say) was not
   tested with a TUI-only package.
5. `opencode plugin add` accepts only npm or git specifiers (a `file:` tarball is rejected), and the default
   managed service uses a fixed port that the real service here already holds, so isolated runs use
   `opencode --standalone`.

## Install

When `opencode-loopprism` (with this TUI part) and a `loopprism` release with the 2.x reader are published:

```bash
opencode plugin add opencode-loopprism
```

Restart OpenCode and open any session; the card is at the end of the sidebar content. Node 22.15 or newer
must be OpenCode's runtime for `node:sqlite`; inside OpenCode's own Bun it was available (Tested), so no
system Node is needed for the card (the MCP server still spawns `node`).
Until then, for trying it from a checkout: copy `opencode-plugin/src/tui.tsx` and `src/tui/` into
`<opencode config>/plugins/loopprism-sidebar/` and set `LOOPPRISM_API` to
`<checkout>/npm/core/api.js` (that is how the numbers above were produced; `LOOPPRISM_INDEX` moves the index).

Reads are local only: OpenCode's database is opened read-only; the LoopPrism index lives in
`~/.loopprism/` (shared with the `lpa` CLI). Nothing is sent anywhere, and no running LoopPrism is needed.

## Tests

- `opencode-plugin/test/tui.test.js`, 22 tests, Node 22: card formatting; controller with a fake TUI context
  and fake timers (first read once, turn-end refresh with settle delay, throttle, trailing read, root
  session, quiet failure, last-good-card, dispose); client with a fake worker (crash, timeout); package
  shape; compiled file is JSX-free and current; **the real worker and the real `Inspector` on a generated 2.x
  database** (skipped when the checkout's `npm/` is not next to the package).
- `npm/test/opencode_v2.test.js`: discovery, parse, findings, mixed 1.x/2.x database.
- Whole `npm/` suite: 67 pass, 0 fail.
- `opencode-plugin/test/plugin.test.js` (the earlier prototype): 6 of 7 pass on **Node 22**; the one failure is an
  event-order assertion (`tool` vs `tool_failure` arrive in a different order) that passes on Node 20. It was not
  touched here; it looks like a race between unawaited posts in the test, **not investigated**.
- Live: OpenCode 2.0.32 with `XDG_*` and `OPENCODE_CONFIG_DIR` in a temp folder (the real configuration and the
  real service were not touched): plugin loads, no plugin errors in the log, card renders, card refreshes
  after a turn, MCP server connects (`loopprism  Connected`), also from the package installed with `plugin add`.

## Not verified

- Colours and layout on a real display; light themes; very narrow terminals; long model/cost values.
- The registry install path (`opencode plugin add opencode-loopprism`): not published. The git install was
  Tested; the loader path for a registry package is the same installer but not run.
- `cli.json` for a TUI-only package (see finding 4); OpenCode 1.x has no TUI plugin here (the card is 2.x only).
- macOS and Linux (the database path logic is `XDG_DATA_HOME` or `~/.local/share`; on Windows it was
  `~/.local/share` here).
- `session.compaction.ended` and the `interrupted`/`failed` events were wired from the types and not triggered
  in a live run; `succeeded` was.
- Context windows: the free model used here has no window in LoopPrism's table, so the card shows `ctx 7.5k`
  without a percentage while OpenCode's own Context block shows 3%. The numbers agree (7.5k vs 7,488 tokens).
  Using OpenCode's model info for the window (`ctx.data.location.model.list()`) is an obvious next step,
  **not tried**.
- A busy machine with thousands of sessions: the first read builds the index (13 s once for the 76-session
  database through the CLI; the worker kept the TUI responsive in the one-session tests, not measured at scale).

## Size and dependencies

- `npm pack` of `opencode-loopprism`: **10.6 kB, 11 files** (was 5.5 kB, 5 files). No new runtime
  dependency: `loopprism` was already the only one (about 1.2 MB unpacked, installed next to the plugin).
- Three optional peer dependencies are declared (`@opentui/core`, `@opentui/solid`, `solid-js`) so the types
  and the docs' convention are respected, but npm does not install optional peers.
- Build tools (Babel, three packages) are needed only to regenerate `src/tui.js`; they are not in
  `package.json`.
- Runtime cost: a worker thread (created on the first card, `unref`'d, closed on unload) and the LoopPrism index.

## Desktop (GUI, experimental): how it could follow

Not built. From the types only (**Source**, `@opencode/plugin@2.3.0`, `./gui`): the GUI plugin API has a
`Panel` registration (tabs in a session's side region; `render(props)` returns JSX, `PanelTab`, `PanelProps` with
the session, narrow-screen view), a `session.panel` menu item for the "+" menu, a `session.panel.end` slot,
file/review/browser helpers (`./gui/file`, `./gui/review`, `./gui/browser`), and a Vite plugin entry (`./gui/vite`).
None of it was run.

Plan if the owner wants it:

1. Reuse everything below the JSX: the same `summary` object and refresh rules, produced by a Node-side reader.
   In the desktop app the GUI runs in Electron's renderer, so the reader would be the host side or the
   already-running LoopPrism service (`lpa ui` / the desktop app's local API) rather than a worker started by the
   plugin; the data must stay local.
2. Add a `Panel` with a card (same lines) and, optionally, a "Open in LoopPrism" action that opens the existing
   dashboard at `127.0.0.1:8765` (or the session URL) through `./gui/browser`, which would give the full charts
   that the TUI cannot show. Whether the GUI can embed a web page in a panel was not checked.
3. Keep the TUI and GUI parts in one package (`./tui` and `./gui` exports) as the docs describe, since the
   server part is separate anyway.
4. Because the GUI is marked experimental, expect API churn; pin to an `@opencode/plugin` version and test on
   the desktop build before promising it.

## Next steps

1. Release `loopprism` with the 2.x reader, raise the dependency range, publish `opencode-loopprism`, then run the
   real `opencode plugin add opencode-loopprism`.
2. Fix `lpa install opencode` / the desktop toggle for 2.x (see `docs/opencode-plugin-exploration.md`).
3. Window from OpenCode's model info; look at the card on real themes; try `session.compaction.ended` live.
4. Look into the Node 22 ordering failure in `plugin.test.js`.
