// Tests for the TUI sidebar card: pure card formatting, the refresh controller with a fake TUI context,
// the worker client with a fake worker, and (when a LoopPrism checkout is next to this package) the real
// worker reading an OpenCode 2.x database.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCard, emptyCard, contextLine, usd, tok } from "../src/tui/card.js";
import { slim } from "../src/tui/summary.js";
import { createController, REFRESH_EVENTS } from "../src/tui/controller.js";
import { createClient } from "../src/tui/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const texts = (card) => card.lines.map((l) => l.text);

const base = { steps: 12, costUsd: 1.744, subagentUsd: null, unpricedSteps: 0, context: 45_000, window: 200_000, windowSource: "reported", cachePct: 93.3, findings: [] };

// ---------------------------------------------------------------- card

test("number formats", () => {
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(1.744), "$1.74");
  assert.equal(usd(null), "n/a");
  assert.equal(tok(999), "999");
  assert.equal(tok(7488), "7.5k");
  assert.equal(tok(371325), "371k");
  assert.equal(tok(1_250_000), "1.3M");
});

test("a quiet session: cost, context, cache and one calm line", () => {
  assert.deepEqual(texts(buildCard(base)), ["LoopPrism", "$1.74  12 steps", "ctx 45k / 200k  23%", "cache hit 93%", "no loops or error streaks"]);
});

test("findings get one line per kind", () => {
  const card = buildCard({
    ...base,
    findings: [
      { kind: "repeated_call", count: 3, worst: 6 },
      { kind: "error_streak", count: 1, worst: 5 },
      { kind: "compaction", count: 2, worst: 1 },
    ],
  });
  const t = texts(card);
  assert.ok(t.includes("! 3 repeated calls (worst 6x)"));
  assert.ok(t.includes("x 1 error streak (longest 5)"));
  assert.ok(t.includes("~ compacted 2x"));
  assert.ok(!t.includes("no loops or error streaks"));
  assert.equal(card.lines.find((l) => l.text.startsWith("x ")).tone, "error");
  assert.equal(card.lines.find((l) => l.text.startsWith("!")).tone, "warn");
});

test("context: a guessed window is marked, and not shown as a percentage when it is already exceeded", () => {
  assert.equal(contextLine({ ...base, windowSource: "assumed" }).text, "ctx 45k / ~200k  23%");
  assert.equal(contextLine({ ...base, context: 371_325, window: 128_000, windowSource: "assumed" }).text, "ctx 371k / ~128k");
  assert.equal(contextLine({ ...base, window: null }).text, "ctx 45k");
  assert.equal(contextLine({ ...base, context: 0 }).text, "ctx n/a");
  assert.equal(contextLine({ ...base, context: 190_000 }).tone, "warn");
});

test("cost: sub-agents and unpriced steps are visible", () => {
  const t = texts(buildCard({ ...base, subagentUsd: 0.3, unpricedSteps: 2, steps: 1 }));
  assert.equal(t[1], "$1.74+  1 step");
  assert.equal(t[2], "+ $0.30 subagents");
});

test("empty cards are one quiet line under the title", () => {
  assert.deepEqual(texts(emptyCard("not_found")), ["LoopPrism", "no data for this session yet"]);
  assert.equal(emptyCard("not_found").state, "empty");
  assert.equal(emptyCard("sqlite").state, "error");
  assert.deepEqual(texts(emptyCard(null, true)), ["LoopPrism", "reading session..."]);
});

test("slim keeps only what the card needs and groups findings", () => {
  const s = slim({
    session: { id: "ses_1" },
    stats: { steps: 3, cost_usd: 0.1, current_context: 10, window: 100, window_source: "assumed", cache_hit_pct: 50, models: ["m"] },
    cost: { total_usd: 0.12, subagent_usd: null, unpriced_steps: 0, by_type: { big: 1 } },
    findings: [
      { kind: "repeated_call", title: "a 3x", events: [1, 2, 3] },
      { kind: "repeated_call", title: "b 5x", events: [1, 2, 3, 4, 5] },
      { kind: "compaction", title: "c", events: [9] },
    ],
  });
  assert.equal(s.costUsd, 0.12);
  assert.equal(s.windowSource, "assumed");
  assert.deepEqual(s.findings.find((f) => f.kind === "repeated_call"), { kind: "repeated_call", count: 2, worst: 5, worstTitle: "b 5x" });
  assert.equal("cost" in s, false);
});

// ---------------------------------------------------------------- controller

