'use strict';
// The normalized session shared by every agent adapter (port of sessions/models.py).
const { cpLen, cpSlice, pyRound } = require('./util');

const K = {
  SYSTEM: 'system',
  USER: 'user',
  CONTEXT: 'context', // injected: system reminders, CLAUDE.md, skills, hooks
  ASSISTANT: 'assistant',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  COMPACTION: 'compaction',
  MODEL_CHANGE: 'model_change',
  SYSTEM_EVENT: 'system_event',
};

const MAX_EVENT_CHARS = 100_000;
const SEARCH_TEXT_CAP = 150_000;

function clip(text) {
  if (typeof text !== 'string') text = text == null ? '' : String(text);
  const n = cpLen(text);
  return n <= MAX_EVENT_CHARS ? text : cpSlice(text, MAX_EVENT_CHARS) + `... [${n - MAX_EVENT_CHARS} more chars]`;
}

function event(fields) {
  return {
    idx: 0, kind: '', ts: null, turn: 0, step: null, text: '', tool_name: null, tool_input: null,
    tool_use_id: null, is_error: false, sidechain: false, model: null, label: null, ...fields,
  };
}

function eventToDict(e, preview = null) {
  const d = {
    idx: e.idx, kind: e.kind, ts: e.ts, turn: e.turn, step: e.step, tool_name: e.tool_name,
    tool_use_id: e.tool_use_id, is_error: e.is_error, sidechain: e.sidechain, model: e.model,
    label: e.label, size: cpLen(e.text),
  };
  if (e.tool_input !== null && e.tool_input !== undefined) d.tool_input = e.tool_input;
  if (preview === null || preview === undefined) d.text = e.text;
  else {
    d.text = cpSlice(e.text, preview);
    d.truncated = cpLen(e.text) > preview;
  }
  return d;
}

function step(fields) {
  return {
    index: 0, turn: 0, model: 'unknown', ts: null, end_ts: null, msg_id: null, sidechain: false,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0,
    cost_usd: null, request_ts: null, model_ms: null, thinking_ms: null, tools_ms: null, first_event: 0,
    refs: null, system_key: null, context_window: null, ...fields,
  };
}

const totalInput = (s) => s.input_tokens + s.cache_read_tokens + s.cache_write_tokens + s.cache_write_1h_tokens;

const usage = (s) => ({
  input_tokens: s.input_tokens,
  output_tokens: s.output_tokens,
  cache_read_tokens: s.cache_read_tokens,
  cache_write_tokens: s.cache_write_tokens,
  cache_write_1h_tokens: s.cache_write_1h_tokens,
});

function meta(fields) {
  return {
    id: '', agent: '', path: '', project: null, title: '', started_at: null, ended_at: null, models: [],
    version: null, git_branch: null, turns: 0, steps: 0, messages: 0, tool_calls: 0, size_bytes: 0,
    cost_usd: null, fidelity: 'estimated', subagent_steps: 0, ...fields,
  };
}

function session(m) {
  return { meta: m, events: [], steps: [], pool: new Map(), shapes: new Map(), unresolved: 0, search_text: '' };
}

/** Collects search text up to the cap, like the adapters' `remember`. */
class SearchText {
  constructor() {
    this.parts = [];
    this.len = 0;
  }
  add(text) {
    if (this.len < SEARCH_TEXT_CAP && text) {
      this.parts.push(text);
      this.len += cpLen(text);
    }
  }
  toString() {
    return cpSlice(this.parts.join('\n'), SEARCH_TEXT_CAP);
  }
}

/** Shared tail of every adapter: event counts, totals and the title. */
function finish(ps, { turn, models, title, costOf, steps = null }) {
  const m = ps.meta;
  let total = null;
  for (const st of ps.steps) {
    if (costOf) st.cost_usd = costOf(st);
    if (st.cost_usd !== null && st.cost_usd !== undefined) total = (total || 0) + st.cost_usd;
  }
  m.tool_calls = ps.events.filter((e) => e.kind === K.TOOL_CALL).length;
  m.messages = ps.events.filter((e) => e.kind === K.USER || e.kind === K.ASSISTANT).length;
  m.turns = turn;
  m.steps = steps === null ? ps.steps.length : steps;
  m.models = models;
  m.cost_usd = total === null ? null : pyRound(total, 6);
  if (title !== undefined) m.title = cpSlice(title, 200);
}

module.exports = { K, MAX_EVENT_CHARS, SEARCH_TEXT_CAP, clip, event, eventToDict, step, totalInput, usage, meta, session, SearchText, finish };
