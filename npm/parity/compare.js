#!/usr/bin/env node
'use strict';
// Parity test of the Node core against the Python original, on the sessions of this machine
// (or of the roots in CLAUDE_CONFIG_DIR, CODEX_HOME, ...). Nothing leaves the machine.
//
//   node npm/parity/compare.js [--per-agent N] [--agent codex]
//
// Needs `uv` (runs the Python side with only the zstandard package), or PARITY_PYTHON. Exit code 1 on
// any difference. CI runs it on made-up sessions: scripts/make_parity_fixtures.py.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../core/store');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const perAgent = Number(opt('--per-agent', '1000000'));
const onlyAgent = opt('--agent', null);
const repo = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-parity-'));

const store = new SessionStore({ indexPath: ':memory:' });
const byAgent = new Map();
for (const [p, agent] of store.discover()) {
  if (onlyAgent && agent !== onlyAgent) continue;
  if (!byAgent.has(agent)) byAgent.set(agent, []);
  byAgent.get(agent).push(p);
}
const todo = [];
for (const [agent, paths] of byAgent) for (const p of paths.slice(0, perAgent)) todo.push([p, agent]);
const list = path.join(tmp, 'sessions.json');
fs.writeFileSync(list, JSON.stringify(todo));

const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: repo, maxBuffer: 2 ** 31 - 1, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(2);
  }
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const t0 = Date.now();
// PARITY_PYTHON: a Python (3.12+, for its compensated float sums) that has zstandard installed; else uv provides one.
const py = process.env.PARITY_PYTHON
  ? run(process.env.PARITY_PYTHON, ['scripts/parity_dump.py', list])
  : run('uv', ['run', '--quiet', '--no-project', '--python', '>=3.12', '--with', 'zstandard', 'python', 'scripts/parity_dump.py', list]);
const t1 = Date.now();
const js = run(process.execPath, ['npm/parity/dump.js', list]);
const t2 = Date.now();

function diff(a, b, where, out) {
  if (out.length > 12) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-6 + 1e-9 * Math.abs(a)) out.push(`${where}: py=${a} js=${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b && !(a == null && b == null)) out.push(`${where}: py=${JSON.stringify(a)?.slice(0, 120)} js=${JSON.stringify(b)?.slice(0, 120)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return out.push(`${where}: type differs`);
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${where}: length py=${a.length} js=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${where}.${k}`, out);
}

const results = new Map();
let failed = 0;
for (let i = 0; i < todo.length; i++) {
  const [p, agent] = todo[i];
  const out = [];
  diff(py[i], js[i], '', out);
  const r = results.get(agent) || { ok: 0, bad: 0, events: 0, steps: 0 };
  r.events += (py[i].events || []).length;
  r.steps += (py[i].steps || []).length;
  if (out.length) {
    r.bad += 1;
    failed += 1;
    if (failed <= 15) console.log(`\n✗ ${agent} ${p}\n  ` + out.slice(0, 8).join('\n  '));
  } else r.ok += 1;
  results.set(agent, r);
}
console.log('\nagent        sessions  identical  events   steps');
for (const [agent, r] of results) {
  console.log(`${agent.padEnd(12)} ${String(r.ok + r.bad).padStart(8)} ${String(r.ok).padStart(10)} ${String(r.events).padStart(7)} ${String(r.steps).padStart(7)}`);
}
console.log(`\nPython ${((t1 - t0) / 1000).toFixed(1)}s, Node ${((t2 - t1) / 1000).toFixed(1)}s`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
