'use strict';
// OpenCode 2.x keeps sessions in session_v2 / session_message; an upgraded 1.x database holds both layouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const opencode = require('../core/adapters/opencode');
const analysis = require('../core/analysis');
const { sqlite } = require('../core/sqlite');
const { K } = require('../core/models');

const T0 = Date.parse('2026-11-10T09:00:00Z');

function makeDb(file, { withV1 = false } = {}) {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  if (withV1) {
    db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_old', null, '/work/old', 'old', '1.2.0', T0, T0);
  }
  const ses = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)');
  ses.run('ses_new', null, '/work/new', 'New session - 2026', '2.0.32', T0, T0 + 60_000);
  ses.run('ses_child', 'ses_new', '/work/new', 'sub', '2.0.32', T0, T0);
  let seq = 0;
  const msg = (type, data, ms) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(`m${++seq}`, 'ses_new', type, seq, ms, ms, JSON.stringify(data));
  const tool = (n, status, extra = {}) => ({
    type: 'tool', id: `c${n}`, name: 'shell',
    state: { status, input: { command: 'ls' }, ...extra },
    time: { created: T0 + 2000 + n, ran: T0 + 2000 + n, completed: T0 + 2500 + n },
  });
  msg('user', { time: { created: T0 }, text: 'Fix the build' }, T0);
  msg('assistant', {
    time: { created: T0 + 1000, completed: T0 + 5000 },
    model: { id: 'deepseek-chat', providerID: 'x' },
    content: [
      { type: 'reasoning', text: 'thinking', time: { created: T0 + 1000, completed: T0 + 1500 } },
      tool(1, 'completed', { content: [{ type: 'text', text: 'a.txt' }] }),
      tool(2, 'completed', { content: [{ type: 'text', text: 'a.txt' }] }),
      tool(3, 'completed', { content: [{ type: 'text', text: 'a.txt' }] }),
      { type: 'text', text: 'Looking.' },
    ],
    cost: 0.2,
    tokens: { input: 1000, output: 100, reasoning: 50, cache: { read: 4000, write: 0 } },
  }, T0 + 5000);
  msg('assistant', {
    time: { created: T0 + 6000, completed: T0 + 9000 },
    model: { id: 'mystery-model-1', providerID: 'x' },
    content: [tool(4, 'error', { error: { type: 'x', message: 'exit 1' } }), tool(5, 'error', { error: { message: 'exit 1' } }), tool(6, 'error', { error: { message: 'exit 1' } })],
    cost: 0.1,
    tokens: { input: 1200, output: 20, reasoning: 0, cache: { read: 4800, write: 0 } },
  }, T0 + 9000);
  msg('compaction', { time: { created: T0 + 10_000 }, status: 'completed', reason: 'auto', summary: 'so far...', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, T0 + 10_000);
  msg('compaction', { time: { created: T0 + 11_000 }, status: 'failed', error: { type: 'x', message: 'boom' } }, T0 + 11_000);
  msg('idle', { time: { created: T0 + 12_000 }, outcome: 'succeeded' }, T0 + 12_000);
  msg('assistant', { time: { created: T0 + 13_000, completed: T0 + 13_500 }, model: { id: 'deepseek-chat' }, content: [{ type: 'text', text: 'partial' }] }, T0 + 13_500); // no usage: not a step
  db.close();
}

test('2.x sessions are discovered (top level only) and parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-oc2-'));
  const file = path.join(dir, 'opencode.db');
  makeDb(file);
  const found = opencode.discover(file);
  assert.deepEqual([...found.keys()], [`${file}#ses_new`]);

  const ps = opencode.parse(`${file}#ses_new`);
  assert.equal(ps.meta.project, '/work/new');
  assert.equal(ps.meta.version, '2.0.32');
  assert.equal(ps.meta.title, 'Fix the build'); // "New session" is replaced by the first prompt
  assert.equal(ps.meta.turns, 1);
  assert.equal(ps.steps.length, 2, 'a model call without usage is not a step');
  assert.equal(ps.steps[0].input_tokens, 1000);
  assert.equal(ps.steps[0].output_tokens, 150, 'reasoning tokens count as output');
  assert.equal(ps.steps[0].cache_read_tokens, 4000);
  assert.ok(ps.steps[0].cost_usd > 0 && ps.steps[0].cost_usd < 0.2, 'a model LoopPrism has prices for is priced by LoopPrism');
  assert.equal(ps.steps[1].cost_usd, 0.1, 'an unknown model keeps the cost OpenCode recorded');
  assert.ok(ps.steps[0].tools_ms > 0);

  const kinds = ps.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === K.TOOL_CALL).length, 6);
  assert.equal(kinds.filter((k) => k === K.TOOL_RESULT).length, 6);
  assert.equal(kinds.filter((k) => k === K.COMPACTION).length, 1, 'only the compaction that completed');
  const errors = ps.events.filter((e) => e.kind === K.TOOL_RESULT && e.is_error);
  assert.equal(errors.length, 3);
  assert.equal(errors[0].text, 'exit 1');
  assert.equal(ps.events.find((e) => e.kind === K.TOOL_RESULT).text, 'a.txt');
});

test('2.x sessions feed LoopPrism findings: repeated calls, error streaks, compaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-oc2-'));
  const file = path.join(dir, 'opencode.db');
  makeDb(file);
  const found = analysis.findings(opencode.parse(`${file}#ses_new`)).map((f) => f.kind).sort();
  // the six identical shell calls of one turn are one finding
  assert.deepEqual(found, ['compaction', 'error_streak', 'repeated_call']);
});

test('a database upgraded from 1.x holds both layouts and both are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-oc2-'));
  const file = path.join(dir, 'opencode.db');
  makeDb(file, { withV1: true });
  assert.deepEqual([...opencode.discover(file).keys()].sort(), [`${file}#ses_new`, `${file}#ses_old`]);
  assert.equal(opencode.parse(`${file}#ses_new`).steps.length, 2);
  assert.equal(opencode.parse(`${file}#ses_old`).meta.project, '/work/old');
});
