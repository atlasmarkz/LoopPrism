'use strict';
// The Optimize page's extras (port of optimize/adoption.py, config.py, ai.py and tools.py):
// which suggestions the user adopted and what spending did afterwards, the settings file, the
// optional AI analysis (aggregate numbers only, sent after the user confirmed) and tools that help.
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');

// ------------------------------------------------------------------ adoptions
const BASELINE_DAYS = 14;
const MIN_DAYS_AFTER = 3;
const isoDay = (d) => d.toISOString().slice(0, 10);
const today = () => new Date(isoDay(new Date()) + 'T00:00:00Z');
const addDays = (d, n) => new Date(d.getTime() + n * 86400_000);

class Adoptions {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS adoptions (rule TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL, baseline TEXT)');
  }

  /** Spend, calls, cost per call and cache hit rate for the days start..end (inclusive). */
  metrics(start, end) {
    const r = this.db
      .prepare('SELECT SUM(steps) steps, SUM(cost) cost, SUM(priced) priced, SUM(input) input, SUM(cache_read) cache_read, SUM(cache_write) cache_write, COUNT(DISTINCT day) days FROM usage WHERE day >= ? AND day <= ?')
      .get(start, end);
    const steps = Number(r.steps || 0);
    const priced = Number(r.priced || 0);
    const totalIn = Number(r.input || 0) + Number(r.cache_read || 0) + Number(r.cache_write || 0);
    const cost = Number(r.cost || 0);
    return {
      start, end, active_days: Number(r.days || 0), steps, spend_usd: U.pyRound(cost, 4),
      cost_per_call: priced ? U.pyRound(cost / priced, 6) : null,
      cache_hit_pct: totalIn ? U.pyRound((100 * Number(r.cache_read || 0)) / totalIn, 1) : null,
    };
  }

  states() {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM adoptions').all()) out[r.rule] = this.present({ ...r });
    return out;
  }

  adopt(rule) {
    const t = today();
    const base = this.metrics(isoDay(addDays(t, -BASELINE_DAYS)), isoDay(addDays(t, -1)));
    this.db.prepare('INSERT OR REPLACE INTO adoptions VALUES (?,?,?,?)').run(rule, 'adopted', isoDay(t), JSON.stringify(base));
    return this.states()[rule];
  }

  dismiss(rule) {
    this.db.prepare('INSERT OR REPLACE INTO adoptions VALUES (?,?,?,NULL)').run(rule, 'dismissed', isoDay(today()));
    return this.states()[rule];
  }

  reset(rule) {
    this.db.prepare('DELETE FROM adoptions WHERE rule = ?').run(rule);
  }

  present(row) {
    const out = { state: row.state, at: row.at };
    if (row.state !== 'adopted' || !row.baseline) return out;
    const base = JSON.parse(row.baseline);
    const t = today();
    const days = Math.round((t - new Date(row.at + 'T00:00:00Z')) / 86400_000);
    const after = this.metrics(row.at, isoDay(t));
    Object.assign(out, { days_since: days, before: base, after, verdict: 'waiting' });
    if (days < MIN_DAYS_AFTER || after.steps < 20) {
      out.note = `Too early to tell: wait at least ${MIN_DAYS_AFTER} days and some activity.`;
    } else if (!base.cost_per_call || !after.cost_per_call || base.steps < 20) {
      out.verdict = 'unknown';
      out.note = 'Not enough priced activity before the change to compare.';
    } else {
      const change = (100 * (after.cost_per_call - base.cost_per_call)) / base.cost_per_call;
      out.cost_per_call_change_pct = U.pyRound(change, 1);
      out.verdict = change <= -5 ? 'better' : change >= 5 ? 'worse' : 'same';
      out.note = 'A comparison of the same measure before and after; a different kind of work moves it too.';
    }
    return out;
  }
}

// ------------------------------------------------------------------ settings (~/.loopprism/optimize.json)
const DEFAULTS = { live_tools: true, ai: { enabled: false, url: '', api_key: '', model: '' } };

const configPath = () => process.env.LOOPPRISM_OPTIMIZE_FILE || path.join(os.homedir(), '.loopprism', 'optimize.json');

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return cfg;
  }
  if (U.isObj(data)) {
    cfg.live_tools = data.live_tools === undefined ? true : Boolean(data.live_tools);
    const ai = U.isObj(data.ai) ? data.ai : {};
    for (const k of ['url', 'api_key', 'model']) cfg.ai[k] = String(ai[k] || '');
    cfg.ai.enabled = Boolean(ai.enabled);
  }
  return cfg;
}

/** https anywhere, plain http only to this machine (a local model). */
function validUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.hostname) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(host));
}