/** A TUI context with just what the controller uses; timers and the clock are driven by the test. */
function fake({ roots = {}, results = [] } = {}) {
  const handlers = new Map();
  const cards = { cards: {} };
  const unsub = [];
  const ctx = {
    storage: { memory: () => [cards, (fn) => fn(cards)] },
    data: {
      on(type, h) {
        handlers.set(type, h);
        return () => unsub.push(type);
      },
      session: { root: (id) => roots[id] || id },
    },
  };
  const calls = [];
  const queue = [...results];
  const client = {
    closed: false,
    summary: async (id) => {
      calls.push(id);
      return queue.length ? queue.shift() : { ok: false, code: "not_found" };
    },
    close() {
      this.closed = true;
    },
  };
  const timers = [];
  let t = 1_000_000;
  const clock = {
    setTimer: (fn, wait) => {
      const h = { fn, wait, cleared: false };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => (h.cleared = true),
    now: () => t,
  };
  const fire = async () => {
    const h = timers.find((x) => !x.cleared && !x.fired);
    assert.ok(h, "a timer is pending");
    h.fired = true;
    h.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { ctx, handlers, cards, client, calls, timers, clock, fire, advance: (ms) => (t += ms), unsub };
}

const ok = (steps) => ({ ok: true, summary: { ...base, steps } });

test("the first render asks for one read, later renders do not", async () => {
  const f = fake({ results: [ok(5)] });
  const c = createController(f.ctx, { client: f.client, ...f.clock });
  assert.equal(c.card("s1").state, "loading");
  c.ensure("s1");
  c.ensure("s1");
  assert.equal(f.timers.length, 1);
  await f.fire();
  assert.deepEqual(f.calls, ["s1"]);
  assert.equal(c.card("s1").state, "ready");
  assert.equal(texts(c.card("s1"))[1], "$1.74  5 steps");
  c.dispose();
});

test("a finished turn refreshes the card after a short settle delay", async () => {
  const f = fake({ results: [ok(1), ok(2)] });
  const c = createController(f.ctx, { client: f.client, settleMs: 800, ...f.clock });
  assert.deepEqual([...f.handlers.keys()].sort(), [...REFRESH_EVENTS].sort());
  c.ensure("s1");
  await f.fire();
  f.advance(10_000);
  f.handlers.get("session.execution.succeeded")({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
  const pending = f.timers.filter((x) => !x.cleared && !x.fired);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].wait, 800);
  await f.fire();
  assert.equal(texts(c.card("s1"))[1], "$1.74  2 steps");
});

test("throttle: a burst of turn ends becomes one trailing read at least throttleMs after the last", async () => {
  const f = fake({ results: [ok(1), ok(2)] });
  const c = createController(f.ctx, { client: f.client, throttleMs: 5_000, settleMs: 100, ...f.clock });
  c.ensure("s1");
  await f.fire();
  f.advance(1_000); // one second after the last read
  const end = f.handlers.get("session.execution.interrupted");
  end({ data: { sessionID: "s1" } });
  end({ data: { sessionID: "s1" } });
  end({ data: { sessionID: "s1" } });
  const pending = f.timers.filter((x) => !x.cleared && !x.fired);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].wait, 4_000);
  await f.fire();
  assert.equal(f.calls.length, 2);
});

test("a request during a read is folded into one follow-up read", async () => {
  const f = fake();
  let release;
  f.client.summary = (id) => {
    f.calls.push(id);
    return new Promise((r) => (release = r));
  };
  const c = createController(f.ctx, { client: f.client, throttleMs: 0, ...f.clock });
  c.ensure("s1");
  await f.fire();
  c.request("s1");
  c.request("s1");
  assert.equal(f.timers.filter((x) => !x.cleared && !x.fired).length, 0, "nothing is scheduled while a read runs");
  release({ ok: true, summary: base });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.timers.filter((x) => !x.cleared && !x.fired).length, 1, "one follow-up read");
});

test("a sub-agent session shows the card of its root session", async () => {
  const f = fake({ roots: { child: "root" }, results: [ok(7)] });
  const c = createController(f.ctx, { client: f.client, ...f.clock });
  c.ensure("child");
  await f.fire();
  assert.deepEqual(f.calls, ["root"]);
  assert.equal(c.card("child"), c.card("root"));
  c.ensure("root"); // already read: no second read
  assert.equal(f.timers.filter((x) => !x.cleared && !x.fired).length, 0);
});

test("no data is a quiet line; a transient failure keeps the last good card", async () => {
  const f = fake({ results: [{ ok: false, code: "not_found" }, ok(3), { ok: false, code: "worker" }] });
  const c = createController(f.ctx, { client: f.client, throttleMs: 0, settleMs: 0, ...f.clock });
  c.ensure("s1");
  await f.fire();
  assert.deepEqual(texts(c.card("s1")), ["LoopPrism", "no data for this session yet"]);
  c.request("s1");
  await f.fire();
  assert.equal(c.card("s1").state, "ready");
  c.request("s1");
  await f.fire();
  assert.equal(c.card("s1").state, "ready", "worker failure does not blank the card");
  assert.equal(f.calls.length, 3);
});

test("a failure with nothing to show says so once, quietly", async () => {
  const f = fake({ results: [{ ok: false, code: "sqlite" }] });
  const c = createController(f.ctx, { client: f.client, ...f.clock });
  c.ensure("s1");
  await f.fire();
  assert.deepEqual(texts(c.card("s1")), ["LoopPrism", "needs Node 22+ (node:sqlite)"]);
});

