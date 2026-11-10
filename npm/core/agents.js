'use strict';
// The agent tree of a Claude Code session: the main agent and the subagents it spawned (port of sessions/agents.py).
//   <project>/<session>.jsonl                       main agent
//   <project>/<session>/subagents/agent-<id>.jsonl  one file per subagent
const fs = require('fs');
const path = require('path');
const M = require('./models');
const { K } = M;
const U = require('./util');
const claude = require('./adapters/claude_code');
const { estimateText } = require('./tokens');

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const AGENT_ID = /^[A-Za-z0-9]{6,64}$/;
const AGENT_ID_IN_TEXT = /agentId:\s*([A-Za-z0-9]{6,64})/;
const NOTIFICATION = /<task-notification>(.*?)<\/task-notification>/gs;
const MAX_AGENTS = 300;
const TEXT_CAP = 20_000;

const subagentDir = (sessionPath) => path.join(sessionPath.slice(0, sessionPath.length - path.extname(sessionPath).length), 'subagents');
const subagentFile = (sessionPath, agentId) => path.join(subagentDir(sessionPath), `agent-${agentId}.jsonl`);

function* strings(row) {
  if (typeof row.content === 'string') yield row.content;
  if (U.isObj(row.attachment) && typeof row.attachment.prompt === 'string') yield row.attachment.prompt;
  if (U.isObj(row.message) && typeof row.message.content === 'string') yield row.message.content;
}

function tag(text, name) {
  const m = text.match(new RegExp(`<${name}>(.*?)</${name}>`, 's'));
  return m ? U.strip(m[1]) : null;
}

const digits = (s) => (s && /^\d+$/.test(s) ? Number(s) : null);

/** Spawn calls, tool_use_id -> agentId links, and finish notifications. */
function scanRows(rows) {
  const spawns = [];
  const links = new Map();
  const notes = new Map();
  for (const r of rows) {
    const t = r.type;
    const m = r.message;
    if (t === 'assistant' && U.isObj(m)) {
      for (const b of U.or(m.content, [])) {
        if (U.isObj(b) && b.type === 'tool_use' && SPAWN_TOOLS.has(b.name)) {
          const inp = U.isObj(b.input) ? b.input : {};
          spawns.push({
            tool_use_id: U.get(b, 'id', null),
            ts: U.get(r, 'timestamp', null),
            description: U.pyStr(U.or(inp.description, '')),
            prompt: U.pyStr(U.or(inp.prompt, '')),
            subagent_type: U.pyStr(U.or(inp.subagent_type, '')),
            background: Boolean(inp.run_in_background),
          });
        }
      }
    } else if (t === 'user' && U.isObj(m) && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!(U.isObj(b) && b.type === 'tool_result')) continue;
        const tur = r.toolUseResult;
        let aid = U.isObj(tur) ? U.get(tur, 'agentId', null) : null;
        if (!U.T(aid)) {
          const hit = (claude.resultText(b.content) || '').match(AGENT_ID_IN_TEXT);
          aid = hit ? hit[1] : null;
        }
        if (U.T(b.tool_use_id) && U.T(aid)) links.set(b.tool_use_id, U.pyStr(aid));
      }
    }
    for (const s of strings(r)) {
      if (!s.includes('<task-notification>')) continue;
      for (const match of s.matchAll(NOTIFICATION)) {
        const body = match[1];
        const aid = tag(body, 'task-id');
        const uid = tag(body, 'tool-use-id');
        if (!aid) continue;
        if (uid) links.set(uid, aid);
        notes.set(aid, {
          status: tag(body, 'status'),
          tokens: digits(tag(body, 'subagent_tokens')),
          tool_uses: digits(tag(body, 'tool_uses')),
          duration_ms: digits(tag(body, 'duration_ms')),
        });
      }
    }
  }
  return [spawns, links, notes];
}

function ts(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t / 1000;
}

function usage(steps) {
  const u = {
    input: U.sum(steps.map((s) => s.input_tokens)),
    output: U.sum(steps.map((s) => s.output_tokens)),
    cache_read: U.sum(steps.map((s) => s.cache_read_tokens)),
    cache_write: U.sum(steps.map((s) => s.cache_write_tokens + s.cache_write_1h_tokens)),
  };
  u.total = u.input + u.output + u.cache_read + u.cache_write;
  return u;
}

function cost(steps) {
  const costs = steps.map((s) => s.cost_usd).filter((c) => c !== null);
  return costs.length ? U.pyRound(U.sum(costs), 6) : null;
}

/** Python's Counter in first-seen order; mostCommon keeps first-seen order among ties. */
function counter(items) {
  const c = new Map();
  for (const x of items) c.set(x, (c.get(x) || 0) + 1);
  return c;
}
const mostCommon = (c, n) => [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

function stats(steps, events) {
  const models = counter(steps.map((s) => s.model));
  const tools = counter(events.filter((e) => e.kind === K.TOOL_CALL && U.T(e.tool_name)).map((e) => e.tool_name));
  return {
    model: models.size ? mostCommon(models, 1)[0][0] : null,
    models: [...models.keys()],
    steps: steps.length,
    tool_calls: U.sum([...tools.values()]),
    tools: Object.fromEntries(mostCommon(tools, 8)),
    errors: events.filter((e) => e.kind === K.TOOL_RESULT && e.is_error).length,
    cost_usd: cost(steps),
    tokens: usage(steps),
  };
}

const firstUser = (events) => (events.find((e) => e.kind === K.USER && U.strip(e.text)) || {}).text || '';

/** What the subagent handed back: its hand-back call, else its last message. */
function lastAssistant(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === K.TOOL_CALL && e.tool_name === 'SubagentHandback' && U.isObj(e.tool_input)) {
      const msg = e.tool_input.message;
      if (typeof msg === 'string' && U.strip(msg)) return msg;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === K.ASSISTANT && U.strip(events[i].text)) return events[i].text;
  return '';
}

