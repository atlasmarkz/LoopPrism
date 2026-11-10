'use strict';
// The questions LoopPrism answers, as plain data: shared by the CLI (`lpa ...`) and the MCP server.
// Everything is read from the agents' own session files on this machine; nothing is sent anywhere.
const M = require('./models');
const { K } = M;
const U = require('./util');
const context = require('./context');
const analysis = require('./analysis');
const agentsTree = require('./agents');
const actions = require('./actions');
const optimize = require('./optimize');
const { SessionStore, READ_ONLY_AGENTS, sinceDays } = require('./store');
const { estimateText } = require('./tokens');

const pv = (s, n) => {
  const t = U.strip(String(s || '')).replace(/\s+/g, ' ');
  return U.cpLen(t) > n ? U.cpSlice(t, n) + '…' : t;
};

function inputPreview(input, n = 160) {
  if (input === null || input === undefined) return '';
  if (U.isObj(input)) {
    for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      if (typeof input[k] === 'string') return pv(input[k], n);
    }
  }
  return pv(typeof input === 'string' ? input : JSON.stringify(input), n);
}

class Inspector {
  constructor({ indexPath, roots, firstBudgetMs = 20_000, budgetMs = 3_000 } = {}) {
    this.store = new SessionStore({ ...(indexPath ? { indexPath } : {}), ...(roots ? { roots } : {}) });
    this.firstBudgetMs = firstBudgetMs;
    this.budgetMs = budgetMs;
    this.refreshed = false;
  }

  close() {
    this.store.close();
  }

  /** Index new and changed sessions: a larger budget the first time, then a quick top-up. */
  refresh({ onProgress = null, budgetMs = null } = {}) {
    const r = this.store.refresh({ budgetMs: budgetMs ?? (this.refreshed ? this.budgetMs : this.firstBudgetMs), onProgress });
    this.refreshed = true;
    return r;
  }

  note() {
    return this.store.pending ? `${this.store.pending} sessions are still being indexed; run again to include them.` : undefined;
  }

  // ------------------------------------------------------------------ sessions
  sessions({ agent = null, project = null, query = null, limit = 20, offset = 0 } = {}) {
    this.refresh();
    const rows = this.store.list({ agent, project, q: query, limit, offset });
    return {
      sessions: rows.map((r) => ({
        id: r.id, agent: r.agent, title: r.title, project: r.project, started_at: r.started_at, ended_at: r.ended_at,
        models: r.models, turns: r.turns, steps: r.steps, tool_calls: r.tool_calls, cost_usd: r.cost_usd,
        ...(r.snippet ? { snippet: r.snippet } : {}),
      })),
      total: this.store.count(agent),
      by_agent: this.store.countsByAgent(),
      note: this.note(),
    };
  }

  load(ref, { cwd, agent } = {}) {
    this.refresh();
    const r = this.store.resolve(ref, { cwd, agent });
    if (r.error) throw new Error(r.error);
    const id = r.row ? r.row.id : r.subagent;
    const ps = this.store.load(id);
    if (!ps) throw new Error(`Session not found: ${ref}`);
    return ps;
  }

