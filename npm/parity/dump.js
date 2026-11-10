#!/usr/bin/env node
'use strict';
// The Node twin of scripts/parity_dump.py: the same per-session JSON from the Node core.
//   node npm/parity/dump.js sessions.json > node.jsonl
const crypto = require('crypto');
const fs = require('fs');
const { eventToDict } = require('../core/models');
const context = require('../core/context');
const analysis = require('../core/analysis');
const agents = require('../core/agents');
const actions = require('../core/actions');
const optimize = require('../core/optimize');
const PARSERS = {
  'claude-code': require('../core/adapters/claude_code'),
  codex: require('../core/adapters/codex'),
  gemini: require('../core/adapters/gemini'),
  opencode: require('../core/adapters/opencode'),
  cursor: require('../core/adapters/cursor'),
  dsh: require('../core/adapters/dsh'),
  workbuddy: require('../core/adapters/workbuddy'),
};

const h = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);

function pickedSteps(ps) {
  const real = ps.steps.filter((s) => s.model !== '<synthetic>').map((s) => s.index);
  if (real.length <= 6) return real;
  return [...new Set([real[0], real[1], real[Math.floor(real.length / 2)], real[real.length - 2], real[real.length - 1]])].sort((a, b) => a - b);
}

function dump(path, agent) {
  const ps = PARSERS[agent].parse(path);
  const out = { path, agent };
  out.meta = { ...ps.meta };
  out.events = ps.events.map((e) => {
    const d = eventToDict(e);
    d.text = h(d.text);
    return d;
  });
  out.steps = ps.steps.map((s) => ({ ...s, refs: s.refs === null ? null : [s.refs.length, h(s.refs.join('|'))] }));
  out.search = h(ps.search_text);
  out.unresolved = ps.unresolved;
  out.pool = ps.pool.size;
  out.shapes = [...ps.shapes.keys()].sort();
  out.stats = context.stats(ps);
  out.findings = analysis.findings(ps);
  out.timing = analysis.timing(ps);
  out.cost = analysis.costBreakdown(ps);
  out.trend = context.trend(ps);
  out.step_context = pickedSteps(ps).map((i) => {
    const c = context.stepContext(ps, i, true);
    c.items = Object.fromEntries(Object.entries(c.items).map(([k, v]) => [k, v.map((x) => [x.label, x.tokens, h(x.preview)])]));
    return c;
  });
  out.agents = agents.build(ps);
  for (const a of out.agents.agents) for (const k of ['task', 'result']) if (a[k]) a[k].text = h(a[k].text);
  out.export = h(actions.exportMarkdown(ps));
  const found = [];
  for (const rule of optimize.RULES) for (const f of rule(ps)) found.push([f.rule, f.saving, f.detail, f.confidence]);
  out.optimize = found.sort((a, b) => (a[0] + '\0' + a[2] < b[0] + '\0' + b[2] ? -1 : 1));
  return out;
}

for (const [path, agent] of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  let rec;
  try {
    rec = dump(path, agent);
  } catch (err) {
    rec = { path, agent, error: `${err.name}: ${err.message}` };
  }
  process.stdout.write(JSON.stringify(rec) + '\n');
}
