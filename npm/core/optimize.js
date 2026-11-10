'use strict';
// Rules that say what would have cost less (port of optimize/rules.py). Every rule re-prices the
// same tokens (a cheaper model, cache reads instead of uncached input, fewer repeated calls); the
// savings are estimates with a confidence, de-duplicated per session.
const M = require('./models');
const { K } = M;
const U = require('./util');
const { lookup, usageCost } = require('./pricing');
const analysis = require('./analysis');
const { estimateText } = require('./tokens');

const MAX_SESSIONS = 80;
const SESSION_CAP = 0.8;

const DOWNGRADE = [
  ['claude-fable', 'claude-sonnet-5-5'],
  ['claude-opus', 'claude-sonnet-5-5'],
  ['claude-sonnet', 'claude-haiku-5-5'],
  ['gpt-6-astra', 'gpt-6.1-sol'],
  ['gpt-6.1-sol', 'gpt-6.1-terra'],
  ['gpt-5', 'gpt-6.1-terra'],
  ['glm-5', 'glm-4.5-air'],
  ['qwen3-max', 'qwen-plus'],
  ['qwen3-coder-plus', 'qwen3-coder-flash'],
  ['gemini-2.5-pro', 'gemini-2.5-flash'],
  ['gemini-3-pro', 'gemini-3-flash'],
];

const finding = (rule, sessionId, saving, detail, confidence, extra = {}) => ({ rule, session_id: sessionId, saving, detail, confidence, extra });

/** [uncached input, cache read, output] USD per token, or null. */
function unitPrices(model) {
  const p = lookup(model);
  if (p === null) return null;
  const read = p.cache_read_cost_per_m === null ? p.input_cost_per_m : p.cache_read_cost_per_m;
  return [p.input_cost_per_m / 1e6, read / 1e6, p.output_cost_per_m / 1e6];
}

const stepCost = (st) => st.cost_usd || 0;
const f0 = (x) => U.pyRound(x).toFixed(0);

function lowCacheHit(ps) {
  const out = [];
  const byModel = new Map();
  for (const st of ps.steps) {
    if (!byModel.has(st.model)) byModel.set(st.model, []);
    byModel.get(st.model).push(st);
  }
  for (const [model, steps] of byModel) {
    const prices = unitPrices(model);
    if (prices === null || prices[1] >= prices[0] || steps.length < 6) continue;
    const total = U.sum(steps.map(M.totalInput));
    const cached = U.sum(steps.map((s) => s.cache_read_tokens));
    if (total < 150_000 || cached / total >= 0.6) continue;
    const reachable = Math.max(0, 0.85 * total - cached);
    const saving = reachable * (prices[0] - prices[1]) * 0.6;
    if (saving > 0.01) {
      const note = cached === 0 ? ' (some providers do not report cache reads at all)' : '';
      out.push(finding('low_cache_hit', ps.meta.id, saving,
        `${model}: ${f0((100 * cached) / total)}% of ${f0(total / 1000)}k input tokens came from cache${note}`,
        cached === 0 ? 'low' : 'medium', { model, hit_pct: U.pyRound((100 * cached) / total, 1) }));
    }
  }
  return out;
}

function cheaperModel(ps) {
  const main = ps.steps.filter((s) => !s.sidechain);
  if (!main.length || main.length > 10 || ps.events.filter((e) => e.kind === K.TOOL_CALL).length > 4) return [];
  const outTokens = U.sum(main.map((s) => s.output_tokens));
  if (outTokens > 3000) return [];
  const out = [];
  for (const model of new Set(main.map((s) => s.model))) {
    const hit = DOWNGRADE.find(([prefix]) => model.toLowerCase().startsWith(prefix));
    const alt = hit ? hit[1] : null;
    if (!alt || lookup(alt) === null || lookup(model) === null) continue;
    const steps = main.filter((s) => s.model === model);
    const now = U.sum(steps.map(stepCost));
    const then = U.sum(steps.map((s) => usageCost(alt, M.usage(s)) || 0));
    if (now - then > 0.02) {
      out.push(finding('cheaper_model', ps.meta.id, now - then,
        `${steps.length} steps, ${outTokens} output tokens, no heavy tool use: ${model} → ${alt}`, 'medium', { from: model, to: alt }));
    }
  }
  return out;
}

function repeatedCalls(ps) {
  const out = [];
  for (const f of analysis.findings(ps)) {
    if (f.kind !== 'repeated_call') continue;
    const steps = new Set(f.events.map((i) => ps.events[i].step).filter((s) => s !== null));
    const costs = [...steps].filter((i) => i < ps.steps.length).map((i) => stepCost(ps.steps[i])).sort((a, b) => b - a);
    const extra = U.sum(costs.slice(1)); // the first call was needed
    if (extra > 0.01) out.push(finding('repeated_calls', ps.meta.id, extra, f.title, 'medium', { turn: f.turn }));
  }
  return out;
}

function bigToolOutput(ps) {
  const nSteps = ps.steps.length;
  const results = ps.events
    .filter((e) => e.kind === K.TOOL_RESULT && !e.sidechain)
    .map((e) => [e, estimateText(e.text)])
    .filter(([, t]) => t >= 8000);
  if (!results.length || !nSteps) return [];
  const first = ps.steps.find((s) => unitPrices(s.model));
  const prices = first ? unitPrices(first.model) : null;
  if (prices === null) return [];
  let total = 0;
  let biggest = 0;
  for (const [e, tokens] of results) {
    const later = ps.steps.filter((s) => s.first_event > e.idx).length;
    total += (tokens - 3000) * (prices[0] + later * prices[1]);
    biggest = Math.max(biggest, tokens);
  }
  if (total <= 0.02) return [];
  return [finding('big_tool_output', ps.meta.id, total * 0.7,
    `${results.length} tool results over 8k tokens (largest ≈${f0(biggest / 1000)}k)`, 'low', { count: results.length, largest_tokens: biggest })];
}

