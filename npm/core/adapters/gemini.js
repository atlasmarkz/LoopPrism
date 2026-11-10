'use strict';
// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl (older: session-*.json) (port of sessions/gemini.py).
// Append-only JSON lines: a header, one record per message, and edits of earlier records
// ($patch, $rewindTo, $set). The project's folder is in ~/.gemini/tmp/<project>/.project_root.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');
const { classifyText } = require('./claude_code');

const AGENT = 'gemini';

function root() {
  const base = process.env.GEMINI_CLI_HOME || os.homedir();
  return path.join(base, '.gemini', 'tmp');
}

const stemOf = (name) => name.slice(0, name.lastIndexOf('.json'));

function discover(dir) {
  const found = new Map();
  let projects;
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chats = path.join(dir, p.name, 'chats');
    let files;
    try {
      files = fs.readdirSync(chats, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.startsWith('session-') && (f.name.endsWith('.json') || f.name.endsWith('.jsonl'))) {
        const stem = path.join(chats, stemOf(f.name));
        if (!found.has(stem) || f.name.endsWith('.jsonl')) found.set(stem, path.join(chats, f.name));
      }
    }
  }
  return [...found.values()];
}

function projectOf(file) {
  try {
    return U.strip(fs.readFileSync(path.join(path.dirname(path.dirname(file)), '.project_root'), 'utf8')) || null;
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (U.isObj(content)) content = [content];
  const parts = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (typeof p === 'string') parts.push(p);
    else if (U.isObj(p)) {
      if (typeof p.text === 'string') parts.push(p.text);
      else if ('inlineData' in p || 'fileData' in p) parts.push('[attachment]');
    }
  }
  return parts.filter((x) => U.T(x)).join('\n');
}

function resultText(call) {
  const out = [];
  const res = call.result;
  for (const p of U.isObj(res) ? [res] : Array.isArray(res) ? res : []) {
    const fr = U.isObj(p) ? p.functionResponse : null;
    if (U.isObj(fr)) {
      const body = fr.response;
      if (U.isObj(body)) {
        const v = 'output' in body ? body.output : U.get(body, 'error', null);
        out.push(typeof v === 'string' ? v : U.pyDumps(body, { ensureAscii: false }));
      } else if (body !== null && body !== undefined) out.push(U.pyStr(body));
    } else if (typeof p === 'string') out.push(p);
  }
  if (out.length) return out.join('\n');
  return typeof call.resultDisplay === 'string' ? call.resultDisplay : '';
}

function applyPatch(order, msgs, patch) {
  const edits = [...U.or(patch.updates, [])];
  if (U.T(patch.id)) edits.push(patch);
  for (const e of edits) {
    const m = msgs.get(U.get(e, 'id'));
    if (!m) continue;
    if ('content' in e) m.content = e.content;
    for (const tp of U.or(e.toolCalls, [])) {
      for (const call of U.or(m.toolCalls, [])) if (call.id === tp.id && 'result' in tp) call.result = tp.result;
    }
  }
  for (const rid of U.or(patch.removeIds, [])) {
    msgs.delete(rid);
    const i = order.indexOf(rid);
    if (i >= 0) order.splice(i, 1);
  }
  if (U.T(patch.orderIds)) {
    const wanted = patch.orderIds.filter((i) => msgs.has(i));
    const rest = order.filter((i) => !wanted.includes(i));
    order.splice(0, order.length, ...wanted, ...rest);
  }
}

/** [header, messages in order] of a session file, with patches and rewinds applied. */
function load(file) {
  let header = {};
  const order = [];
  const msgs = new Map();
  const add = (m) => {
    if (!msgs.has(m.id)) order.push(m.id);
    msgs.set(m.id, m);
  };
  if (file.endsWith('.json')) {
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      doc = {};
    }
    if (U.isObj(doc)) {
      for (const [k, v] of Object.entries(doc)) if (k !== 'messages') header[k] = v;
      for (const m of U.or(doc.messages, [])) if (U.isObj(m) && typeof m.id === 'string') add(m);
    }
    return [header, order.map((i) => msgs.get(i))];
  }
  for (const r of U.readRows(file)) {
    if (typeof r.$rewindTo === 'string') {
      const i = order.indexOf(r.$rewindTo);
      if (i >= 0) {
        for (const dropped of order.slice(i)) msgs.delete(dropped);
        order.splice(i);
      }
    } else if (U.isObj(r.$patch)) applyPatch(order, msgs, r.$patch);
    else if (U.isObj(r.$set)) {
      for (const [k, v] of Object.entries(r.$set)) {
        if (k === 'messages') {
          order.length = 0;
          msgs.clear();
          for (const m of U.or(v, [])) if (U.isObj(m) && typeof m.id === 'string') add(m);
        } else header[k] = v;
      }
    } else if (typeof r.id === 'string' && 'timestamp' in r) add(r);
    else if ('sessionId' in r && 'projectHash' in r) header = { ...header, ...r };
  }
  return [header, order.map((i) => msgs.get(i))];
}

