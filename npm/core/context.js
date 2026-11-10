'use strict';
// Per-step context breakdown: what filled the model's input, by category (port of sessions/context.py).
// Real totals come from the usage the model reported; the split across categories is estimated from
// the text of each piece and scaled so the parts add up to the reported total.
const M = require('./models');
const { K } = M;
const U = require('./util');
const { estimateText, estimateJson } = require('./tokens');
const { classifyText } = require('./adapters/claude_code');

const CATEGORIES = [
  ['system_prompt', 'System Prompt'],
  ['tool_schemas', 'Tool Schemas'],
  ['user', 'User Messages'],
  ['injected', 'Injected Context'],
  ['skills', 'Skill Injections'],
  ['assistant', 'Assistant Messages'],
  ['tool_results', 'Tool Results'],
  ['unattributed', 'System & tools (inferred)'],
];

const WINDOW_PREFIXES = [
  ['claude-fable', 1_000_000],
  ['claude-mythos', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-haiku-5', 1_000_000],
  ['claude-', 200_000],
  ['gpt-', 400_000],
  ['deepseek', 128_000],
];

const PREVIEW = 160;
const IMAGE_TOKENS = 1500;
const dumps = (v) => U.pyDumps(v, { ensureAscii: false });
const pv = (s) => U.cpSlice(s, PREVIEW);

function windowFor(step) {
  if (step.context_window) return [step.context_window, 'reported'];
  const model = step.model.toLowerCase();
  for (const [prefix, size] of WINDOW_PREFIXES) if (model.startsWith(prefix)) return [size, 'assumed'];
  return [null, 'unknown'];
}

/** Claude 4.7+ tokenizes ~30% more finely than the chars/3.8 heuristic assumes. */
function tokenizerFactor(model) {
  const fine = ['claude-fable', 'claude-mythos', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-opus-4-8', 'claude-opus-4-7'];
  return fine.some((p) => model.startsWith(p)) ? 1.35 : 1.0;
}

const textBlocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []).filter(U.isObj));
const countImages = (content) => (Array.isArray(content) ? content.filter((b) => U.isObj(b) && b.type === 'image').length : 0);

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(U.isObj).map((b) => U.or(b.text, `[${U.pyStr(b.type)}]`)).join('\n');
}

/** Split one request message into [category, label, est_tokens, preview]. */
function classifyMessage(msg) {
  const role = msg.role;
  const out = [];
  for (const b of textBlocks(msg.content)) {
    const bt = b.type;
    if (role === 'assistant') {
      if (bt === 'tool_use') {
        const text = dumps({ name: U.get(b, 'name', null), input: U.get(b, 'input', null) });
        out.push(['assistant', `tool call · ${U.pyStr(U.get(b, 'name', null))}`, estimateText(text), pv(text)]);
      } else if (bt === 'thinking') {
        const text = U.or(b.thinking, '');
        const sig = U.or(b.signature, '').length;
        out.push(['assistant', 'thinking', estimateText(text) + sig / 4, U.or(pv(text), '(thinking)')]);
      } else {
        const text = U.or(b.text, '');
        out.push(['assistant', 'assistant', estimateText(text), pv(text)]);
      }
    } else if (bt === 'tool_result') {
      const text = toolResultText(b.content);
      out.push(['tool_results', 'tool result', estimateText(text) + IMAGE_TOKENS * countImages(b.content), pv(text)]);
    } else if (bt === 'text') {
      const text = U.or(b.text, '');
      let [kind, label] = classifyText(text);
      if (role === 'system' && kind === K.USER) [kind, label] = [K.CONTEXT, 'system'];
      if (kind === K.CONTEXT) out.push([label === 'skill' ? 'skills' : 'injected', U.or(label, 'context'), estimateText(text), pv(U.strip(text))]);
      else out.push(['user', 'user', estimateText(text), pv(text)]);
    } else if (bt === 'image') {
      out.push(['user', 'image', IMAGE_TOKENS, '[image]']);
    } else {
      out.push(['injected', U.or(bt, 'block'), estimateJson(b), pv(dumps(b))]);
    }
  }
  return out;
}

