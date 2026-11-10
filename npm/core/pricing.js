'use strict';
// API list prices, USD per million tokens (port of cost/pricing.py; keep the two tables in step).
// Override or extend without code changes in ~/.loopprism/pricing.json (or LOOPPRISM_PRICING_FILE):
//   {"claude-opus-5-5": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5, "cache_write_1h": 8}}
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRICING_AS_OF = '2026-11-09';

function P(input, output, read = null, write = null, write1h = null, longContext = null) {
  return {
    input_cost_per_m: input,
    output_cost_per_m: output,
    cache_read_cost_per_m: read,
    cache_write_cost_per_m: write,
    cache_write_1h_cost_per_m: write1h,
    long_context: longContext,
    long_context_threshold: 100_000,
  };
}
const claude = (inp, out, w5, w1, read, long = null) => P(inp, out, read, w5, w1, long);

const OPUS_45_TO_5 = claude(5, 25, 6.25, 10, 0.5);
const OPUS_4 = claude(15, 75, 18.75, 30, 1.5);
const SONNET_4 = claude(3, 15, 3.75, 6, 0.3);
const FABLE_5 = claude(10, 50, 12.5, 20, 1.0);
const FABLE_51 = claude(10, 50, 12.5, 20, 0.25);
const FABLE_52 = claude(8, 40, 10, 16, 0.2);

// Newest first.
const ANTHROPIC = {
  'claude-fable-5-2': FABLE_52,
  'claude-mythos-5-2': FABLE_52,
  'claude-fable-5-1': FABLE_51,
  'claude-mythos-5-1': FABLE_51,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': claude(4, 20, 5, 8, 0.2),
  'claude-opus-5': OPUS_45_TO_5,
  'claude-opus-4-8': OPUS_45_TO_5,
  'claude-opus-4-7': OPUS_45_TO_5,
  'claude-opus-4-6': OPUS_45_TO_5,
  'claude-opus-4-5': OPUS_45_TO_5,
  'claude-opus-4-1': OPUS_4,
  'claude-opus-4': OPUS_4,
  'claude-sonnet-5-5': claude(2, 10, 2.5, 4, 0.1),
  'claude-sonnet-5': claude(2, 10, 2.5, 4, 0.2),
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': claude(0.1, 0.5, 0.125, 0.2, 0.01, claude(0.5, 2.5, 0.625, 1, 0.05)),
  'claude-haiku-4-5': claude(1, 5, 1.25, 2, 0.1),
  'claude-haiku-3-5': claude(0.8, 4, 1, 1.6, 0.08),
  'claude-3-5-haiku': claude(0.8, 4, 1, 1.6, 0.08),
};

const GPT_5_CODEX = P(1.25, 10.0, 0.125);
const OPENAI = {
  'gpt-6-astra': P(10.0, 50.0, 1.0),
  'gpt-6.1-sol': P(2.0, 10.0, 0.1),
  'gpt-6.1-terra': P(1.0, 5.0, 0.05),
  'gpt-6-luna': P(0.1, 0.5, 0.01),
  'gpt-5.6-sol': P(4.0, 20.0, 0.4),
  'gpt-5.6-cyber': P(12.5, 75.0, 1.25),
  'gpt-5.3-codex': P(1.75, 14.0, 0.175),
  'gpt-5.1-codex-max': GPT_5_CODEX,
  'gpt-5.1-codex': GPT_5_CODEX,
  'gpt-5-codex': GPT_5_CODEX,
  'gpt-5': GPT_5_CODEX,
};

const OTHER = {
  'deepseek-chat': P(0.28, 0.42, 0.028),
  'deepseek-reasoner': P(0.28, 0.42, 0.028),
  'deepseek-v3.2': P(0.28, 0.42, 0.028),
  'deepseek-v3.1': P(0.56, 1.68, 0.07),
  'deepseek-r1': P(0.55, 2.19, 0.14),
  'minimax-m2': P(0.3, 1.2, 0.03, 0.375),
  'minimax-m2.1': P(0.3, 1.2, 0.03, 0.375),
  'glm-4.5': P(0.6, 2.2, 0.11),
  'glm-4.5-air': P(0.2, 1.1, 0.03),
  'glm-4.5-flash': P(0.0, 0.0),
  'glm-4.6': P(0.6, 2.2, 0.11),
  'glm-4.7': P(0.6, 2.2, 0.11),
  'glm-5': P(1.0, 3.2, 0.2),
  'qwen3-max': P(1.2, 6.0),
  'qwen-max': P(1.6, 6.4),
  'qwen-plus': P(0.4, 1.2),
  'qwen-flash': P(0.05, 0.4),
  'qwen3-coder-plus': P(1.0, 5.0),
  'qwen3-coder-flash': P(0.3, 1.5),
  'kimi-k2': P(0.6, 2.5, 0.15),
  'kimi-k2-thinking': P(0.6, 2.5, 0.15),
  'gemini-2.5-pro': P(1.25, 10.0, 0.125),
  'gemini-2.5-flash': P(0.3, 2.5, 0.03),
  'gemini-2.5-flash-lite': P(0.1, 0.4, 0.01),
  'gemini-3-pro': P(2.0, 12.0, 0.2),
  'gemini-3-flash': P(0.5, 3.0, 0.05),
};