function parse(file) {
  const stat = fs.statSync(file);
  const [header, messages] = load(file);
  const stem = stemOf(path.basename(file));
  const meta = M.meta({ id: String(U.or(header.sessionId, stem)), agent: AGENT, path: file, size_bytes: stat.size, fidelity: 'estimated', project: projectOf(file) });
  meta.started_at = U.get(header, 'startTime', null);
  meta.ended_at = U.or(header.lastUpdated, meta.started_at);
  const ps = M.session(meta);

  let turn = 0;
  let firstPrompt = '';
  const modelsSeen = [];
  const search = new M.SearchText();
  let lastTs = meta.started_at;

  const add = (kind, ts, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: ts ?? null, turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };

  for (const m of messages) {
    const kind = m.type;
    const ts = U.get(m, 'timestamp', null);
    const text = textOf(m.content);
    if (kind === 'user') {
      if (!U.strip(text)) continue;
      const [evKind, label] = classifyText(text);
      if (evKind === K.CONTEXT) add(K.CONTEXT, ts, text, { label });
      else {
        turn += 1;
        firstPrompt = U.or(firstPrompt, text);
        search.add(text);
        add(K.USER, ts, text);
      }
      lastTs = ts;
    } else if (kind === 'gemini') {
      const model = U.or(m.model, 'unknown');
      const tokens = U.isObj(m.tokens) ? m.tokens : null;
      const first = ps.events.length;
      for (const th of U.or(m.thoughts, [])) {
        if (!U.isObj(th)) continue;
        const body = [th.subject, th.description].filter((x) => U.T(x)).join(' — ');
        add(K.THINKING, U.or(th.timestamp, ts), body, { model });
      }
      if (U.strip(text)) {
        search.add(text);
        add(K.ASSISTANT, ts, text, { model });
      }
      for (const c of U.or(m.toolCalls, []).filter(U.isObj)) {
        const cts = U.or(c.timestamp, ts);
        add(K.TOOL_CALL, cts, '', { tool_name: U.get(c, 'name', null), tool_input: U.get(c, 'args', null), tool_use_id: U.get(c, 'id', null), model });
        add(K.TOOL_RESULT, cts, resultText(c), { tool_use_id: U.get(c, 'id', null), is_error: c.status === 'error' || c.status === 'cancelled' });
      }
      if (U.T(tokens)) {
        const cached = U.toInt(U.or(tokens.cached, 0));
        const prompt = U.toInt(U.or(tokens.input, 0)) + U.toInt(U.or(tokens.tool, 0));
        const step = M.step({
          index: ps.steps.length, turn, model, ts: lastTs, end_ts: ts, msg_id: U.get(m, 'id', null),
          input_tokens: Math.max(0, prompt - cached), cache_read_tokens: cached,
          output_tokens: U.toInt(U.or(tokens.output, 0)) + U.toInt(U.or(tokens.thoughts, 0)),
          request_ts: lastTs, first_event: first,
        });
        step.model_ms = U.isoMs(lastTs, ts);
        ps.steps.push(step);
        for (const ev of ps.events.slice(first)) ev.step = step.index;
        if (!modelsSeen.includes(model)) modelsSeen.push(model);
      }
      lastTs = ts;
    } else if ((kind === 'error' || kind === 'warning') && U.strip(text)) {
      add(K.SYSTEM_EVENT, ts, text, { label: kind });
    }
  }

  const title = U.strip(U.pyStr(U.or(header.summary, firstPrompt)));
  M.finish(ps, {
    turn,
    models: modelsSeen,
    costOf: (st) => usageCost(st.model, M.usage(st)),
    title: U.or(title ? U.firstLine(title) : '', meta.id),
  });
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, root, discover, parse, load };
