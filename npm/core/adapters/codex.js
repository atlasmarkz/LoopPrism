'use strict';
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (port of sessions/codex.py).
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');

const AGENT = 'codex';
const CONTEXT_PREFIXES = ['<environment_context>', '<user_instructions>', '# AGENTS.md', '<permissions', '<turn_aborted>'];

function root() {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'sessions');
}

function discover(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  walk(dir);
  return found;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!U.isObj(b)) continue;
    parts.push(typeof b.text === 'string' ? b.text : `[${'type' in b ? U.pyStr(b.type) : 'block'}]`);
  }
  return parts.filter((p) => U.T(p)).join('\n');
}

function parse(file) {
  const stat = fs.statSync(file);
  const rows = U.readRows(file);
  const base = path.basename(file, path.extname(file));
  const sid = base.includes('rollout-') ? base.slice(base.indexOf('rollout-') + 'rollout-'.length) : base;
  // A long session is stored in several rollout files (one per history page) that share the
  // session id; keep the pages apart.
  const page = base.match(/_([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/);
  const meta = M.meta({ id: sid, agent: AGENT, path: file, size_bytes: stat.size, fidelity: 'exact' });
  const ps = M.session(meta);

  let turn = 0;
  const modelOfTurn = new Map();
  let window = null;
  let firstPrompt = '';
  const search = new M.SearchText();
  const modelsSeen = [];
  const systemTexts = [];
  let toolsSchema = [];
  let sawDeveloper = false;
  let pending = [];
  let lastInputTs = null;
  const callTs = new Map();
  const callStep = new Map();

  const add = (kind, row, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: U.get(row, 'timestamp', null), turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };

  for (const r of rows) {
    const t = r.type;
    const p = U.or(r.payload, {});
    const ts = U.get(r, 'timestamp', null);
    if (U.T(ts)) {
      meta.started_at = U.or(meta.started_at, ts);
      meta.ended_at = ts;
    }
    if (t === 'session_meta') {
      meta.project = U.or(p.cwd, meta.project);
      meta.id = U.or(p.id, meta.id);
      if (page && !String(meta.id).includes('_')) meta.id = `${meta.id}_${page[1]}`;
      meta.version = U.or(p.cli_version, meta.version);
      meta.started_at = U.or(p.timestamp, meta.started_at);
    } else if (t === 'turn_context') {
      if (U.T(p.turn_id) && U.T(p.model)) modelOfTurn.set(p.turn_id, p.model);
      meta.project = U.or(meta.project, U.get(p, 'cwd', null));
    } else if (t === 'response_item') {
      const pt = p.type;
      if (pt === 'additional_tools') toolsSchema = U.or(p.tools, toolsSchema);
      else if (pt === 'message') {
        const role = p.role;
        const text = textOf(p.content);
        if (!U.strip(text)) continue;
        if (role === 'developer') {
          if (!sawDeveloper) {
            systemTexts.push(text);
            sawDeveloper = true;
            add(K.SYSTEM, r, text, { label: 'developer' });
          } else add(K.CONTEXT, r, text, { label: 'developer' });
        } else if (role === 'user') {
          const head = U.lstrip(text);
          if (CONTEXT_PREFIXES.some((x) => head.startsWith(x))) add(K.CONTEXT, r, text, { label: 'user-context' });
          else {
            turn += 1;
            firstPrompt = U.or(firstPrompt, text);
            search.add(text);
            add(K.USER, r, text);
          }
          lastInputTs = ts;
        } else if (role === 'assistant') {
          pending.push(add(K.ASSISTANT, r, text).idx);
          search.add(text);
        }
      } else if (pt === 'reasoning') {
        const summary = (U.or(p.summary, [])).filter(U.isObj).map((s) => U.get(s, 'text', '')).join(' ');
        pending.push(add(K.THINKING, r, summary).idx);
      } else if (pt === 'function_call' || pt === 'custom_tool_call' || pt === 'local_shell_call') {
        let name = U.or(p.name, pt);
        if (U.T(p.namespace)) name = `${p.namespace}.${name}`;
        const args = U.maybeJson('arguments' in p ? p.arguments : U.or(p.input, U.get(p, 'action', null)));
        pending.push(add(K.TOOL_CALL, r, '', { tool_name: name, tool_input: args ?? null, tool_use_id: U.get(p, 'call_id', null) }).idx);
        if (U.T(p.call_id)) callTs.set(p.call_id, U.or(ts, ''));
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output' || pt === 'local_shell_call_output') {
        const cid = U.get(p, 'call_id', null);
        const out = p.output;
        add(K.TOOL_RESULT, r, typeof out === 'string' ? out : textOf(out), { tool_use_id: cid });
        lastInputTs = ts;
        const st = callStep.get(cid || '');
        if (st && U.T(callTs.get(cid || ''))) {
          const d = U.isoMs(callTs.get(cid), ts);
          if (d !== null) st.tools_ms = Math.max(st.tools_ms || 0, d);
        }
      } else if (pt === 'compaction') {
        add(K.COMPACTION, r, 'Context compacted', { label: 'compaction' });
      }
    } else if (t === 'event_msg') {
      if (p.type === 'token_count') window = U.or(U.or(p.info, {}).model_context_window, window);
      else if (p.type === 'turn_aborted') add(K.SYSTEM_EVENT, r, `turn aborted: ${U.get(p, 'reason', '')}`, { label: 'turn_aborted' });
    } else if (t === 'token_usage_record') {
      const u = U.or(p.usage, {});
      const tid = U.or(p.turn_id, '');
      const model = modelOfTurn.get(tid) ?? 'unknown';
      const cached = U.toInt(U.or(u.cached_input_tokens, 0));
      const written = U.toInt(U.or(u.cache_write_input_tokens, 0));
      const step = M.step({
        index: ps.steps.length,
        turn,
        model,
        ts,
        end_ts: ts,
        msg_id: U.get(p, 'response_id', null),
        sidechain: Boolean(U.T(p.root_turn_id) && p.root_turn_id !== tid),
        input_tokens: Math.max(0, U.toInt(U.or(u.input_tokens, 0)) - cached - written),
        output_tokens: U.toInt(U.or(u.output_tokens, 0)),
        cache_read_tokens: cached,
        cache_write_tokens: written,
        request_ts: lastInputTs,
        first_event: pending.length ? pending[0] : ps.events.length,
        system_key: 'codex',
        context_window: U.T(window) ? U.toInt(window) : null,
      });
      step.model_ms = U.isoMs(lastInputTs, ts);
      for (const idx of pending) {
        const ev = ps.events[idx];
        ev.step = step.index;
        ev.model = model;
        if (ev.kind === K.TOOL_CALL && U.T(ev.tool_use_id)) callStep.set(ev.tool_use_id, step);
      }
      pending = [];
      ps.steps.push(step);
      if (!modelsSeen.includes(model) && !step.sidechain) modelsSeen.push(model);
    }
  }

  ps.shapes.set('codex', {
    system: systemTexts.length ? [{ type: 'text', text: systemTexts.join('\n\n') }] : [],
    tools: toolsSchema,
  });
  M.finish(ps, {
    turn,
    models: modelsSeen,
    costOf: (st) => usageCost(st.model, M.usage(st)),
    steps: ps.steps.filter((s) => !s.sidechain).length,
    title: U.or(U.firstLineOf(firstPrompt), meta.id),
  });
  meta.subagent_steps = ps.steps.filter((s) => s.sidechain).length;
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, root, discover, parse };
