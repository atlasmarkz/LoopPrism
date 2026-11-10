'use strict';
// The Node session core on small made-up sessions of every agent. The full comparison with the
// Python original runs in CI (npm/parity/compare.js on scripts/make_parity_fixtures.py).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { sqlite } = require('../core/sqlite');
const pricing = require('../core/pricing');
const U = require('../core/util');
const claude = require('../core/adapters/claude_code');
const codex = require('../core/adapters/codex');
const gemini = require('../core/adapters/gemini');
const opencode = require('../core/adapters/opencode');
const cursor = require('../core/adapters/cursor');
const dsh = require('../core/adapters/dsh');
const workbuddy = require('../core/adapters/workbuddy');
const analysis = require('../core/analysis');
const context = require('../core/context');
const agents = require('../core/agents');
const { Inspector } = require('../core/api');
const { Server } = require('../core/mcp');
const { parseArgs } = require('../core/cli');

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const T = (s) => `2026-11-01T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ------------------------------------------------------------------ fixtures
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUB = 'asub00000001';

function claudeRows() {
  const usage = (inp, out, read) => ({ input_tokens: inp, output_tokens: out, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } });
  const asst = (id, s, content, u) => ({ type: 'assistant', timestamp: T(s), cwd: '/work/app', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content, usage: u } });
  const res = (id, s, text, isError = false, extra = {}) => ({ type: 'user', timestamp: T(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, ...extra });
  const rows = [
    { type: 'custom-title', customTitle: 'Fix the flaky test' },
    { type: 'user', timestamp: T(0), cwd: '/work/app', gitBranch: 'main', version: '2.1.320', message: { role: 'user', content: 'Fix the flaky test in tests/test_api.py' } },
    { type: 'user', timestamp: T(0), message: { role: 'user', content: '<system-reminder>CLAUDE.md says: run pytest</system-reminder>' } },
  ];
  // the same Bash call three times in one turn (a loop), each failing
  for (let i = 0; i < 3; i++) {
    rows.push(asst(`m${i}`, 10 + i * 10, [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'pytest -x' } }], usage(1000, 50, 20000)));
    rows.push(res(`t${i}`, 15 + i * 10, 'FAILED tests/test_api.py', true));
  }
  rows.push(asst('m3', 50, [{ type: 'tool_use', id: 'ta', name: 'Agent', input: { description: 'Find the race', prompt: 'Look for the race condition', subagent_type: 'Explore' } }], usage(500, 40, 21000)));
  rows.push(res('ta', 80, `Found it.\nagentId: ${SUB}`, false, { toolUseResult: { agentId: SUB } }));
  rows.push({ type: 'system', subtype: 'compact_boundary', timestamp: T(85), content: 'Conversation compacted' });
  rows.push(asst('m4', 90, [{ type: 'thinking', thinking: 'The fixture leaks state.' }, { type: 'text', text: 'Fixed: the fixture leaked state between tests.' }], usage(800, 300, 22000)));
  return rows;
}

function subRows() {
  return [
    { type: 'user', timestamp: T(51), isSidechain: true, message: { role: 'user', content: 'Look for the race condition' } },
    { type: 'assistant', timestamp: T(70), isSidechain: true, message: { id: 's1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'The fixture is module-scoped.' }], usage: { input_tokens: 3000, output_tokens: 100 } } },
  ];
}

function codexRows() {
  return [
    { type: 'session_meta', timestamp: T(0), payload: { id: 'cx-1', cwd: '/work/web', cli_version: '0.80.0' } },
    { type: 'turn_context', timestamp: T(0), payload: { turn_id: 'u1', model: 'gpt-6.1-sol', cwd: '/work/web' } },
    { type: 'response_item', timestamp: T(1), payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] } },
    { type: 'response_item', timestamp: T(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Update the snapshot tests' }] } },
    { type: 'response_item', timestamp: T(5), payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'c1' } },
    { type: 'token_usage_record', timestamp: T(6), payload: { turn_id: 'u1', response_id: 'r1', usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 200 } } },
    { type: 'response_item', timestamp: T(9), payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { type: 'event_msg', timestamp: T(9), payload: { type: 'token_count', info: { model_context_window: 400000 } } },
    { type: 'response_item', timestamp: T(12), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Snapshots updated.' }] } },
    { type: 'token_usage_record', timestamp: T(12), payload: { turn_id: 'u1', response_id: 'r2', usage: { input_tokens: 10500, cached_input_tokens: 10000, output_tokens: 50 } } },
  ];
}

function makeOpencodeDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  const t0 = Date.parse('2026-11-01T09:00:00Z');
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_1', null, '/work/oc', 'New session - 2026', '1.2.0', t0, t0 + 9000);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m1', 'ses_1', t0, t0, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m2', 'ses_1', t0 + 1000, t0 + 9000, JSON.stringify({ role: 'assistant', modelID: 'deepseek-chat' }));
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
  part.run('p1', 'm1', 'ses_1', t0, JSON.stringify({ type: 'text', text: 'Rename the helper' }));
  part.run('p2', 'm2', 'ses_1', t0 + 2000, JSON.stringify({ type: 'tool', tool: 'edit', callID: 'k1', state: { status: 'completed', input: { file: 'a.ts' }, output: 'done', time: { start: t0 + 2000, end: t0 + 3500 } } }));
  part.run('p3', 'm2', 'ses_1', t0 + 5000, JSON.stringify({ type: 'step-finish', cost: 0.5, tokens: { input: 1000, output: 100, reasoning: 20, cache: { read: 5000, write: 0 } } }));
  db.close();
}

function makeCursorDb(userDir) {
  const file = path.join(userDir, 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  write(path.join(userDir, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: 'file:///work/my%20app' }));
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const cid = 'c0ffee00-0000-4000-8000-000000000001';
  const bubbles = [
    { type: 1, bubbleId: 'u1', text: 'list the files', createdAt: '2026-10-29T14:00:00.000Z', modelInfo: { modelName: 'grok-4.6' } },
    { type: 2, bubbleId: 'u1/s:1', createdAt: '2026-10-29T14:00:03.000Z', toolFormerData: { name: 'run_terminal_cmd', toolCallId: 't1', status: 'completed', rawArgs: '{"command":"ls"}', result: '{"output":"a.py"}' } },
    { type: 2, bubbleId: 'u1/s:2', createdAt: '2026-10-29T14:00:04.000Z', text: 'One file: a.py' },
  ];
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  put.run(`composerConvHeaders:${cid}:000000`, JSON.stringify(bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type }))));
  put.run(`composerData:${cid}`, Buffer.from(JSON.stringify({ name: 'General chat', createdAt: 1793284504405, lastUpdatedAt: 1793284510000, workspaceIdentifier: { id: 'ws1' } })));
  for (const b of bubbles) put.run(`bubbleId:${cid}:${b.bubbleId}`, JSON.stringify(b));
  db.close();
  return file;
}

let ROOT;
let ROOTS;
test.before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-core-'));
  const project = path.join(ROOT, '.claude', 'projects', '-work-app');
  write(path.join(project, `${SID}.jsonl`), jl(claudeRows()));
  write(path.join(project, SID, 'subagents', `agent-${SUB}.jsonl`), jl(subRows()));
  write(path.join(ROOT, '.codex', 'sessions', '2026', '11', '01', 'rollout-2026-11-01T10-00-00-cx-1.jsonl'), jl(codexRows()));
  makeOpencodeDb(path.join(ROOT, 'opencode', 'opencode.db'));
  makeCursorDb(path.join(ROOT, 'Cursor', 'User'));
  const chats = path.join(ROOT, '.gemini', 'tmp', 'proj', 'chats');
  write(path.join(ROOT, '.gemini', 'tmp', 'proj', '.project_root'), '/work/gem\n');
  write(path.join(chats, 'session-a.jsonl'), jl([
    { sessionId: 'g-1', projectHash: 'x', startTime: T(0) },
    { id: 'm1', timestamp: T(1), type: 'user', content: [{ text: 'fix it' }] },
    { id: 'm2', timestamp: T(5), type: 'gemini', content: 'Looking.', model: 'gemini-2.5-pro', tokens: { input: 10000, output: 200, cached: 6000, thoughts: 100 } },
    { id: 'm3', timestamp: T(9), type: 'gemini', content: 'Done.', model: 'gemini-2.5-pro', tokens: { input: 12000, output: 50, cached: 10000 } },
    { $patch: { id: 'm2', content: 'Looking closely.' } },
    { $rewindTo: 'm3' },
    { $set: { summary: 'Fixing it' } },
  ]));
  const dshRows = [
    { type: 'session', id: 'dsh-1', cwd: '/work/d', createdAt: Date.parse(T(0)), version: 4 },
    { type: 'user/message', time: Date.parse(T(1)), data: { id: 'u1', content: [{ type: 'text', text: 'summarise the repo' }] } },
    { type: 'assistant/message', time: Date.parse(T(4)), data: { message: { id: 'a1', source: { model: 'deepseek-chat' }, content: [{ type: 'text', text: 'It is a CLI.' }] }, usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 8000 } } },
  ];
  const frames = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(jl(dshRows.slice(0, 2)))),
    zlib.zstdCompressSync(Buffer.from(jl(dshRows.slice(2)))),
    zlib.zstdCompressSync(Buffer.from(jl([{ type: 'user/message', time: 1, data: { content: 'half-written' } }]))).subarray(0, 9),
  ]);
  write(path.join(ROOT, '.dsh', 'sessions', '--work-d--', 'session-1', 'session.v4.jsonl.zstd'), frames);
  write(path.join(ROOT, '.dsh', 'sessions', '--work-d--', 'session-1', 'session.v3.jsonl'), '');
  write(path.join(ROOT, '.workbuddy', 'projects', 'p', 'wb-1.jsonl'), jl([
    { type: 'message', role: 'user', timestamp: Date.parse(T(0)), cwd: '/work/wb', content: [{ type: 'input_text', text: '<system-reminder data-role="user-context">OS: macOS</system-reminder><user_query>draft the email</user_query>' }] },
    { type: 'function_call', timestamp: Date.parse(T(3)), callId: 'f1', name: 'search', arguments: '{"q":"x"}', providerData: { messageId: 'r1', model: 'glm-4.7', rawUsage: { prompt_tokens: 5000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 4000 } } } },
    { type: 'function_call_result', timestamp: Date.parse(T(5)), callId: 'f1', output: 'found', status: 'completed' },
    { type: 'message', role: 'assistant', timestamp: Date.parse(T(8)), content: [{ type: 'output_text', text: 'Here is the draft.' }], providerData: { messageId: 'r2', model: 'glm-4.7', rawUsage: { prompt_tokens: 5200, completion_tokens: 300 } } },
  ]));
  ROOTS = {
    'claude-code': path.join(ROOT, '.claude', 'projects'),
    codex: path.join(ROOT, '.codex', 'sessions'),
    opencode: path.join(ROOT, 'opencode', 'opencode.db'),
    cursor: path.join(ROOT, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    gemini: path.join(ROOT, '.gemini', 'tmp'),
    dsh: path.join(ROOT, '.dsh', 'sessions'),
    workbuddy: path.join(ROOT, '.workbuddy', 'projects'),
  };
});
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ------------------------------------------------------------------ pricing and helpers
test('pricing normalizes model ids and knows the current Claude models', () => {
  assert.strictEqual(pricing.normalizeModel('us.anthropic.claude-opus-4-5-20251101-v1:0'), 'claude-opus-4-5');
  assert.strictEqual(pricing.normalizeModel('claude-opus-4.5[1m]'), 'claude-opus-4-5');
  for (const m of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.ok(pricing.lookup(m), m);
  close(pricing.usageCost('claude-fable-5-2', { input_tokens: 1e6, output_tokens: 1e6 }), 48);
  close(pricing.usageCost('claude-haiku-5-5', { input_tokens: 1e6, long_context: true }), 0.5);
  assert.strictEqual(pricing.lookup('totally-unknown-model'), null);
  assert.ok(pricing.lookup('deepseek-v9'), 'families fall back to the newest known price');
});

test('helpers follow Python: code points, rounding, compensated sums', () => {
  assert.strictEqual(U.cpLen('a😀b'), 3);
  assert.strictEqual(U.cpSlice('😀😀😀', 2), '😀😀');
  assert.strictEqual(U.pyRound(2.5), 2);
  assert.strictEqual(U.pyRound(3.5), 4);
  assert.strictEqual(U.sum([0.1, 0.2, 0.3]), 0.6);
  assert.strictEqual(U.pyDumps({ b: 1, a: [1, 'é'] }, { sortKeys: true, sep: [',', ':'], ensureAscii: false }), '{"a":[1,"é"],"b":1}');
  assert.strictEqual(U.pyDumps({ a: 'é' }), '{"a": "\\u00e9"}');
});

// ------------------------------------------------------------------ adapters
test('Claude Code: turns, steps, cost, loops, error streak, compaction, subagents', () => {
  const ps = claude.parse(path.join(ROOTS['claude-code'], '-work-app', `${SID}.jsonl`));
  const m = ps.meta;
  assert.strictEqual(m.title, 'Fix the flaky test');
  assert.strictEqual(m.turns, 1);
  assert.strictEqual(m.steps, 5);
  assert.strictEqual(m.tool_calls, 4);
  assert.strictEqual(m.git_branch, 'main');
  assert.deepStrictEqual(m.models, ['claude-sonnet-5-5']);
  // 3×(1000 in, 50 out, 20k read, 100 write) + (500, 40, 21k, 100) + (800, 300, 22k, 100) at $2/$10/$0.1/$2.5
  const expected = (2 * 4300 + 10 * 490 + 0.1 * 103000 + 2.5 * 500) / 1e6;
  close(m.cost_usd, Number(expected.toFixed(6)));
  assert.ok(ps.events.some((e) => e.kind === 'context' && e.label === 'system-reminder'));
  const kinds = analysis.findings(ps).map((f) => f.kind);
  assert.deepStrictEqual(kinds, ['repeated_call', 'error_streak', 'compaction']);
  const tree = agents.build(ps);
  assert.strictEqual(tree.totals.subagents, 1);
  const sub = tree.agents[1];
  assert.strictEqual(sub.role, 'Explore');
  assert.strictEqual(sub.session_id, `${SID}~${SUB}`);
  close(sub.cost_usd, (0.1 * 3000 + 0.5 * 100) / 1e6);
});

test('Claude Code: the context of a step adds up to the reported input', () => {
  const ps = claude.parse(path.join(ROOTS['claude-code'], '-work-app', `${SID}.jsonl`));
  const c = context.stepContext(ps, 4, true);
  assert.strictEqual(c.actual_input, 800 + 22000 + 100);
  assert.strictEqual(c.window, 1_000_000);
  const total = c.categories.reduce((a, x) => a + x.tokens, 0);
  assert.ok(Math.abs(total - c.actual_input) <= c.categories.length, `${total} vs ${c.actual_input}`);
  assert.ok(c.categories.find((x) => x.key === 'unattributed').tokens > 0, 'old transcripts infer system prompt and tools');
  const cost = analysis.costBreakdown(ps);
  close(cost.total_usd, ps.meta.cost_usd);
});

test('Codex: steps per usage record, cached input, tool time, developer prompt', () => {
  const ps = codex.parse(codex.discover(ROOTS.codex)[0]);
  assert.strictEqual(ps.meta.id, 'cx-1');
  assert.strictEqual(ps.meta.project, '/work/web');
  assert.strictEqual(ps.steps.length, 2);
  assert.deepStrictEqual([ps.steps[0].input_tokens, ps.steps[0].cache_read_tokens], [2000, 8000]);
  assert.strictEqual(ps.steps[0].tools_ms, 4000);
  assert.strictEqual(ps.steps[1].context_window, 400000);
  assert.deepStrictEqual(ps.events.find((e) => e.kind === 'tool_call').tool_input, { command: ['npm', 'test'] });
  assert.strictEqual(ps.shapes.get('codex').system[0].text, 'You are Codex.');
});

test('OpenCode: a session inside SQLite, OpenCode title replaced by the prompt', () => {
  const found = opencode.discover(ROOTS.opencode);
  assert.strictEqual(found.size, 1);
  const ps = opencode.parse([...found.keys()][0]);
  assert.strictEqual(ps.meta.title, 'Rename the helper');
  assert.strictEqual(ps.steps[0].output_tokens, 120);
  assert.strictEqual(ps.steps[0].tools_ms, 1500);
  close(ps.steps[0].cost_usd, (0.28 * 1000 + 0.42 * 120 + 0.028 * 5000) / 1e6);
  close(ps.meta.cost_usd, 0.00047);
});

test('Cursor: conversation from the key-value store, BLOB values, workspace folder', () => {
  const found = cursor.discover(ROOTS.cursor);
  const ps = cursor.parse([...found.keys()][0]);
  assert.strictEqual(ps.meta.title, 'list the files');
  assert.strictEqual(ps.meta.project, '/work/my app');
  assert.deepStrictEqual(ps.meta.models, ['grok-4.6']);
  assert.deepStrictEqual(ps.events.map((e) => e.kind), ['user', 'tool_call', 'tool_result', 'assistant']);
  assert.match(ps.events[2].text, /"output": "a.py"/);
});

test('Gemini CLI: patches, rewinds and metadata are applied', () => {
  const ps = gemini.parse(gemini.discover(ROOTS.gemini)[0]);
  assert.strictEqual(ps.meta.title, 'Fixing it');
  assert.strictEqual(ps.meta.project, '/work/gem');
  assert.strictEqual(ps.steps.length, 1, 'rewound to before m3');
  assert.strictEqual(ps.events.find((e) => e.kind === 'assistant').text, 'Looking closely.');
  assert.deepStrictEqual([ps.steps[0].input_tokens, ps.steps[0].cache_read_tokens, ps.steps[0].output_tokens], [4000, 6000, 300]);
});

test('DeepSeek Harness: newest generation, zstd frames, a cut-off last frame is skipped', () => {
  const files = dsh.discover(ROOTS.dsh);
  assert.deepStrictEqual(files.map((f) => path.basename(f)), ['session.v4.jsonl.zstd']);
  const ps = dsh.parse(files[0]);
  assert.strictEqual(ps.meta.id, 'dsh-1');
  assert.strictEqual(ps.meta.version, 'v4');
  assert.deepStrictEqual(ps.events.map((e) => e.kind), ['user', 'assistant']);
  assert.strictEqual(ps.steps[0].cache_read_tokens, 8000);
});

test('WorkBuddy: injected context split from the prompt, usage on one item of a response', () => {
  const ps = workbuddy.parse(workbuddy.discover(ROOTS.workbuddy)[0]);
  assert.deepStrictEqual(ps.events.slice(0, 2).map((e) => [e.kind, e.text]), [
    ['context', '<system-reminder data-role="user-context">OS: macOS</system-reminder>'],
    ['user', 'draft the email'],
  ]);
  assert.deepStrictEqual(ps.steps.map((s) => [s.input_tokens, s.cache_read_tokens]), [[1000, 4000], [5200, 0]]);
  assert.strictEqual(ps.events.find((e) => e.kind === 'tool_call').step, 0);
  assert.strictEqual(ps.steps[0].tools_ms, 2000);
});

// ------------------------------------------------------------------ store, API, MCP, CLI
test('the store indexes every agent, searches text and resolves "current" by folder', () => {
  const ins = new Inspector({ indexPath: ':memory:', roots: ROOTS });
  try {
    const all = ins.sessions({ limit: 50 });
    assert.deepStrictEqual(Object.keys(all.by_agent).sort(), ['claude-code', 'codex', 'cursor', 'dsh', 'gemini', 'opencode', 'workbuddy']);
    const hits = ins.sessions({ query: 'snapshot' });
    assert.deepStrictEqual(hits.sessions.map((s) => s.id), ['cx-1']);
    const s = ins.summary('current', { cwd: '/work/app' });
    assert.strictEqual(s.session.id, SID);
    assert.strictEqual(s.subagents.agents.length, 1);
    assert.ok(s.findings[0].examples[0].startsWith('Bash: pytest -x'));
    assert.strictEqual(s.tools.find((t) => t.tool === 'Bash').errors, 3);
    assert.strictEqual(ins.summary('aaaaaaaa-0000', {}).session.id, SID, 'a unique prefix');
    assert.strictEqual(ins.summary(`${SID}~${SUB}`, {}).session.title, 'Subagent: Look for the race condition');
    assert.throws(() => ins.summary('current', { cwd: '/nowhere' }), /No session found for the folder/);
    const cost = ins.cost({ days: 0 });
    assert.strictEqual(cost.totals.sessions, 6, 'Cursor has no token usage, so no cost rows');
    assert.ok(cost.unpriced_models.includes('grok-4.6') === false);
  } finally {
    ins.close();
  }
});

test('MCP: initialize, list tools, call one, errors stay inside the result', () => {
  const ins = new Inspector({ indexPath: ':memory:', roots: ROOTS });
  const server = new Server({ inspector: ins, write: () => {} });
  try {
    const init = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.strictEqual(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const tools = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools;
    assert.ok(tools.every((t) => t.inputSchema.type === 'object' && !t.run));
    assert.deepEqual(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ['open_dashboard']);
    const call = server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_summary', arguments: { session: 'current', cwd: '/work/app' } } });
    assert.strictEqual(JSON.parse(call.result.content[0].text).session.id, SID);
    const bad = server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_events', arguments: { session: 'missing-session' } } });
    assert.strictEqual(bad.result.isError, true);
    assert.strictEqual(server.handle({ jsonrpc: '2.0', id: 5, method: 'nope' }).error.code, -32601);
    assert.strictEqual(server.handle({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '1999-01-01' } }).result.protocolVersion, '2025-11-25');
  } finally {
    ins.close();
  }
});

// ------------------------------------------------------------------ dashboard server (`lpa ui`)
const http = require('http');
const { Api, createServer, listen } = require('../core/server');
const { SessionStore } = require('../core/store');

function request(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          // text
        }
        resolve({ status: res.statusCode, type: res.headers['content-type'], body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('dashboard server: the API the dashboard calls, live routes empty, local requests only', async () => {
  process.env.LOOPPRISM_OPTIMIZE_FILE = path.join(ROOT, 'optimize.json');
  const store = new SessionStore({ indexPath: ':memory:', roots: ROOTS });
  const server = createServer({ api: new Api({ store }) });
  const port = await listen(server, 0);
  try {
    const list = await request(port, '/api/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 7);
    const id = encodeURIComponent(SID);
    const detail = (await request(port, `/api/sessions/${id}`)).body;
    assert.equal(detail.session.title, 'Fix the flaky test');
    assert.equal(detail.session.read_only, false);
    assert.match(detail.session.resume_command, /claude --resume/);
    assert.deepEqual(detail.findings.map((f) => f.kind), ['repeated_call', 'error_streak', 'compaction']);
    const traj = (await request(port, `/api/sessions/${id}/trajectory`)).body;
    assert.equal(traj.steps.length, 5);
    assert.equal((await request(port, `/api/sessions/${id}/context/4`)).body.actual_input, 22900);
    assert.equal((await request(port, `/api/sessions/${id}/events?kinds=tool_call&preview=5`)).body.total, 4);
    assert.equal((await request(port, `/api/sessions/${id}/events/99`)).status, 404);
    assert.equal((await request(port, `/api/sessions/${id}~${SUB}`)).body.session.id, `${SID}~${SUB}`);
    const md = await request(port, `/api/sessions/${id}/export.md`);
    assert.match(md.type, /text\/markdown/);
    assert.match(md.body, /^# Fix the flaky test/);
    assert.equal((await request(port, '/api/sessions/cost/overview?days=0')).body.totals.sessions, 6);
    assert.ok(Array.isArray((await request(port, '/api/sessions/optimize?days=3650')).body.suggestions));
    assert.equal((await request(port, '/api/sessions/optimize/repeated_calls/adopt', { method: 'POST' })).body.state, 'adopted');
    assert.equal((await request(port, '/api/sessions/optimize/nope/adopt', { method: 'POST' })).status, 404);
    const bad = await request(port, '/api/sessions/optimize/settings', { method: 'PUT', body: JSON.stringify({ ai: { url: 'http://example.com' } }) });
    assert.equal(bad.status, 400);
    const saved = await request(port, '/api/sessions/optimize/settings', { method: 'PUT', body: JSON.stringify({ live_tools: false, ai: { url: 'https://api.example.com/v1', model: 'm', api_key: 'sk-secret' } }) });
    assert.deepEqual(saved.body, { live_tools: false, ai: { enabled: false, url: 'https://api.example.com/v1', model: 'm', key_set: true } });
    const preview = (await request(port, '/api/sessions/optimize/ai/preview?days=3650', { method: 'POST' })).body;
    assert.equal(preview.endpoint, 'https://api.example.com/v1/chat/completions');
    assert.ok(!JSON.stringify(preview).includes('sk-secret') && !JSON.stringify(preview).includes('/work/app'), 'aggregates only, never the key or paths');
    assert.equal((await request(port, '/api/sessions/optimize/ai/run?days=3650', { method: 'POST' })).status, 400);
    const ocId = (await request(port, '/api/sessions?agent=opencode')).body.sessions[0].id;
    assert.equal((await request(port, `/api/sessions/${ocId}/delete`, { method: 'POST' })).status, 400, 'read-only agents');
    assert.deepEqual((await request(port, '/api/traces')).body, { traces: [], limit: 20, offset: 0 });
    assert.deepEqual((await request(port, '/api/mcp-servers')).body, []);
    assert.equal((await request(port, '/api/sessions', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, `/api/sessions/${id}/delete`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await request(port, '/..%2f..%2fpackage.json')).status, 404);
  } finally {
    server.close();
    store.close();
    delete process.env.LOOPPRISM_OPTIMIZE_FILE;
  }
});

test('trash refuses files outside the agents\' session folders', () => {
  const actions = require('../core/actions');
  const outside = write(path.join(ROOT, 'elsewhere', 'x.jsonl'), '{}\n');
  assert.throws(() => actions.trash(outside, [ROOTS['claude-code']]), (err) => err.code === 'EPERM');
  assert.ok(fs.existsSync(outside));
});

test('CLI arguments', () => {
  assert.deepStrictEqual(parseArgs(['abc', '--agent', 'codex', '-n', '5', '--json', '--kind=tool_call']), { _: ['abc'], agent: 'codex', limit: '5', json: true, kind: 'tool_call' });
});
