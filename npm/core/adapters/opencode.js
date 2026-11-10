'use strict';
// OpenCode: sessions in ~/.local/share/opencode/opencode.db (SQLite) (port of sessions/opencode.py).
// A session is not a file, so it is addressed as "<db path>#<session id>". Each step-finish part
// carries the token usage of one model call; reasoning tokens are billed as output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');
const { openReadOnly } = require('../sqlite');

const AGENT = 'opencode';
const SEP = '#';

function root() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

function splitPath(p) {
  const i = p.lastIndexOf(SEP);
  return [p.slice(0, i), p.slice(i + 1)];
}

/** {"<db>#<session id>": [mtime seconds, size]} for every top-level session. */
function discover(db) {
  const out = new Map();
  if (!isFile(db)) return out;
  let rows;
  try {
    const c = openReadOnly(db);
    try {
      rows = c.prepare(
        'SELECT s.id, s.time_updated, ' +
          'COALESCE((SELECT MAX(m.time_updated) FROM message m WHERE m.session_id = s.id), 0) AS mu, ' +
          '(SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) AS parts ' +
          'FROM session s WHERE s.parent_id IS NULL',
      ).all();
    } finally {
      c.close();
    }
  } catch {
    return out;
  }
  for (const r of rows) out.set(`${db}${SEP}${r.id}`, [Math.max(r.time_updated || 0, r.mu || 0) / 1000, U.toInt(r.parts || 0)]);
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function j(text) {
  try {
    const v = JSON.parse(text);
    return U.isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function toolText(out) {
  if (typeof out === 'string') return out;
  if (out === null || out === undefined) return '';
  return U.pyDumps(out, { ensureAscii: false });
}

function parse(p) {
  const [db, sid] = splitPath(p);
  const st = fs.statSync(db);
  const meta = M.meta({ id: sid, agent: AGENT, path: p, size_bytes: st.size, fidelity: 'estimated' });
  const ps = M.session(meta);
  const c = openReadOnly(db);
  let srow;
  let messages;
  const parts = new Map();
  try {
    srow = c.prepare('SELECT * FROM session WHERE id = ?').get(sid);
    messages = c.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(sid);
    for (const row of c.prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id').iterate(sid)) {
      if (!parts.has(row.message_id)) parts.set(row.message_id, []);
      parts.get(row.message_id).push(row);
    }
  } finally {
    c.close();
  }
  if (srow) {
    meta.project = srow.directory || null;
    meta.title = srow.title || '';
    meta.version = srow.version ?? null;
    meta.started_at = U.isoOfMs(srow.time_created);
    meta.ended_at = U.isoOfMs(srow.time_updated);
  }

  let turn = 0;
  let firstPrompt = '';
  const modelsSeen = [];
  const search = new M.SearchText();
  let lastInputMs = null;
  let lastMs = null;

  const add = (kind, ms, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: U.isoOfMs(ms), turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };

  for (const m of messages) {
    const d = j(m.data);
    const ms = m.time_created;
    lastMs = ms;
    if (d.role === 'user') {
      const texts = [];
      for (const prt of parts.get(m.id) || []) {
        const pj = j(prt.data);
        if (pj.type === 'text' && typeof pj.text === 'string' && U.strip(pj.text)) {
          if (U.T(pj.synthetic)) add(K.CONTEXT, ms, pj.text, { label: 'synthetic' });
          else texts.push(pj.text);
        }
      }
      if (texts.length) {
        turn += 1;
        const text = texts.join('\n');
        firstPrompt = U.or(firstPrompt, text);
        search.add(text);
        add(K.USER, ms, text);
      }
      lastInputMs = ms;
    } else if (d.role === 'assistant') {
      const model = U.or(d.modelID, 'unknown');
      let pending = [];
      let toolMs = new Map();
      for (const prt of parts.get(m.id) || []) {
        const pj = j(prt.data);
        const t = pj.type;
        const pms = prt.time_created;
        lastMs = pms;
        const startOf = (o) => U.or(U.or(o, {}).start, pms);
        if (t === 'reasoning') pending.push(add(K.THINKING, startOf(pj.time), U.pyStr(U.or(pj.text, ''))).idx);
        else if (t === 'text') {
          const text = U.pyStr(U.or(pj.text, ''));
          if (U.strip(text)) {
            search.add(text);
            pending.push(add(K.ASSISTANT, startOf(pj.time), text).idx);
          }
        } else if (t === 'tool') {
          const state = U.isObj(pj.state) ? pj.state : {};
          const tm = U.or(state.time, {});
          const call = add(K.TOOL_CALL, U.or(tm.start, pms), '', { tool_name: U.get(pj, 'tool', null), tool_input: U.get(state, 'input', null), tool_use_id: U.get(pj, 'callID', null) });
          pending.push(call.idx);
          if (state.status === 'completed' || state.status === 'error') {
            const res = state.status === 'completed' ? state.output : state.error;
            add(K.TOOL_RESULT, U.or(tm.end, pms), toolText(res), { tool_use_id: U.get(pj, 'callID', null), is_error: state.status === 'error' });
            const took = U.msBetween(tm.start, tm.end);
            if (took !== null) toolMs.set(U.or(pj.callID, ''), took);
          }
        } else if (t === 'step-finish') {
          const tok = U.or(pj.tokens, {});
          const cache = U.or(tok.cache, {});
          const step = M.step({
            index: ps.steps.length,
            turn,
            model,
            ts: U.isoOfMs(lastInputMs),
            end_ts: U.isoOfMs(pms),
            msg_id: m.id,
            input_tokens: U.toInt(U.or(tok.input, 0)),
            output_tokens: U.toInt(U.or(tok.output, 0)) + U.toInt(U.or(tok.reasoning, 0)),
            cache_read_tokens: U.toInt(U.or(cache.read, 0)),
            cache_write_tokens: U.toInt(U.or(cache.write, 0)),
            request_ts: U.isoOfMs(lastInputMs),
            first_event: pending.length ? pending[0] : ps.events.length,
          });
          step.model_ms = U.msBetween(lastInputMs, pms);
          const ours = usageCost(model, M.usage(step));
          // our price table first (the same models in every agent); else what OpenCode charged
          step.cost_usd = ours !== null ? ours : typeof pj.cost === 'number' ? pj.cost : null;
          if (toolMs.size) step.tools_ms = Math.max(...toolMs.values());
          for (const idx of pending) {
            ps.events[idx].step = step.index;
            ps.events[idx].model = model;
          }
          pending = [];
          toolMs = new Map();
          ps.steps.push(step);
          lastInputMs = pms;
          if (!modelsSeen.includes(model)) modelsSeen.push(model);
        }
      }
    }
  }

  M.finish(ps, { turn, models: modelsSeen });
  meta.ended_at = U.or(U.isoOfMs(lastMs), meta.ended_at);
  if (!meta.title || meta.title.startsWith('New session')) {
    meta.title = U.cpSlice(U.or(U.firstLineOf(firstPrompt), U.or(meta.title, sid)), 200);
  }
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, SEP, root, discover, parse, splitPath };