function eventItem(e) {
  switch (e.kind) {
    case K.USER:
      return ['user', 'user', estimateText(e.text), pv(e.text)];
    case K.CONTEXT:
      return [e.label === 'skill' ? 'skills' : 'injected', U.or(e.label, 'context'), estimateText(e.text), pv(U.strip(e.text))];
    case K.ASSISTANT:
      return ['assistant', 'assistant', estimateText(e.text), pv(e.text)];
    case K.THINKING:
      return ['assistant', 'thinking', estimateText(e.text) + 20, U.or(pv(e.text), '(thinking)')];
    case K.TOOL_CALL: {
      const text = dumps({ name: e.tool_name, input: e.tool_input });
      return ['assistant', `tool call · ${U.pyStr(e.tool_name)}`, estimateText(text), pv(text)];
    }
    case K.TOOL_RESULT:
      return ['tool_results', 'tool result', estimateText(e.text) + IMAGE_TOKENS * (e.text.split('[image]').length - 1), pv(e.text)];
    case K.COMPACTION:
      return ['user', 'compaction summary', estimateText(e.text), pv(e.text)];
    default:
      return null;
  }
}

function shapeItems(ps, step) {
  const shape = U.or(ps.shapes.get(U.or(step.system_key, '')), {});
  const sys = U.or(shape.system, []).map((b, i) => {
    const text = U.isObj(b) ? U.get(b, 'text', null) : U.pyStr(b);
    return ['system_prompt', `system block ${i + 1}`, estimateText(U.or(text, '')), pv(U.strip(U.or(text, '')))];
  });
  const tools = U.or(shape.tools, []).map((t) => [
    'tool_schemas',
    U.isObj(t) ? U.get(t, 'name', 'tool') : 'tool',
    estimateJson(t),
    pv(U.isObj(t) ? U.pyStr(U.get(t, 'description', '')) : ''),
  ]);
  return [sys, tools];
}

class StepContext {
  constructor(items, actual, inferred, factor = 1.0) {
    this.items = items;
    this.actual = actual;
    this.factor = factor;
    const est = U.sum(items.map((i) => i[2])) * factor;
    this.estimated = est;
    this.inferred = inferred;
    if (inferred) {
      this.unattributed = actual ? Math.max(0, actual - est) : 0;
      this.scale = est && actual && est > actual ? actual / est : 1.0;
    } else {
      this.unattributed = 0;
      this.scale = est && actual ? actual / est : 1.0;
    }
  }
  totals() {
    const out = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
    for (const [cat, , est] of this.items) out[cat] += est * this.factor * this.scale;
    out.unattributed = this.unattributed;
    return out;
  }
}

const cache = new WeakMap();
function memo(ps) {
  if (!cache.has(ps)) cache.set(ps, { msg: new Map() });
  return cache.get(ps);
}

/** Per-event context items (main thread only), computed once per session. */
function eventItems(ps) {
  const c = memo(ps);
  if (c.ev) return c.ev;
  const idxs = [];
  const items = [];
  const resets = [];
  for (const e of ps.events) {
    if (e.sidechain) continue;
    const it = eventItem(e);
    if (e.kind === K.COMPACTION && (e.label === 'summary' || e.label === 'compact_boundary')) resets.push(items.length);
    if (it) {
      idxs.push(e.idx);
      items.push(it);
    }
  }
  c.ev = [idxs, items, resets];
  return c.ev;
}

function itemsForStep(ps, step) {
  const msgCache = memo(ps).msg;
  const [sys, tools] = shapeItems(ps, step);
  const recorded = sys.length > 0 || tools.length > 0;
  if (step.refs !== null && step.refs !== undefined) {
    const items = [...sys, ...tools];
    for (const h of step.refs) {
      let cl = msgCache.get(h);
      if (cl === undefined) {
        const m = ps.pool.get(h);
        cl = U.T(m) ? classifyMessage(m) : [];
        msgCache.set(h, cl);
      }
      items.push(...cl);
    }
    return [items, !recorded, step.refs];
  }
  // Rebuild from the conversation so far, from the last compaction on.
  const [idxs, evitems, resets] = eventItems(ps);
  const hi = U.bisectLeft(idxs, step.first_event);
  const r = U.bisectLeft(resets, hi);
  const lo = r > 0 ? resets[r - 1] : 0;
  return [[...sys, ...tools, ...evitems.slice(lo, hi)], !recorded, null];
}