const textBlock = (text) => ({ text: U.cpSlice(text, TEXT_CAP), tokens: U.pyRound(estimateText(text)), estimated: true, truncated: U.cpLen(text) > TEXT_CAP });

function peakParallel(spans) {
  const marks = [...spans.map(([a]) => [a, 1]), ...spans.map(([, b]) => [b, -1])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of marks) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

function unsupported(reason) {
  return {
    supported: false,
    reason,
    agents: [],
    totals: { subagents: 0, peak_parallel: 0, subagent_cost_usd: null, main_cost_usd: null, total_cost_usd: null, passed_tokens: 0 },
  };
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The main agent plus every subagent it (transitively) spawned. */
function build(ps) {
  const meta = ps.meta;
  if (meta.agent !== 'claude-code') return unsupported('Subagent trees are only read from Claude Code sessions for now.');
  const mainSteps = ps.steps.filter((s) => !s.sidechain && s.model !== '<synthetic>');
  const mainEvents = ps.events.filter((e) => !e.sidechain);
  const main = {
    id: 'main', parent_id: null, name: 'Main agent', role: 'main', description: '', background: false, status: 'completed',
    session_id: meta.id, start: meta.started_at, end: meta.ended_at, spawned_at: null, duration_ms: null,
    ...stats(mainSteps, mainEvents), task: null, result: null,
  };
  const s0 = ts(meta.started_at);
  const s1 = ts(meta.ended_at);
  main.duration_ms = s0 !== null && s1 !== null ? U.pyRound((s1 - s0) * 1000) : null;
  const nodes = [main];
  const seen = new Set();
  const queue = [['main', U.readRows(meta.path)]];
  while (queue.length && nodes.length < MAX_AGENTS) {
    const [parentId, rows] = queue.shift();
    const [spawns, links, notes] = scanRows(rows);
    for (const sp of spawns) {
      const aid = links.get(sp.tool_use_id || '') ?? null;
      const nodeId = aid || `call-${String(sp.tool_use_id || String(nodes.length)).slice(-10)}`;
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const note = notes.get(aid || '') || {};
      const file = aid && AGENT_ID.test(aid) ? subagentFile(meta.path, aid) : null;
      const child = file && isFile(file) ? claude.parse(file) : null;
      let st;
      let taskText;
      let resultText;
      let start;
      let end;
      if (child) {
        st = stats(child.steps.filter((s) => s.model !== '<synthetic>'), child.events);
        taskText = sp.prompt || firstUser(child.events);
        resultText = lastAssistant(child.events);
        start = child.meta.started_at;
        end = child.meta.ended_at;
        queue.push([nodeId, U.readRows(file)]);
      } else {
        st = {
          model: null, models: [], steps: 0, tool_calls: note.tool_uses || 0, tools: {}, errors: 0, cost_usd: null,
          tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: note.tokens || 0 },
        };
        [taskText, resultText, start, end] = [sp.prompt, '', sp.ts, null];
      }
      const a0 = ts(start);
      const a1 = ts(end);
      let duration = note.duration_ms ?? null;
      if (duration === null && a0 !== null && a1 !== null) duration = U.pyRound((a1 - a0) * 1000);
      const status = (note.status || (resultText ? 'completed' : 'unknown')).toLowerCase();
      nodes.push({
        id: nodeId, parent_id: parentId, name: sp.description || sp.subagent_type || 'subagent',
        role: sp.subagent_type || 'subagent', description: sp.description, background: sp.background, status,
        session_id: child ? `${meta.id}~${aid}` : null, start, end, spawned_at: sp.ts, duration_ms: duration,
        ...st, task: taskText ? textBlock(taskText) : null, result: resultText ? textBlock(resultText) : null,
      });
    }
  }
  const children = nodes.slice(1);
  const spans = [];
  for (const n of children) {
    const a = ts(n.start);
    const b = ts(n.end);
    if (a !== null && b !== null && b >= a) spans.push([a, b]);
  }
  const subCost = children.map((n) => n.cost_usd).filter((c) => c !== null);
  const mainCost = main.cost_usd;
  const total = mainCost !== null || subCost.length ? (mainCost || 0) + U.sum(subCost) : null;
  return {
    supported: true,
    reason: null,
    agents: nodes,
    totals: {
      subagents: children.length,
      peak_parallel: peakParallel(spans),
      subagent_cost_usd: subCost.length ? U.pyRound(U.sum(subCost), 6) : null,
      main_cost_usd: mainCost,
      total_cost_usd: total !== null ? U.pyRound(total, 6) : null,
      passed_tokens: U.sum(children.map((n) => ((n.task || {}).tokens || 0) + ((n.result || {}).tokens || 0))),
    },
  };
}

module.exports = { AGENT_ID, build, subagentDir, subagentFile };
