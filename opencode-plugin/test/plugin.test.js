// Tests for opencode-loopprism: a fake OpenCode V2 context and a V1 hook call, both reporting to a
// local HTTP server that stands in for LoopPrism's /api/ingest/events.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import plugin, { mcpCommand } from "../src/index.js";

async function withServer(fn) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(...JSON.parse(body).events);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.LOOPPRISM_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(received);
  } finally {
    delete process.env.LOOPPRISM_URL;
    server.close();
  }
}

/** A V2 context that records what the plugin registers and lets the test fire hooks and events. */
function fakeContext(directory) {
  const hooks = {};
  const registry = { mcp: new Map(), skills: new Map() };
  let pushEvent;
  const queue = [];
  const events = {
    async *subscribe({ signal }) {
      while (!signal.aborted) {
        if (queue.length) yield queue.shift();
        else await new Promise((r) => (pushEvent = r));
      }
    },
  };
  const hook = (domain) => async (name, cb) => {
    hooks[`${domain}.${name}`] = cb;
    return { dispose() {} };
  };
  return {
    hooks,
    registry,
    emit(ev) {
      queue.push(ev);
      pushEvent?.();
    },
    ctx: {
      location: { directory },
      options: {},
      session: { hook: hook("session") },
      tool: { hook: hook("tool") },
      event: events,
      mcp: {
        async transform(cb) {
          cb({ get: (n) => registry.mcp.get(n), set: (n, c) => registry.mcp.set(n, c) });
        },
      },
      skill: {
        async transform(cb) {
          cb({ get: (n) => registry.skills.get(n), add: (s) => registry.skills.set(s.id, s) });
        },
      },
    },
  };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("default export has the shape both OpenCode generations load", () => {
  assert.equal(plugin.id, "loopprism");
  assert.equal(typeof plugin.setup, "function"); // V2
  assert.equal(typeof plugin.server, "function"); // V1
});

test("V2: prompt, tool and end of turn are reported; cleanup stops the subscription", async () => {
  await withServer(async (received) => {
    const f = fakeContext("/proj");
    const cleanup = await plugin.setup(f.ctx);

    await f.hooks["session.prompt"]({ sessionID: "ses_1", prompt: { text: "hello" } });
    f.emit({ type: "session.step.started", data: { sessionID: "ses_1", model: { id: "m1", providerID: "p" } } });
    await tick();
    f.hooks["tool.execute.before"]({ id: "call_1" });
    await f.hooks["tool.execute.after"]({
      tool: "read",
      sessionID: "ses_1",
      id: "call_1",
      input: { path: "a.txt" },
      status: "completed",
      result: { content: [{ type: "text", text: "contents" }] },
    });
    await f.hooks["tool.execute.after"]({
      tool: "bash",
      sessionID: "ses_1",
      id: "call_2",
      input: { command: "false" },
      status: "error",
      error: { message: "exit 1" },
    });
    f.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    await tick(150);

    const kinds = received.map((e) => e.event);
    assert.deepEqual(kinds, ["prompt", "tool", "tool_failure", "stop"]);
    assert.equal(received[0].prompt, "hello");
    assert.equal(received[0].cwd, "/proj");
    assert.equal(received[1].tool_name, "read");
    assert.equal(received[1].tool_response, "contents");
    assert.equal(received[1].model, "m1");
    assert.equal(received[2].error, "exit 1");
    assert.ok(received.every((e) => e.agent === "opencode" && e.session_id === "ses_1"));
    await cleanup();
  });
});

test("V2: a failed turn is reported once, an unopened session is not", async () => {
  await withServer(async (received) => {
    const f = fakeContext("/proj");
    const cleanup = await plugin.setup(f.ctx);
    f.emit({ type: "session.execution.succeeded", data: { sessionID: "never_prompted" } });
    await f.hooks["session.prompt"]({ sessionID: "ses_2", prompt: { text: "x" } });
    f.emit({ type: "session.execution.failed", data: { sessionID: "ses_2" } });
    f.emit({ type: "session.execution.failed", data: { sessionID: "ses_2" } });
    await tick(150);
    assert.deepEqual(received.map((e) => e.event), ["prompt", "stop"]);
    assert.equal(received[1].outcome, "failed");
    await cleanup();
  });
});

test("V2: registers the MCP server and skill, and leaves the user's own entries alone", async () => {
  const f = fakeContext("/proj");
  const cleanup = await plugin.setup(f.ctx);
  const mcp = f.registry.mcp.get("loopprism");
  assert.equal(mcp.type, "local");
  assert.deepEqual(mcp.command.slice(0, 1), ["node"]);
  assert.equal(mcp.command.at(-1), "mcp");
  const skill = f.registry.skills.get("loopprism");
  assert.match(skill.content, /LoopPrism/);
  await cleanup();

  const g = fakeContext("/proj");
  g.registry.mcp.set("loopprism", { type: "remote", url: "https://mine" });
  g.registry.skills.set("loopprism", { id: "loopprism", content: "mine" });
  const cleanup2 = await plugin.setup(g.ctx);
  assert.equal(g.registry.mcp.get("loopprism").url, "https://mine");
  assert.equal(g.registry.skills.get("loopprism").content, "mine");
  await cleanup2();
});

test("LOOPPRISM_MCP_COMMAND overrides the MCP command, bad values are ignored", () => {
  assert.deepEqual(mcpCommand({ LOOPPRISM_MCP_COMMAND: '["lpa","mcp"]' }), ["lpa", "mcp"]);
  assert.equal(mcpCommand({ LOOPPRISM_MCP_COMMAND: "nope" }).at(-1), "mcp");
});

test("V1: the same events come out of the V1 hooks", async () => {
  await withServer(async (received) => {
    const hooks = await plugin.server({ directory: "/proj" });
    await hooks["chat.message"](
      { sessionID: "ses_v1", model: { modelID: "m1" } },
      { parts: [{ type: "text", text: "hi" }, { type: "text", text: "synthetic", synthetic: true }] },
    );
    await hooks["tool.execute.before"]({ callID: "c1" });
    await hooks["tool.execute.after"]({ callID: "c1", sessionID: "ses_v1", tool: "read", args: { p: 1 } }, { output: "out" });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_v1" } } });
    assert.deepEqual(received.map((e) => e.event), ["prompt", "tool", "stop"]);
    assert.equal(received[0].prompt, "hi");
    assert.equal(received[1].model, "m1");
    assert.equal(received[1].tool_response, "out");
  });
});

test("LOOPPRISM_DISABLE=1 and an unreachable LoopPrism never throw", async () => {
  process.env.LOOPPRISM_URL = "http://127.0.0.1:1";
  const hooks = await plugin.server({ directory: "/p" });
  await hooks["chat.message"]({ sessionID: "s" }, { parts: [] });
  process.env.LOOPPRISM_DISABLE = "1";
  await hooks["chat.message"]({ sessionID: "s" }, { parts: [] });
  delete process.env.LOOPPRISM_DISABLE;
  delete process.env.LOOPPRISM_URL;
});