function longSession(ps) {
  const main = ps.steps.filter((s) => !s.sidechain);
  if (main.length < 40) return [];
  const keep = 40_000;
  let savedTokens = 0;
  const costPerToken = [];
  for (const s of main) {
    if (M.totalInput(s) > 2 * keep) {
      savedTokens += M.totalInput(s) - keep;
      const p = unitPrices(s.model);
      if (p) costPerToken.push(s.cache_read_tokens > s.input_tokens ? p[1] : p[0]);
    }
  }
  if (!costPerToken.length || savedTokens < 1_000_000) return [];
  const saving = savedTokens * (U.sum(costPerToken) / costPerToken.length) * 0.4;
  if (saving < 0.05) return [];
  const last = M.totalInput(main[main.length - 1]);
  return [finding('long_session', ps.meta.id, saving, `${main.length} steps, the context grew to ${f0(last / 1000)}k tokens`, 'low', { steps: main.length, context: last })];
}

const RULES = [lowCacheHit, cheaperModel, repeatedCalls, bigToolOutput, longSession];

const COPY = {
  low_cache_hit: {
    title: 'Use the prompt cache',
    how: 'Keep the start of the conversation stable (system prompt, tools, early messages) so it is cached. Avoid editing earlier messages or reordering tools mid-session, and keep working in one session instead of restarting it.',
    tags: 'cache context',
  },
  cheaper_model: {
    title: 'Use a smaller model for simple tasks',
    how: "Quick questions and small edits do not need the biggest model. Switch with /model (Claude Code) or your agent's model picker for short tasks.",
    tags: 'router gateway model',
  },
  repeated_calls: {
    title: 'Stop repeated tool calls',
    how: 'The agent ran the same command or read the same file several times with identical input. Give it the result once (or a note in CLAUDE.md/AGENTS.md) and ask it not to repeat it.',
    tags: 'dedupe cache',
  },
  big_tool_output: {
    title: 'Trim huge tool outputs',
    how: 'Large outputs (logs, whole files, search dumps) are re-sent with every later step. Use head/tail/grep, read line ranges, or a tool that compresses output before the model sees it.',
    tags: 'compress output',
  },
  long_session: {
    title: 'Start a fresh session when the context gets long',
    how: 'Past ~100k tokens every step re-reads everything. Summarise the state (or use /compact, /clear) and continue in a new session.',
    tags: 'context compact',
  },
};

/** Run every rule over the given sessions (index rows); suggestions and the de-duplicated total. */
function analyze(sessions, load, spend) {
  const findings = [];
  const costs = new Map();
  const meta = new Map();
  for (const row of sessions.slice(0, MAX_SESSIONS)) {
    let ps;
    try {
      ps = load(row.id);
    } catch {
      ps = null;
    }
    if (!ps) continue;
    costs.set(row.id, row.cost_usd || 0);
    meta.set(row.id, row);
    for (const rule of RULES) {
      try {
        findings.push(...rule(ps));
      } catch {
        // one odd session must not hide the rest
      }
    }
  }
  const perSession = new Map();
  for (const f of findings) perSession.set(f.session_id, (perSession.get(f.session_id) || 0) + f.saving);
  const scale = new Map();
  let totalSaving = 0;
  for (const [sid, total] of perSession) {
    const c = costs.get(sid);
    scale.set(sid, total > 0 && c ? Math.min(1, (SESSION_CAP * c) / total) : 1);
    totalSaving += Math.min(total, SESSION_CAP * (costs.has(sid) ? c : total));
  }
  const order = { high: 2, medium: 1, low: 0 };
  const suggestions = [];
  for (const [rule, copy] of Object.entries(COPY)) {
    const fs = findings.filter((f) => f.rule === rule).sort((a, b) => b.saving - a.saving);
    if (!fs.length) continue;
    const sc = (f) => scale.get(f.session_id) ?? 1;
    const saving = U.sum(fs.map((f) => f.saving * sc(f)));
    const confidence = fs.map((f) => f.confidence).reduce((a, b) => (order[b] < order[a] ? b : a));
    suggestions.push({
      id: rule,
      title: copy.title,
      how: copy.how,
      tags: copy.tags.split(' '),
      confidence,
      saving_usd: U.pyRound(saving, 4),
      saving_pct: spend ? U.pyRound((100 * saving) / spend, 1) : 0,
      sessions: new Set(fs.map((f) => f.session_id)).size,
      evidence: fs.slice(0, 8).map((f) => ({
        session_id: f.session_id,
        title: meta.get(f.session_id).title ?? null,
        agent: meta.get(f.session_id).agent ?? null,
        detail: f.detail,
        saving_usd: U.pyRound(f.saving * sc(f), 4),
      })),
    });
  }
  suggestions.sort((a, b) => b.saving_usd - a.saving_usd);
  totalSaving = spend ? Math.min(totalSaving, spend) : 0;
  return {
    spend_usd: U.pyRound(spend, 4),
    saving_usd: U.pyRound(totalSaving, 4),
    optimized_usd: U.pyRound(Math.max(0, spend - totalSaving), 4),
    saving_pct: spend ? U.pyRound((100 * totalSaving) / spend, 1) : 0,
    analyzed_sessions: costs.size,
    suggestions,
  };
}

module.exports = { analyze, RULES, COPY };