function stepContext(ps, index, detail = false) {
  const step = ps.steps[index];
  const [items, inferred, refs] = itemsForStep(ps, step);
  const total = M.totalInput(step);
  const ctx = new StepContext(items, total, inferred, tokenizerFactor(step.model));
  const totals = ctx.totals();
  const [window, windowSrc] = windowFor(step);
  const cats = [];
  for (const [key, label] of CATEGORIES) {
    if (key === 'unattributed' && !inferred) continue;
    cats.push({ key, label, tokens: U.pyRound(totals[key]), items: items.filter((i) => i[0] === key).length });
  }
  const sumTokens = U.sum(cats.map((c) => c.tokens)) || 1;
  for (const c of cats) c.pct = U.pyRound((100 * c.tokens) / sumTokens, 1);
  const out = {
    step: step.index,
    turn: step.turn,
    ts: step.ts,
    model: step.model,
    sidechain: step.sidechain,
    exact_request: step.refs !== null && step.refs !== undefined,
    actual_input: total,
    estimated_input: U.pyRound(ctx.estimated),
    window,
    window_source: windowSrc,
    window_pct: window ? U.pyRound((100 * total) / window, 1) : null,
    output_tokens: step.output_tokens,
    cache_hit_pct: total ? U.pyRound((100 * step.cache_read_tokens) / total, 2) : null,
    cost_usd: step.cost_usd,
    categories: cats,
  };
  if (detail) {
    const byCat = {};
    for (const [cat, label, est, preview] of items) {
      (byCat[cat] ||= []).push({ label, tokens: U.pyRound(est * ctx.factor * ctx.scale), preview });
    }
    if (inferred && ctx.unattributed) {
      byCat.unattributed = [{ label: 'system prompt + tool schemas (not recorded)', tokens: U.pyRound(ctx.unattributed), preview: '' }];
    }
    out.items = byCat;
    out.message_hashes = refs;
  }
  return out;
}

/** Category totals for every non-synthetic step. */
function trend(ps) {
  const c = memo(ps);
  if (c.trend) return c.trend;
  const out = [];
  let prev = 0;
  for (const st of ps.steps) {
    if (st.model === '<synthetic>') continue;
    const [items, inferred] = itemsForStep(ps, st);
    const total = M.totalInput(st);
    const ctx = new StepContext(items, total, inferred, tokenizerFactor(st.model));
    const totals = {};
    for (const [k, v] of Object.entries(ctx.totals())) if (v) totals[k] = U.pyRound(v);
    out.push({
      step: st.index,
      turn: st.turn,
      sidechain: st.sidechain,
      total,
      delta: total - prev,
      categories: totals,
      output_tokens: st.output_tokens,
      cache_hit_pct: total ? U.pyRound((100 * st.cache_read_tokens) / total, 2) : null,
    });
    if (!st.sidechain) prev = total;
  }
  c.trend = out;
  return out;
}

function stats(ps) {
  const main = ps.steps.filter((s) => !s.sidechain && s.model !== '<synthetic>');
  const sub = ps.steps.filter((s) => s.sidechain);
  const totalIn = U.sum(main.map(M.totalInput));
  const costOf = (xs) => (xs.some((s) => s.cost_usd !== null) ? U.sum(xs.map((s) => s.cost_usd || 0)) : null);
  const cost = costOf(main);
  const subCost = costOf(sub);
  const last = main.length ? main[main.length - 1] : null;
  const [window, src] = last ? windowFor(last) : [null, 'unknown'];
  return {
    turns: ps.meta.turns,
    steps: main.length,
    human_inputs: ps.events.filter((e) => e.kind === K.USER && !e.sidechain).length,
    tool_calls: ps.events.filter((e) => e.kind === K.TOOL_CALL && !e.sidechain).length,
    cache_hit_pct: totalIn ? U.pyRound((100 * U.sum(main.map((s) => s.cache_read_tokens))) / totalIn, 2) : null,
    cost_usd: cost !== null ? U.pyRound(cost, 6) : null,
    subagent_cost_usd: subCost !== null ? U.pyRound(subCost, 6) : null,
    current_context: last ? M.totalInput(last) : 0,
    window,
    window_source: src,
    fidelity: ps.meta.fidelity,
    unresolved_messages: ps.unresolved,
    models: ps.meta.models,
  };
}

module.exports = { CATEGORIES, windowFor, stepContext, trend, stats, classifyMessage };