/** Apply a partial update; an empty api_key keeps the stored one (the UI never receives it). */
function saveConfig(patch) {
  const cfg = loadConfig();
  if ('live_tools' in patch) cfg.live_tools = Boolean(patch.live_tools);
  const ai = patch.ai;
  if (U.isObj(ai)) {
    if ('url' in ai) {
      const url = String(ai.url).trim();
      if (url && !validUrl(url)) throw new Error('The URL must be https:// (or http:// for a model on this computer).');
      cfg.ai.url = url;
    }
    if ('model' in ai) cfg.ai.model = String(ai.model).replace(/\s+/g, '').slice(0, 120);
    if (ai.api_key) cfg.ai.api_key = String(ai.api_key).trim();
    if (ai.clear_key) cfg.ai.api_key = '';
    if ('enabled' in ai) cfg.ai.enabled = Boolean(ai.enabled);
  }
  if (cfg.ai.enabled && !(cfg.ai.url && cfg.ai.model && cfg.ai.api_key)) {
    throw new Error('Fill in the URL, the model and the API key before turning AI analysis on.');
  }
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 }); // the key is a secret: owner only
  fs.renameSync(tmp, p);
  return cfg;
}

/** What the UI may see: never the key itself. */
function publicConfig(cfg) {
  const ai = cfg.ai;
  return { live_tools: cfg.live_tools, ai: { enabled: ai.enabled, url: ai.url, model: ai.model, key_set: Boolean(ai.api_key) } };
}

// ------------------------------------------------------------------ AI analysis
const SYSTEM =
  'You are a cost advisor for AI coding agents. You get aggregate usage numbers and the findings of a rule engine, ' +
  'each with an estimated saving. Write short, concrete advice in plain language: what to change first and why. ' +
  'Use only the numbers given, never invent figures, and say when an estimate is uncertain. ' +
  "You may add observations the rules missed, but label them as such. Answer in the user's language if it is stated, else English.";