test("dispose unsubscribes, cancels timers and closes the client", async () => {
  const f = fake({ results: [ok(1)] });
  const c = createController(f.ctx, { client: f.client, ...f.clock });
  c.ensure("s1");
  c.dispose();
  assert.equal(f.unsub.length, REFRESH_EVENTS.length);
  assert.ok(f.timers.every((x) => x.cleared));
  assert.equal(f.client.closed, true);
  c.request("s1");
  assert.equal(f.timers.length, 1, "nothing scheduled after dispose");
});

// ---------------------------------------------------------------- client

function fakeWorker(onMessage) {
  const w = new EventEmitter();
  w.terminated = false;
  w.postMessage = (m) => setImmediate(() => onMessage(m, w));
  w.terminate = () => (w.terminated = true);
  return w;
}

test("client: request and response by id, one worker reused", async () => {
  let made = 0;
  const client = createClient({
    createWorker: () => (made++, fakeWorker((m, w) => w.emit("message", { id: m.id, ok: true, summary: { for: m.session } }))),
  });
  const [a, b] = await Promise.all([client.summary("s1"), client.summary("s2")]);
  assert.deepEqual([a.summary.for, b.summary.for], ["s1", "s2"]);
  assert.equal(made, 1);
  client.close();
});

test("client: a crashed worker fails the request and the next one gets a new worker", async () => {
  let made = 0;
  const client = createClient({
    createWorker: () => {
      made++;
      const first = made === 1;
      return fakeWorker((m, w) => (first ? w.emit("error", new Error("boom")) : w.emit("message", { id: m.id, ok: true, summary: {} })));
    },
  });
  const r1 = await client.summary("s1");
  assert.deepEqual([r1.ok, r1.code], [false, "worker"]);
  const r2 = await client.summary("s1");
  assert.equal(r2.ok, true);
  assert.equal(made, 2);
});

test("client: a stuck worker times out and is replaced", async () => {
  const workers = [];
  const client = createClient({ timeoutMs: 20, createWorker: () => (workers.push(fakeWorker(() => {})), workers.at(-1)) });
  const keepAlive = setTimeout(() => {}, 2_000); // the client's own timer is unref'd
  const r = await client.summary("s1");
  clearTimeout(keepAlive);
  assert.equal(r.code, "worker");
  assert.equal(workers[0].terminated, true);
});

// ---------------------------------------------------------------- package

test("package.json exposes ./tui and the file exists", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  assert.equal(pkg.exports["./tui"], "./src/tui.tsx");
  assert.ok(fs.existsSync(path.join(here, "..", "src", "tui.tsx")));
  assert.ok(pkg.files.includes("src"));
});

// ---------------------------------------------------------------- real worker + real Inspector

const API = path.join(here, "..", "..", "npm", "core", "api.js");

test("the real worker reads an OpenCode 2.x database through LoopPrism's Inspector", { skip: !fs.existsSync(API) && "needs the LoopPrism checkout" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-oc-tui-"));
  const db = path.join(dir, "opencode.db");
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const t0 = Date.parse("2026-11-10T09:00:00Z");
  d.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)").run("ses_a", null, "/work/x", "t", "2.0.32", t0, t0 + 20_000);
  let seq = 0;
  const msg = (type, data, ms) => d.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(`m${++seq}`, "ses_a", type, seq, ms, ms, JSON.stringify(data));
  msg("user", { time: { created: t0 }, text: "fix it" }, t0);
  const tool = (n) => ({ type: "tool", id: `c${n}`, name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a" }] }, time: { created: t0 + n, ran: t0 + n, completed: t0 + n + 5 } });
  msg("assistant", {
    time: { created: t0 + 1000, completed: t0 + 6000 },
    model: { id: "deepseek-chat", providerID: "x" },
    content: [tool(1), tool(2), tool(3), { type: "text", text: "done" }],
    cost: 0.25,
    tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 9000, write: 0 } },
  }, t0 + 6000);
  d.close();

  const keepAlive = setInterval(() => {}, 100); // the client's worker is unref'd, like in the TUI
  const client = createClient({ workerData: { apiPath: API, inspector: { indexPath: path.join(dir, "index.db"), roots: { opencode: db } } } });
  try {
    const hit = await client.summary("ses_a");
    assert.equal(hit.ok, true, JSON.stringify(hit));
    assert.equal(hit.summary.steps, 1);
    assert.equal(hit.summary.cachePct, 90);
    assert.ok(hit.summary.costUsd > 0);
    assert.deepEqual(hit.summary.findings.map((f) => [f.kind, f.worst]), [["repeated_call", 3]]);
    const card = texts(buildCard(hit.summary));
    assert.ok(card.includes("! 1 repeated call (worst 3x)"), card.join(" | "));
    const miss = await client.summary("ses_nope");
    assert.deepEqual([miss.ok, miss.code], [false, "not_found"]);
  } finally {
    clearInterval(keepAlive);
    client.close();
  }
});