const FREE = new Set(['big-pickle']);

const FAMILIES = [
  ['deepseek-r', OTHER['deepseek-r1']],
  ['deepseek', OTHER['deepseek-v3.2']],
  ['minimax', OTHER['minimax-m2.1']],
  ['glm-4.5-air', OTHER['glm-4.5-air']],
  ['glm-4', OTHER['glm-4.7']],
  ['glm-', OTHER['glm-5']],
  ['qwen3-coder-flash', OTHER['qwen3-coder-flash']],
  ['qwen3-coder', OTHER['qwen3-coder-plus']],
  ['qwen3-max', OTHER['qwen3-max']],
  ['qwen-flash', OTHER['qwen-flash']],
  ['qwen', OTHER['qwen-plus']],
  ['kimi', OTHER['kimi-k2']],
  ['gemini-3-flash', OTHER['gemini-3-flash']],
  ['gemini-3', OTHER['gemini-3-pro']],
  ['gemini-2.5-flash-lite', OTHER['gemini-2.5-flash-lite']],
  ['gemini-2.5-flash', OTHER['gemini-2.5-flash']],
  ['gemini', OTHER['gemini-2.5-pro']],
];

/** `us.anthropic.claude-opus-4-5-20251101-v1:0`, `claude-opus-4.5`, `claude-opus-4-5[1m]` → `claude-opus-4-5`. */
function normalizeModel(model) {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[.*?\]$/, '');
  m = m.slice(m.lastIndexOf('/') + 1);
  if (/^(us|eu|apac|global)\./.test(m)) m = m.slice(m.indexOf('.') + 1);
  if (m.startsWith('anthropic.')) m = m.slice('anthropic.'.length);
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  m = m.replace(/-(?:20\d{6}|latest)$/, '');
  if (m.startsWith('claude-')) m = m.replace(/(\d)\.(\d)/g, '$1-$2');
  return m;
}

let overridesCache = { mtime: -1, table: {} };

function overridePath() {
  return process.env.LOOPPRISM_PRICING_FILE || path.join(os.homedir(), '.loopprism', 'pricing.json');
}

function overrides() {
  const file = overridePath();
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    overridesCache = { mtime: -1, table: {} };
    return {};
  }
  if (mtime === overridesCache.mtime) return overridesCache.table;
  let table = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const opt = (v) => (v === null || v === undefined ? null : Number(v));
    for (const [name, p] of Object.entries(raw)) {
      if (p.input === undefined || p.output === undefined) throw new Error('missing price');
      table[normalizeModel(name)] = P(Number(p.input), Number(p.output), opt(p.cache_read), opt(p.cache_write), opt(p.cache_write_1h));
    }
  } catch {
    table = {};
  }
  overridesCache = { mtime, table };
  return table;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A model's price from any table (or the user's overrides), else null. */
function lookup(model) {
  if (!model) return null;
  const key = normalizeModel(model);
  const over = overrides();
  if (has(over, key)) return over[key];
  for (const table of [ANTHROPIC, OPENAI, OTHER]) if (has(table, key)) return table[key];
  if (key.endsWith('-free') || FREE.has(key)) return P(0, 0);
  for (const [prefix, pricing] of FAMILIES) if (key.startsWith(prefix)) return pricing;
  return null;
}

const priceOr = (v, dflt) => (v === null || v === undefined ? dflt : v);

/** Unit prices (USD per million) of a pricing, with the cache prices defaulted to the input price. */
function rates(p) {
  return {
    input: p.input_cost_per_m,
    read: priceOr(p.cache_read_cost_per_m, p.input_cost_per_m),
    write: priceOr(p.cache_write_cost_per_m, p.input_cost_per_m),
    write1h: priceOr(p.cache_write_1h_cost_per_m, p.input_cost_per_m),
    output: p.output_cost_per_m,
  };
}

function pricingFor(model, usage) {
  let p = lookup(model);
  if (p === null) return null;
  if (usage.long_context && p.long_context) p = p.long_context;
  return p;
}

/** USD cost of one model's usage, or null when the model has no known price. */
function usageCost(model, usage) {
  const p = pricingFor(model, usage);
  if (p === null) return null;
  const r = rates(p);
  const n = (k) => Math.trunc(Number(usage[k] || 0));
  return (
    n('input_tokens') * r.input +
    n('output_tokens') * r.output +
    n('cache_read_tokens') * r.read +
    n('cache_write_tokens') * r.write +
    n('cache_write_1h_tokens') * r.write1h
  ) / 1_000_000;
}

function usageCostParts(model, usage) {
  const p = pricingFor(model, usage);
  if (p === null) return null;
  const r = rates(p);
  const n = (k) => Math.trunc(Number(usage[k] || 0));
  return {
    input: (n('input_tokens') * r.input) / 1e6,
    cache_read: (n('cache_read_tokens') * r.read) / 1e6,
    cache_write: (n('cache_write_tokens') * r.write + n('cache_write_1h_tokens') * r.write1h) / 1e6,
    output: (n('output_tokens') * r.output) / 1e6,
  };
}

module.exports = { PRICING_AS_OF, normalizeModel, lookup, rates, usageCost, usageCostParts };