/** Only aggregate numbers: never prompts, code, tool output, session titles, ids or paths. */
function buildMessages(overview, result, language = 'en') {
  const t = overview.totals;
  const data = {
    period_days: result.days ?? null,
    spend_usd: result.spend_usd,
    estimated_saving_usd: result.saving_usd,
    estimated_saving_pct: result.saving_pct,
    calls: t.steps ?? null,
    tokens: { uncached_input: t.input ?? null, cache_read: t.cache_read ?? null, output: t.output ?? null },
    by_model: overview.by_model.slice(0, 10).map((m) => ({ model: m.key, spend_usd: m.cost, calls: m.steps })),
    by_agent: overview.by_agent.map((a) => ({ agent: a.key, spend_usd: a.cost })),
    findings: result.suggestions.map((s) => ({
      rule: s.id, estimated_saving_usd: s.saving_usd, sessions: s.sessions, confidence: s.confidence,
      examples: s.evidence.slice(0, 3).map((e) => e.detail),
    })),
  };
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Language: ${language}\n\n` + JSON.stringify(data, null, 2) },
  ];
}

function endpoint(url) {
  url = url.replace(/\/+$/, '');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

async function runAi(cfg, messages, timeoutMs = 90_000) {
  const ai = cfg.ai;
  const res = await fetch(endpoint(ai.url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.model, messages, temperature: 0.2 }),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`The model endpoint answered ${res.status}: ${text.slice(0, 200)}`);
  try {
    return String(JSON.parse(text).choices[0].message.content).trim();
  } catch {
    throw new Error('The answer was not an OpenAI-style chat completion');
  }
}

// ------------------------------------------------------------------ tools that help
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Unlicense', '0BSD', 'CC0-1.0']);
const MAX_AGE_DAYS = 180;
const MIN_STARS_DISCOVERED = 300;
const CACHE_MS = 24 * 3600 * 1000;
const CATALOG = [
  { repo: 'rtk-ai/rtk', kind: 'compress', tags: ['big_tool_output', 'repeated_calls'], why: 'A CLI proxy that shortens the output of common dev commands before the model reads it.' },
  { repo: 'headroomlabs-ai/headroom', kind: 'compress', tags: ['big_tool_output', 'long_session'], why: 'Compresses tool outputs, logs, files and RAG chunks before they reach the model.' },
  { repo: 'zilliztech/claude-context', kind: 'retrieval', tags: ['big_tool_output', 'long_session'], why: 'Code search over MCP: the agent fetches the relevant code instead of reading whole files.' },
  { repo: 'ooples/token-optimizer-mcp', kind: 'measure', tags: ['low_cache_hit', 'big_tool_output'], why: 'Measures token savings per agent and trims context.' },
  { repo: 'microsoft/LLMLingua', kind: 'compress', tags: ['long_session', 'big_tool_output'], why: 'Prompt compression research and library: shorter prompts with little loss.' },
  { repo: 'musistudio/claude-code-router', kind: 'router', tags: ['cheaper_model'], why: 'Routes requests across models, so simple tasks can go to a cheaper one.' },
  { repo: 'Portkey-AI/gateway', kind: 'gateway', tags: ['cheaper_model', 'low_cache_hit'], why: 'An AI gateway with routing, fallbacks and caching across many providers.' },
];
const DISCOVERY = {
  big_tool_output: ['token reduce topic:claude-code', 'context compression topic:mcp'],
  low_cache_hit: ['prompt cache topic:claude-code', 'llm cache proxy topic:ai-agent'],
  cheaper_model: ['model router topic:claude-code', 'llm gateway cost topic:ai-agent'],
  long_session: ['context management topic:claude-code', 'session summary topic:ai-agent'],
  repeated_calls: ['token savings topic:claude-code'],
};
const EXCLUDE_WORDS = ['awesome', 'tutorial', 'course', 'dotfiles'];

const toolsCachePath = () => process.env.LOOPPRISM_TOOLS_CACHE || path.join(os.homedir(), '.loopprism', 'tools-cache.json');

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'LoopPrism' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

const daysAgo = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? Math.floor((Date.now() - Date.parse(iso)) / 86400_000) : null);

function entry(repo, extra) {
  return {
    repo: repo.full_name, url: repo.html_url, stars: repo.stargazers_count ?? null, license: (repo.license || {}).spdx_id ?? null,
    pushed_days_ago: daysAgo(repo.pushed_at), description: repo.description || '', archived: Boolean(repo.archived), ...extra,
  };
}

const acceptable = (e) => PERMISSIVE.has(e.license) && !e.archived && e.pushed_days_ago !== null && e.pushed_days_ago <= MAX_AGE_DAYS;

async function fetchTools(get = (url) => fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(10_000) })) {
  const out = [];
  const seen = new Set(CATALOG.map((c) => c.repo.toLowerCase()));
  for (const c of CATALOG) {
    try {
      const r = await get(`https://api.github.com/repos/${c.repo}`);
      if (r.status !== 200) continue;
      const e = entry(await r.json(), { tags: c.tags, kind: c.kind, why: c.why, reviewed: true });
      if (acceptable(e)) out.push(e);
    } catch {
      // one repo failing does not stop the others
    }
  }
  for (const [rule, queries] of Object.entries(DISCOVERY)) {
    let found = 0;
    for (const q of queries) {
      try {
        const qs = new URLSearchParams({ q: `${q} stars:>=${MIN_STARS_DISCOVERED}`, sort: 'stars', per_page: '10' });
        const r = await get(`https://api.github.com/search/repositories?${qs}`);
        if (r.status !== 200) break;
        for (const item of (await r.json()).items || []) {
          const name = item.full_name.toLowerCase();
          if (seen.has(name) || EXCLUDE_WORDS.some((w) => name.includes(w))) continue;
          const e = entry(item, { tags: [rule], kind: 'discovered', why: item.description || '', reviewed: false });
          if (acceptable(e)) {
            seen.add(name);
            out.push(e);
            found += 1;
          }
          if (found >= 2) break;
        }
      } catch {
        break;
      }
      if (found >= 2) break;
    }
  }
  return out;
}

function offlineTools() {
  return CATALOG.map((c) => ({
    repo: c.repo, url: `https://github.com/${c.repo}`, stars: null, license: null, pushed_days_ago: null, description: c.why,
    archived: false, tags: c.tags, kind: c.kind, why: c.why, reviewed: true,
  }));
}

/** The tool list, from the day's cache or live; `source` says which. fetched_at is in seconds. */
async function toolsFor(live, force = false, fetcher = fetchTools) {
  const p = toolsCachePath();
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // no cache yet
  }
  const fresh = cached && Date.now() - (cached.at || 0) * 1000 < CACHE_MS;
  if (cached && fresh && !force) return { tools: cached.tools, fetched_at: cached.at, source: 'cache' };
  if (!live) return { tools: cached ? cached.tools : [], fetched_at: cached ? cached.at : null, source: cached ? 'cache' : 'off' };
  let tools = [];
  try {
    tools = await fetcher();
  } catch {
    tools = [];
  }
  if (tools.length) {
    const at = Date.now() / 1000;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ at, tools }));
    return { tools, fetched_at: at, source: 'live' };
  }
  return { tools: cached ? cached.tools : offlineTools(), fetched_at: cached ? cached.at : null, source: cached ? 'cache' : 'offline' };
}

module.exports = { Adoptions, loadConfig, saveConfig, publicConfig, validUrl, buildMessages, endpoint, runAi, toolsFor, offlineTools };
