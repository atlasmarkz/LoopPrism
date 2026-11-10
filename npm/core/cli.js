'use strict';
// `lpa <command>` for the session inspector: readable text by default, --json for scripts and agents.
const fs = require('fs');
const { Inspector } = require('./api');
const { AGENTS } = require('./store');
const { AGENT_NAMES } = require('./actions');

const COMMANDS = new Set(['sessions', 'search', 'show', 'events', 'context', 'agents', 'cost', 'optimize', 'export', 'index']);

const HELP = `Session inspector (reads the agents' own session files; nothing is sent anywhere)
  lpa sessions [--agent A] [--project DIR] [-n 20]   newest sessions, with cost
  lpa search <words> [--agent A]                     full-text search over prompts and answers
  lpa show [SESSION]                                 review a session: cost, context, loops, errors, savings
  lpa events [SESSION] [--kind tool_call,...] [--grep TEXT] [--offset N] [-n 50] [--full]
  lpa context [SESSION] [--step N]                   what filled the context window
  lpa agents [SESSION]                               subagent tree (Claude Code)
  lpa cost [--days 30] [--agent A]                   spend across every session
  lpa optimize [--days 30] [--agent A]               ways to spend less, with estimated savings
  lpa export [SESSION] [-o FILE]                     the conversation as Markdown
  lpa index                                          index every session now
  lpa ui [SESSION] [--port 8765] [--detach]          the LoopPrism dashboard in your browser (no app needed)
  lpa mcp                                            run as an MCP server (stdio)

SESSION is an id (or a unique prefix), "current" (newest session in this folder, the default) or "latest".
Agents: ${AGENTS.join(', ')}. Add --json to any command for machine-readable output.`;

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = { '-n': 'limit', '--limit': 'limit', '-o': 'out', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--full') opts[a.slice(2)] = true;
    else if (flags[a]) opts[flags[a]] = argv[++i];
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else opts[a.slice(2)] = argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

function usd(x) {
  if (x === null || x === undefined) return '—';
  if (x > 0 && x < 0.01) return '<$0.01';
  return `$${x.toFixed(2)}`;
}

function tok(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function dur(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const day = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const cut = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.title.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (r, head) =>
    cols
      .map((c, i) => {
        const v = head ? c.title : String(r[c.key] ?? '');
        return c.right ? v.padStart(widths[i]) : i === cols.length - 1 ? v : v.padEnd(widths[i]);
      })
      .join('  ');
  return [line(null, true), ...rows.map((r) => line(r))].join('\n');
}

// ------------------------------------------------------------------ renderers
function renderSessions(out) {
  if (!out.sessions.length) return 'No sessions found.';
  const rows = out.sessions.map((s) => ({
    when: day(s.ended_at || s.started_at),
    agent: AGENT_NAMES[s.agent] || s.agent,
    cost: usd(s.cost_usd),
    steps: s.steps,
    id: s.id.length > 14 ? s.id.slice(0, 13) + '…' : s.id,
    title: cut(s.snippet || s.title, 70),
  }));
  return table(rows, [
    { key: 'when', title: 'LAST ACTIVE' },
    { key: 'agent', title: 'AGENT' },
    { key: 'cost', title: 'COST', right: true },
    { key: 'steps', title: 'STEPS', right: true },
    { key: 'id', title: 'ID' },
    { key: 'title', title: 'TITLE' },
  ]);
}

function renderSummary(s) {
  const m = s.session;
  const st = s.stats;
  const L = [];
  L.push(`${m.title}`);
  L.push(`${AGENT_NAMES[m.agent] || m.agent} · ${m.id} · ${day(m.started_at)} → ${day(m.ended_at)}`);
  if (m.project) L.push(`Project: ${m.project}${m.git_branch ? ` (${m.git_branch})` : ''}`);
  L.push(`Models: ${m.models.join(', ') || '—'}`);
  L.push('');
  const cache = st.cache_hit_pct === null ? '—' : `${st.cache_hit_pct.toFixed(0)}%`;
  const win = st.window ? ` of ${tok(st.window)} (${((100 * st.current_context) / st.window).toFixed(0)}%)` : '';
  L.push(`Cost ${usd(s.cost.total_usd)}${s.cost.subagent_usd ? ` (subagents ${usd(s.cost.subagent_usd)})` : ''} · ${st.turns} turns · ${st.steps} model calls · ${st.tool_calls} tool calls`);
  L.push(`Context now ${tok(st.current_context)}${win} · cache hits ${cache} · ${m.fidelity === 'exact' ? 'exact requests' : 'estimated context'}`);
  L.push(`Time: model ${dur(s.timing.model_ms)}, tools ${dur(s.timing.tools_ms)}, other ${dur(s.timing.overhead_ms)}${s.timing.tokens_per_second ? ` · ${s.timing.tokens_per_second} tok/s` : ''}`);
  if (s.cost.unpriced_steps) L.push(`(${s.cost.unpriced_steps} model calls have no known price and are not counted)`);
  if (s.cost.by_category.length) {
    L.push('', 'Where the money went:');
    for (const c of s.cost.by_category.slice(0, 6)) L.push(`  ${c.label.padEnd(28)} ${usd(c.usd).padStart(8)}`);
  }
  if (s.findings.length) {
    L.push('', 'Findings:');
    for (const f of s.findings.slice(0, 10)) {
      L.push(`  [${f.severity}] turn ${f.turn}: ${f.title}`);
      for (const ex of f.examples.slice(0, 1)) L.push(`         ${cut(ex, 100)}`);
    }
  }
  if (s.largest_tool_results.length && s.largest_tool_results[0].tokens >= 2000) {
    L.push('', 'Largest tool outputs:');
    for (const r of s.largest_tool_results.filter((x) => x.tokens >= 2000)) L.push(`  ≈${tok(r.tokens).padStart(6)} tokens  ${r.tool || '?'} ${cut(r.input, 70)}  (event ${r.event})`);
  }
  if (s.subagents) {
    const t = s.subagents.totals;
    L.push('', `Subagents: ${t.subagents}, up to ${t.peak_parallel} in parallel, ${usd(t.subagent_cost_usd)}`);
    for (const a of s.subagents.agents.slice(0, 8)) L.push(`  ${cut(a.name, 40).padEnd(40)} ${a.status.padEnd(10)} ${usd(a.cost_usd).padStart(8)}  ${a.session_id || ''}`);
  }
  if (s.savings.length) {
    L.push('', 'Could have cost less:');
    for (const v of s.savings.slice(0, 5)) L.push(`  ~${usd(v.saving_usd)}  ${v.title}: ${v.detail}`);
  }
  if (m.resume_command) L.push('', `Resume: ${m.resume_command}`);
  if (s.note) L.push('', s.note);
  return L.join('\n');
}

function renderEvents(out, full) {
  const L = [`${out.total} events${out.offset ? ` (from ${out.offset})` : ''}`];
  for (const e of out.events) {
    const head = `#${e.idx} t${e.turn} ${e.kind}${e.tool_name ? ` ${e.tool_name}` : ''}${e.is_error ? ' ERROR' : ''}${e.label ? ` [${e.label}]` : ''}`;
    let body = e.text;
    if (e.kind === 'tool_call' && e.tool_input !== undefined) body = JSON.stringify(e.tool_input);
    L.push(head, full ? body : `  ${cut(body, 200)}`);
  }
  return L.join('\n');
}

function renderContext(c) {
  if (c.categories) {
    const L = [`Step ${c.step} (turn ${c.turn}, ${c.model}): ${tok(c.actual_input)} input tokens${c.window ? ` of ${tok(c.window)}` : ''}${c.exact_request ? ', exact request' : ', estimated split'}`];
    for (const cat of c.categories) L.push(`  ${cat.label.padEnd(28)} ${tok(cat.tokens).padStart(7)}  ${String(cat.pct).padStart(5)}%  (${cat.items} items)`);
    if (c.items) {
      const big = Object.values(c.items).flat().sort((a, b) => b.tokens - a.tokens).slice(0, 8);
      L.push('', 'Largest items:');
      for (const it of big) L.push(`  ${tok(it.tokens).padStart(7)}  ${cut(it.label, 30).padEnd(30)} ${cut(it.preview, 80)}`);
    }
    return L.join('\n');
  }
  const L = [];
  if (c.latest) L.push(renderContext(c.latest));
  if (c.biggest_jumps.length) {
    L.push('', 'Biggest jumps:');
    for (const j of c.biggest_jumps) L.push(`  step ${j.step} (turn ${j.turn}): +${tok(j.delta)} → ${tok(j.total)}`);
  }
  return L.join('\n');
}

function renderAgents(t) {
  if (!t.supported) return t.reason;
  const byParent = new Map();
  for (const a of t.agents) {
    if (!byParent.has(a.parent_id)) byParent.set(a.parent_id, []);
    byParent.get(a.parent_id).push(a);
  }
  const L = [];
  const walk = (parent, depth) => {
    for (const a of byParent.get(parent) || []) {
      L.push(`${'  '.repeat(depth)}${a.name} [${a.role}] ${a.status} · ${a.steps} steps · ${usd(a.cost_usd)}${a.duration_ms ? ` · ${dur(a.duration_ms)}` : ''}${a.session_id && depth ? ` · ${a.session_id}` : ''}`);
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  const x = t.totals;
  L.push('', `${x.subagents} subagents, up to ${x.peak_parallel} in parallel; main ${usd(x.main_cost_usd)}, subagents ${usd(x.subagent_cost_usd)}, total ${usd(x.total_cost_usd)}`);
  return L.join('\n');
}

function renderCost(c) {
  const t = c.totals;
  const L = [`${c.days ? `Last ${c.days} days` : 'All time'}: ${usd(t.cost)} across ${t.sessions || 0} sessions, ${t.steps || 0} model calls`];
  L.push(`Tokens: ${tok(t.input)} input, ${tok(t.cache_read)} cache reads, ${tok(t.cache_write)} cache writes, ${tok(t.output)} output`);
  if (t.unpriced_steps) L.push(`(${t.unpriced_steps} model calls without a known price: ${c.unpriced_models.join(', ')})`);
  const block = (title, rows, label = (r) => r.key) => {
    if (!rows.length) return;
    L.push('', title);
    for (const r of rows.slice(0, 8)) L.push(`  ${cut(label(r) || '(none)', 44).padEnd(44)} ${usd(r.cost).padStart(9)}  ${String(r.steps).padStart(6)} calls`);
  };
  block('By agent:', c.by_agent, (r) => AGENT_NAMES[r.key] || r.key);
  block('By model:', c.by_model);
  block('By project:', c.by_project);
  if (c.top_sessions.length) {
    L.push('', 'Most expensive sessions:');
    for (const s of c.top_sessions.slice(0, 8)) L.push(`  ${usd(s.cost).padStart(9)}  ${(AGENT_NAMES[s.agent] || s.agent).padEnd(16)} ${cut(s.title, 60)}  ${s.id}`);
  }
  if (c.note) L.push('', c.note);
  return L.join('\n');
}

function renderOptimize(o) {
  const L = [`Last ${o.days} days: spent ${usd(o.spend_usd)}; estimated saving ${usd(o.saving_usd)} (${o.saving_pct}%) over ${o.analyzed_sessions} sessions`];
  if (!o.suggestions.length) L.push('', 'Nothing stands out.');
  for (const s of o.suggestions) {
    L.push('', `~${usd(s.saving_usd)} (${s.saving_pct}%, ${s.confidence} confidence, ${s.sessions} sessions)  ${s.title}`);
    L.push(`  ${s.how}`);
    for (const e of s.evidence.slice(0, 3)) L.push(`  · ${usd(e.saving_usd)} ${cut(e.title, 50)}: ${cut(e.detail, 80)}`);
  }
  L.push('', 'Estimates at API list prices, by re-pricing the same tokens.');
  if (o.note) L.push(o.note);
  return L.join('\n');
}

// ------------------------------------------------------------------ main
function progress() {
  if (!process.stderr.isTTY) return null;
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - last > 200 || done === total) {
      last = now;
      process.stderr.write(`\rIndexing sessions ${done}/${total}…${done === total ? '\n' : ''}`);
    }
  };
}

async function run(command, argv) {
  const o = parseArgs(argv);
  if (o.agent && !AGENTS.includes(o.agent)) {
    console.error(`Unknown agent "${o.agent}". One of: ${AGENTS.join(', ')}`);
    return 2;
  }
  const ins = new Inspector({ firstBudgetMs: Infinity });
  try {
    ins.refresh({ onProgress: progress(), budgetMs: Infinity });
    const ref = o._[0] || 'current';
    const sel = { agent: o.agent || null, cwd: process.cwd() };
    let out;
    let text;
    switch (command) {
      case 'index': {
        const r = ins.store.refresh();
        out = { ...r, by_agent: ins.store.countsByAgent() };
        text = `${ins.store.count()} sessions indexed: ` + Object.entries(out.by_agent).map(([a, n]) => `${AGENT_NAMES[a] || a} ${n}`).join(', ');
        break;
      }
      case 'sessions':
      case 'search':
        out = ins.sessions({ agent: sel.agent, project: o.project || null, query: command === 'search' ? o._.join(' ') : null, limit: num(o.limit, 20) });
        text = renderSessions(out);
        break;
      case 'show':
        out = ins.summary(ref, sel);
        text = renderSummary(out);
        break;
      case 'events':
        out = ins.events(ref, { ...sel, kinds: o.kind ? o.kind.split(',') : null, query: o.grep || null, offset: num(o.offset, 0), limit: num(o.limit, 50), preview: o.full ? null : 300 });
        text = renderEvents(out, o.full);
        break;
      case 'context':
        out = ins.context(ref, { ...sel, step: o.step === undefined ? null : Number(o.step) });
        text = renderContext(out);
        break;
      case 'agents':
        out = ins.agents(ref, sel);
        text = renderAgents(out);
        break;
      case 'cost':
        out = ins.cost({ days: num(o.days, 30), agent: sel.agent });
        text = renderCost(out);
        break;
      case 'optimize':
        out = ins.optimize({ days: num(o.days, 30), agent: sel.agent });
        text = renderOptimize(out);
        break;
      case 'export': {
        const md = ins.exportMarkdown(ref, sel);
        if (o.out) {
          fs.writeFileSync(o.out, md);
          text = `Written to ${o.out}`;
          out = { file: o.out };
        } else {
          out = { markdown: md };
          text = md.trimEnd();
        }
        break;
      }
      default:
        console.log(HELP);
        return 2;
    }
    console.log(o.json ? JSON.stringify(out, null, 2) : text);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    ins.close();
  }
}

module.exports = { COMMANDS, HELP, run, parseArgs };
