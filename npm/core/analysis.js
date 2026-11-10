'use strict';
// Findings, timing and cost derived from a parsed session (port of sessions/analysis.py).
const M = require('./models');
const { K } = M;
const U = require('./util');
const { lookup, rates } = require('./pricing');
const context = require('./context');

const REPEAT_THRESHOLD = 3;
const ERROR_STREAK = 3;
const IDLE_CAP_MS = 5 * 60 * 1000;

const digest = (v) => U.pyDumps(v, { sortKeys: true });

/** Loops and failure patterns: the things worth looking at first. */
function findings(ps) {
  const out = [];
  const seen = new Map();
  for (const e of ps.events) {
    if (e.kind === K.TOOL_CALL && !e.sidechain) {
      const key = JSON.stringify([e.turn, e.tool_name || '', digest(e.tool_input)]);
      if (!seen.has(key)) seen.set(key, { turn: e.turn, tool: e.tool_name || '', idxs: [] });
      seen.get(key).idxs.push(e.idx);
    }
  }
  for (const { turn, tool, idxs } of seen.values()) {
    if (idxs.length >= REPEAT_THRESHOLD) {
      out.push({ kind: 'repeated_call', severity: 'warn', title: `${tool} called ${idxs.length}× with identical input`, turn, events: idxs });
    }
  }
  let streak = [];
  const flush = () => {
    if (streak.length >= ERROR_STREAK) {
      out.push({ kind: 'error_streak', severity: 'error', title: `${streak.length} tool errors in a row`, turn: ps.events[streak[0]].turn, events: streak });
    }
    streak = [];
  };
  for (const e of ps.events) {
    if (e.kind !== K.TOOL_RESULT) continue;
    if (e.is_error) {
      streak.push(e.idx);
      continue;
    }
    flush();
  }
  flush();
  for (const e of ps.events) {
    if (e.kind === K.COMPACTION && ['compact_boundary', 'summary', 'compaction'].includes(e.label)) {
      out.push({ kind: 'compaction', severity: 'info', title: 'Context was compacted', turn: e.turn, events: [e.idx] });
    }
  }
  out.sort((a, b) => a.events[0] - b.events[0]);
  return out;
}

/** Where the time went, from transcript timestamps (approximate). */
function timing(ps) {
  const steps = ps.steps.filter((s) => !s.sidechain && s.model !== '<synthetic>');
  const modelMs = U.sum(steps.map((s) => s.model_ms || 0));
  const thinkingMs = Math.min(modelMs, U.sum(steps.map((s) => s.thinking_ms || 0)));
  const toolsMs = U.sum(steps.map((s) => s.tools_ms || 0));
  const outTokens = U.sum(steps.filter((s) => s.model_ms).map((s) => s.output_tokens));
  let wallMs = 0;
  const last = new Map();
  for (const e of ps.events) {
    if (!e.ts || e.sidechain) continue;
    const prev = last.get(e.turn);
    if (prev) {
      const d = U.isoMs(prev, e.ts);
      if (d) wallMs += Math.min(d, IDLE_CAP_MS);
    }
    last.set(e.turn, e.ts);
  }
  const overhead = Math.max(0, wallMs - (modelMs + toolsMs));
  return {
    approximate: true,
    model_ms: U.pyRound(modelMs),
    thinking_ms: U.pyRound(thinkingMs),
    answer_ms: U.pyRound(Math.max(0, modelMs - thinkingMs)),
    tools_ms: U.pyRound(toolsMs),
    overhead_ms: U.pyRound(overhead),
    wall_ms: U.pyRound(wallMs),
    tokens_per_second: modelMs ? U.pyRound(outTokens / (modelMs / 1000), 1) : null,
    steps: steps.map((s) => ({ step: s.index, turn: s.turn, model_ms: s.model_ms, thinking_ms: s.thinking_ms, tools_ms: s.tools_ms, output_tokens: s.output_tokens })),
  };
}

const COST_TYPE_LABELS = { input: 'Uncached input', cache_read: 'Cache reads', cache_write: 'Cache writes', output: 'Output' };

/** Where the (estimated, API list price) money went: by token type, context category, model and turn. */
function costBreakdown(ps) {
  const trend = new Map(context.trend(ps).map((p) => [p.step, p]));
  const byType = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  const byCat = new Map();
  const byModel = new Map();
  const byTurn = new Map();
  const steps = [];
  let unpriced = 0;
  let subagent = 0;
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);

  for (const st of ps.steps) {
    if (st.model === '<synthetic>') continue;
    let pr = lookup(st.model);
    if (pr === null) {
      unpriced += 1;
      continue;
    }
    if (M.totalInput(st) > pr.long_context_threshold && pr.long_context) pr = pr.long_context;
    const r = rates(pr);
    const cIn = (st.input_tokens * r.input) / 1e6;
    const cRead = (st.cache_read_tokens * r.read) / 1e6;
    const cWrite = (st.cache_write_tokens * r.write + st.cache_write_1h_tokens * r.write1h) / 1e6;
    const cOut = (st.output_tokens * r.output) / 1e6;
    const total = cIn + cRead + cWrite + cOut;
    byType.input += cIn;
    byType.cache_read += cRead;
    byType.cache_write += cWrite;
    byType.output += cOut;
    bump(byModel, st.model, total);
    bump(byTurn, st.turn, total);
    steps.push([total, st.index, st.turn]);
    if (st.sidechain) subagent += total;
    const inputSide = cIn + cRead + cWrite;
    const cats = U.or((trend.get(st.index) || {}).categories, {});
    const denom = U.sum(Object.values(cats));
    if (denom) for (const [k, tokens] of Object.entries(cats)) bump(byCat, k, (inputSide * tokens) / denom);
    else bump(byCat, 'unattributed', inputSide);
    bump(byCat, 'output', cOut);
  }

  const total = U.sum(Object.values(byType));
  const catLabels = Object.fromEntries(context.CATEGORIES);
  catLabels.output = 'Generated output';
  const desc = (a, b) => b[1] - a[1];
  return {
    total_usd: U.pyRound(total, 6),
    subagent_usd: subagent ? U.pyRound(subagent, 6) : null,
    unpriced_steps: unpriced,
    by_type: Object.entries(byType).filter(([, v]) => v).map(([k, v]) => ({ key: k, label: COST_TYPE_LABELS[k], usd: U.pyRound(v, 6) })),
    by_category: [...byCat.entries()].sort(desc).filter(([, v]) => v).map(([k, v]) => ({ key: k, label: catLabels[k] ?? k, usd: U.pyRound(v, 6) })),
    by_model: [...byModel.entries()].sort(desc).map(([m, v]) => ({ model: m, usd: U.pyRound(v, 6) })),
    by_turn: [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ turn: t, usd: U.pyRound(v, 6) })),
    top_steps: steps
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
      .slice(0, 5)
      .map(([c, i, t]) => ({ step: i, turn: t, usd: U.pyRound(c, 6) })),
  };
}

module.exports = { findings, timing, costBreakdown };
