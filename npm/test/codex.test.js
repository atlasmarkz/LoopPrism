'use strict';
// Codex rollouts as the current Codex writes them: finished ones compressed to .jsonl.zst, and
// user-role messages the Codex apps inject themselves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const codex = require('../core/adapters/codex');

const hasZstd = typeof zlib.zstdCompressSync === 'function';
const T = (s) => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
const msg = (s, role, text) => ({ type: 'response_item', timestamp: T(s), payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });

function rows(id) {
  return [
    { type: 'session_meta', timestamp: T(0), payload: { id, cwd: '/work/web', cli_version: '0.156.1' } },
    { type: 'turn_context', timestamp: T(0), payload: { turn_id: 't1', model: 'gpt-6.1-sol' } },
    msg(1, 'user', '<recommended_plugins>\nHere is a list of plugins</recommended_plugins>'),
    msg(1, 'user', '<codex_internal_context source="x">hidden</codex_internal_context>'),
    msg(1, 'user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
    msg(1, 'user', '<heartbeat>\n  <automation_id>a</automation_id>\n</heartbeat>'),
    msg(2, 'user', 'Fix the flaky test'),
    msg(3, 'assistant', 'Done.'),
    { type: 'token_usage_record', timestamp: T(4), payload: { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 1000, output_tokens: 50 } } },
  ];
}

const jl = (list) => `${list.map((r) => JSON.stringify(r)).join('\n')}\n`;

function sessionsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const day = path.join(dir, '2026', '11', '01');
  fs.mkdirSync(day, { recursive: true });
  return { dir, day };
}

test('Codex: messages the Codex apps inject are context, not prompts', (t) => {
  const { dir, day } = sessionsDir(t);
  fs.writeFileSync(path.join(day, 'rollout-2026-11-01T10-00-00-cx-1.jsonl'), jl(rows('cx-1')));
  const ps = codex.parse(codex.discover(dir)[0]);
  assert.strictEqual(ps.meta.turns, 1);
  assert.strictEqual(ps.meta.title, 'Fix the flaky test');
  assert.strictEqual(ps.events.filter((e) => e.kind === 'context').length, 4);
});

test('Codex: a finished rollout is compressed (.jsonl.zst) and still read', { skip: !hasZstd }, (t) => {
  const { dir, day } = sessionsDir(t);
  const file = path.join(day, 'rollout-2026-11-01T10-00-00-cx-2.jsonl.zst');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(jl(rows('cx-2')))));
  const found = codex.discover(dir);
  assert.deepStrictEqual(found, [file]);
  const ps = codex.parse(found[0]);
  assert.strictEqual(ps.meta.id, 'cx-2');
  assert.strictEqual(ps.meta.title, 'Fix the flaky test');
  assert.strictEqual(ps.steps.length, 1);
});

test('Codex: a rollout in both forms is listed once, as the plain file', { skip: !hasZstd }, (t) => {
  const { dir, day } = sessionsDir(t);
  const plain = path.join(day, 'rollout-2026-11-01T10-00-00-cx-3.jsonl');
  fs.writeFileSync(plain, jl(rows('cx-3')));
  fs.writeFileSync(`${plain}.zst`, zlib.zstdCompressSync(Buffer.from(jl(rows('cx-3')))));
  assert.deepStrictEqual(codex.discover(dir), [plain]);
});

test('Codex: a damaged .zst file is an empty session, not a crash', { skip: !hasZstd }, (t) => {
  const { dir, day } = sessionsDir(t);
  fs.writeFileSync(path.join(day, 'rollout-2026-11-01T10-00-00-cx-4.jsonl.zst'), 'not zstd');
  const ps = codex.parse(codex.discover(dir)[0]);
  assert.strictEqual(ps.events.length, 0);
});