  /** The overview an agent (or a person) needs to judge a session: what it cost, where it went, what went wrong. */
  summary(ref, opts = {}) {
    const ps = this.load(ref, opts);
    const m = ps.meta;
    const stats = context.stats(ps);
    const cost = analysis.costBreakdown(ps);
    const timing = analysis.timing(ps);
    delete timing.steps;
    const findings = analysis.findings(ps).map((f) => ({
      ...f,
      examples: f.events.slice(0, 3).map((i) => {
        const e = ps.events[i];
        return e.kind === K.TOOL_CALL ? `${e.tool_name}: ${inputPreview(e.tool_input)}` : pv(e.text, 160);
      }),
    }));
    const tools = new Map();
    for (const e of ps.events) {
      if (e.kind === K.TOOL_CALL && !e.sidechain) {
        const t = tools.get(e.tool_name) || { tool: e.tool_name, calls: 0, errors: 0 };
        t.calls += 1;
        tools.set(e.tool_name, t);
      }
    }
    const callOf = new Map(ps.events.filter((e) => e.kind === K.TOOL_CALL && e.tool_use_id).map((e) => [e.tool_use_id, e]));
    const bigResults = [];
    for (const e of ps.events) {
      if (e.kind !== K.TOOL_RESULT || e.sidechain) continue;
      const call = callOf.get(e.tool_use_id);
      if (e.is_error && call && tools.has(call.tool_name)) tools.get(call.tool_name).errors += 1;
      bigResults.push({ event: e.idx, turn: e.turn, tokens: Math.round(estimateText(e.text)), tool: call ? call.tool_name : null, input: call ? inputPreview(call.tool_input, 120) : '' });
    }
    bigResults.sort((a, b) => b.tokens - a.tokens);
    const savings = [];
    for (const rule of optimize.RULES) {
      try {
        for (const f of rule(ps)) savings.push({ rule: f.rule, title: optimize.COPY[f.rule].title, how: optimize.COPY[f.rule].how, saving_usd: U.pyRound(f.saving, 4), detail: f.detail, confidence: f.confidence });
      } catch {
        // a rule that does not fit this session
      }
    }
    savings.sort((a, b) => b.saving_usd - a.saving_usd);
    const tree = m.agent === 'claude-code' ? agentsTree.build(ps) : null;
    return {
      session: {
        id: m.id, agent: m.agent, title: m.title, project: m.project, started_at: m.started_at, ended_at: m.ended_at,
        models: m.models, version: m.version, git_branch: m.git_branch, turns: m.turns, fidelity: m.fidelity,
        read_only: READ_ONLY_AGENTS.has(m.agent), resume_command: m.id.includes('~') ? null : actions.resumeCommand(m),
      },
      stats,
      cost: { total_usd: cost.total_usd, subagent_usd: cost.subagent_usd, unpriced_steps: cost.unpriced_steps, by_type: cost.by_type, by_category: cost.by_category, by_model: cost.by_model, top_steps: cost.top_steps },
      timing,
      findings,
      tools: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, 12),
      largest_tool_results: bigResults.slice(0, 5),
      subagents: tree && tree.agents.length > 1
        ? { totals: tree.totals, agents: tree.agents.slice(1).map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, steps: a.steps, cost_usd: a.cost_usd, duration_ms: a.duration_ms, session_id: a.session_id })) }
        : null,
      savings,
      note: this.note(),
    };
  }

  events(ref, { kinds = null, query = null, offset = 0, limit = 50, preview = 300, cwd, agent } = {}) {
    const ps = this.load(ref, { cwd, agent });
    const wanted = kinds && kinds.length ? new Set(kinds) : null;
    const needle = query ? query.toLowerCase() : null;
    const pool = ps.events.filter(
      (e) => (!wanted || wanted.has(e.kind)) && (!needle || e.text.toLowerCase().includes(needle) || (e.tool_name || '').toLowerCase().includes(needle)),
    );
    return { session: ps.meta.id, total: pool.length, offset, events: pool.slice(offset, offset + limit).map((e) => M.eventToDict(e, preview)) };
  }

  event(ref, idx, opts = {}) {
    const ps = this.load(ref, opts);
    if (!(idx >= 0 && idx < ps.events.length)) throw new Error(`Event ${idx} not found (the session has ${ps.events.length})`);
    return M.eventToDict(ps.events[idx]);
  }

  context(ref, { step = null, cwd, agent } = {}) {
    const ps = this.load(ref, { cwd, agent });
    if (step !== null && step !== undefined) {
      if (!(step >= 0 && step < ps.steps.length)) throw new Error(`Step ${step} not found (the session has ${ps.steps.length})`);
      return context.stepContext(ps, step, true);
    }
    const trend = context.trend(ps);
    const main = trend.filter((t) => !t.sidechain);
    const last = main.length ? main[main.length - 1] : null;
    return {
      session: ps.meta.id,
      stats: context.stats(ps),
      latest: last ? context.stepContext(ps, last.step, false) : null,
      biggest_jumps: [...main].sort((a, b) => b.delta - a.delta).slice(0, 5).map((t) => ({ step: t.step, turn: t.turn, delta: t.delta, total: t.total })),
      trend: main.length > 60 ? main.filter((_, i) => i % Math.ceil(main.length / 60) === 0 || i === main.length - 1) : main,
    };
  }

  agents(ref, opts = {}) {
    return agentsTree.build(this.load(ref, opts));
  }

  exportMarkdown(ref, opts = {}) {
    return actions.exportMarkdown(this.load(ref, opts));
  }

  // ------------------------------------------------------------------ across sessions
  cost({ days = 30, agent = null } = {}) {
    this.refresh({ budgetMs: this.firstBudgetMs });
    const out = this.store.costOverview({ since: sinceDays(days), agent });
    out.days = days;
    out.note = this.note();
    return out;
  }

  optimize({ days = 30, agent = null } = {}) {
    this.refresh({ budgetMs: this.firstBudgetMs });
    const since = sinceDays(days);
    const spend = this.store.costOverview({ since, agent }).totals.cost || 0;
    const rows = this.store.costliest({ since, agent });
    const out = optimize.analyze(rows, (id) => this.store.load(id), spend);
    out.days = days;
    out.note = this.note();
    return out;
  }
}

module.exports = { Inspector, inputPreview };
