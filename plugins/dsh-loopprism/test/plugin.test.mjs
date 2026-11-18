// Runs without the harness: a recording stand-in for the Cordis context, and the LoopPrism code
// from this repository's npm/ folder (the published package at install time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { install, toParameters, render, createSender } from '../lib/index.js';

const require = createRequire(import.meta.url);
const hook = require('../../../npm/plugin/scripts/hook.js');
const { baseUrl } = require('../../../npm/plugin/scripts/config.js');
const { TOOLS } = require('../../../npm/core/mcp.js');

function fakeCtx() {
  const listeners = new Map();
  const registered = [];
  const effects = [];
  return {
    listeners,
    registered,
    effects,
    logger: { info() {}, warn() {} },
    on: (event, fn) => listeners.set(event, fn),
    effect: (fn) => effects.push(fn()),
    tools: { register: (def) => (registered.push(def), () => {}) },
  };
}
const agent = { session: { header: { id: 's-1', cwd: '/work/app' } } };
const defineTool = (options) => options;

function setup(config = {}, sent = []) {
  const ctx = fakeCtx();
  install(ctx, config, {
    tools: TOOLS,
    defineTool,
    hook,
    post: async (event, url) => void sent.push({ event, url }),
    configModule: { baseUrl: () => 'http://lp.test' },
    makeInspector: () => ({ marker: true }),
  });
  return { ctx, sent };
}

test('the four moments become LoopPrism events, in order, without changing what the harness does', async () => {
  const sent = [];
  const { ctx } = setup({}, sent);
  assert.deepEqual([...ctx.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/turn-stopping', 'tools/post-execute']);

  ctx.listeners.get('agent/created')({ agent, source: 'startup' });
  const next = async () => ({ kind: 'enter' });
  const decision = await ctx.listeners.get('agent/pre-step')({ agent, messages: [{ content: [{ type: 'text', text: 'fix the build' }] }] }, next);
  assert.deepEqual(decision, { kind: 'enter' });
  const ok = { isError: false, content: [{ type: 'text', text: 'done' }] };
  const out = await ctx.listeners.get('tools/post-execute')({ agent, name: 'bash', callId: 'c1', arguments: { command: 'ls' } }, ok, async () => ok);
  assert.equal(out, ok);
  const bad = { isError: true, error: { message: 'exit 1' }, content: [] };
  await ctx.listeners.get('tools/post-execute')({ agent, name: 'bash', callId: 'c2', arguments: {} }, bad, async () => bad);
  ctx.listeners.get('agent/turn-stopping')({ agent });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(sent.map((s) => s.event.event), ['session_start', 'prompt', 'tool', 'tool_failure', 'stop']);
  assert.ok(sent.every((s) => s.event.agent === 'dsh' && s.event.session_id === 's-1' && s.event.cwd === '/work/app' && s.url === 'http://lp.test'));
  assert.equal(sent[1].event.prompt, 'fix the build');
  assert.equal(sent[2].event.tool_name, 'bash');
  assert.equal(sent[2].event.tool_response, 'done');
  assert.equal(sent[3].event.error, 'exit 1');
});

test('live: false and tools: false switch each half off', () => {
  const a = setup({ live: false }).ctx;
  assert.equal(a.listeners.size, 0);
  assert.equal(a.registered.length, TOOLS.length);
  const b = setup({ tools: false }).ctx;
  assert.equal(b.listeners.size, 4);
  assert.equal(b.registered.length, 0);
});

test('sendPrompts: false keeps prompt text out', async () => {
  const sent = [];
  const { ctx } = setup({ sendPrompts: false }, sent);
  await ctx.listeners.get('agent/pre-step')({ agent, messages: [{ content: [{ type: 'text', text: 'secret' }] }] }, async () => ({}));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0].event.prompt, undefined);
});

test('an unreachable LoopPrism never reaches the agent and pauses sending', async () => {
  let calls = 0;
  let t = 1000;
  const sender = createSender({
    post: async () => { calls += 1; throw new Error('ECONNREFUSED'); },
    baseUrl: () => 'http://x', buildEvent: hook.buildEvent, env: {}, now: () => t,
  });
  const stop = { hook_event_name: 'Stop', session_id: 's' };
  await sender.push(stop);
  await sender.push(stop);
  assert.equal(calls, 1, 'second event skipped during back-off');
  t += 11_000;
  await sender.push(stop);
  assert.equal(calls, 2);
});

test('every lpa mcp tool is registered as loopprism_<name> and runs against the inspector', async () => {
  const { ctx } = setup();
  assert.deepEqual(ctx.registered.map((d) => d.name), TOOLS.map((t) => `loopprism_${t.name}`));
  const tool = TOOLS.find((t) => t.name === 'session_summary');
  const seen = [];
  const original = tool.run;
  tool.run = (ins, a) => (seen.push({ ins, a }), { ok: true });
  try {
    const def = ctx.registered.find((d) => d.name === 'loopprism_session_summary');
    const result = await def.execute({ session: 'current' }, { agent });
    assert.equal(seen[0].ins.marker, true);
    assert.equal(seen[0].a.cwd, '/work/app', 'cwd defaults to the agent folder');
    assert.match(result, /"ok": true/);
    assert.deepEqual(def.output.render({}, result), [{ type: 'text', text: result }]);
  } finally {
    tool.run = original;
  }
});

test('parameter schemas use only DSL keywords', () => {
  const spec = toParameters(TOOLS.find((t) => t.name === 'session_events').inputSchema);
  assert.equal(spec.kinds.type, 'array');
  assert.equal(spec.kinds.items.type, 'string');
  assert.ok(Array.isArray(spec.kinds.items.enum));
  assert.equal(spec.limit.type, 'integer');
  for (const node of Object.values(spec)) assert.deepEqual(Object.keys(node).filter((k) => ['minimum', 'maximum', 'default'].includes(k)), []);
  assert.match(render('x'.repeat(90_000)), /more characters/);
});

test('unreachable pauses at once, a timeout only when it happens twice in a row', async () => {
  let calls = 0;
  const failWith = { err: null };
  let t = 1000;
  const sender = createSender({
    post: async () => { calls += 1; throw failWith.err; },
    baseUrl: () => 'http://x', buildEvent: hook.buildEvent, env: {}, now: () => t,
  });
  const stop = { hook_event_name: 'Stop', session_id: 's' };
  // neither an HTTP answer nor a timeout: LoopPrism is unreachable, so sending pauses
  failWith.err = new Error('fetch failed');
  await sender.push(stop); await sender.push(stop);
  assert.equal(calls, 1);
  t += 11_000;
  failWith.err = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  await sender.push(stop); await sender.push(stop);
  assert.equal(calls, 3, 'first timeout does not pause, second one does');
  await sender.push(stop);
  assert.equal(calls, 3);
});

test('baseUrl comes from the LoopPrism package', () => {
  assert.equal(baseUrl({ LOOPPRISM_URL: 'http://h:1/' }), 'http://h:1');
});
