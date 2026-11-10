'use strict';
// WorkBuddy (Tencent's desktop agent): ~/.workbuddy/projects/<project>/<session>.jsonl (port of sessions/workbuddy.py).
// Responses-API style items; all items of one model response share providerData.messageId and the
// usage of the response sits on one of them. prompt_tokens includes the cached part.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');
const { classifyText } = require('./claude_code');

const AGENT = 'workbuddy';
const REMINDER = /<system-reminder\b[^>]*>.*?<\/system-reminder>/gs;
const QUERY = /<user_query>(.*?)<\/user_query>/s;

/** [injected context, what the user typed] of a user message. */
function splitUserText(text) {
  const context = [...text.matchAll(REMINDER)].map((m) => m[0]).join('\n');
  const rest = U.strip(text.replace(REMINDER, ''));
  const q = rest.match(QUERY);
  return [context, q ? U.strip(q[1]) : rest];
}

function root() {
  const base = process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy');
  return path.join(base, 'projects');
}

function discover(dir) {
  const found = [];
  let projects;
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(dir, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) if (f.isFile() && f.name.endsWith('.jsonl')) found.push(path.join(dir, p.name, f.name));
  }
  return found;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!U.isObj(p)) continue;
    parts.push(typeof p.text === 'string' ? p.text : `[${U.pyStr('type' in p ? p.type : 'block').replace('_blob_ref', '')}]`);
  }
  return parts.filter((x) => U.T(x)).join('\n');
}

function usageOf(r) {
  const pd = U.or(r.providerData, {});
  let raw = pd.rawUsage;
  let alt = U.isObj(r.message) ? r.message.usage : null;
  if (!U.isObj(raw) && !U.isObj(alt)) return null;
  raw = U.isObj(raw) ? raw : {};
  alt = U.isObj(alt) ? alt : {};
  const prompt = U.toInt(U.or(raw.prompt_tokens, U.or(alt.input_tokens, 0)));
  const details = U.isObj(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const cached = Math.max(
    U.toInt(U.or(raw.prompt_cache_hit_tokens, 0)),
    U.toInt(U.or(raw.cache_read_input_tokens, 0)),
    U.toInt(U.or(raw.cached_tokens, 0)),
    U.toInt(U.or(details.cached_tokens, 0)),
    U.toInt(U.or(alt.cache_read_input_tokens, 0)),
  );
  const written = U.toInt(U.or(raw.cache_creation_input_tokens, U.or(raw.prompt_cache_write_tokens, 0)));
  const output = U.toInt(U.or(raw.completion_tokens, U.or(alt.output_tokens, 0)));
  return { input: Math.max(0, prompt - cached - written), output, cache_read: cached, cache_write: written };
}

function resultText(item) {
  const out = item.output;
  if (typeof out === 'string') return out;
  if (U.isObj(out)) return U.pyStr(U.or(out.text, ''));
  if (Array.isArray(out)) return textOf(out);
  const tr = U.or(U.or(item.providerData, {}).toolResult, {});
  return U.pyStr(U.or(tr.content, ''));
}

function parse(file) {
  const stat = fs.statSync(file);
  const meta = M.meta({ id: path.basename(file, path.extname(file)), agent: AGENT, path: file, size_bytes: stat.size, fidelity: 'estimated' });
  const ps = M.session(meta);

  let turn = 0;
  let firstPrompt = '';
  let title = '';
  const modelsSeen = [];
  const search = new M.SearchText();
  let lastInputMs = null;
  const pending = new Map();
  const stepOf = new Map();
  const callMs = new Map();
  const callStep = new Map();
  let lastMs = null;

  const add = (kind, ms, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: U.isoOfMs(ms), turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };

  /** Tie an assistant-side event to its model response, now or when its usage arrives. */
  const attach = (ev, mid, model) => {
    if (!U.T(mid)) return;
    ev.model = model ?? null;
    const st = stepOf.get(mid);
    if (st) {
      ev.step = st.index;
      if (ev.kind === K.TOOL_CALL && U.T(ev.tool_use_id)) callStep.set(ev.tool_use_id, st);
    } else {
      if (!pending.has(mid)) pending.set(mid, []);
      pending.get(mid).push(ev.idx);
    }
  };

  const openStep = (mid, usage, model, ms) => {
    if (stepOf.has(mid)) return;
    const waiting = pending.get(mid) || [];
    pending.delete(mid);
    const step = M.step({
      index: ps.steps.length,
      turn,
      model,
      ts: U.isoOfMs(lastInputMs),
      end_ts: U.isoOfMs(ms),
      msg_id: mid,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cache_read,
      cache_write_tokens: usage.cache_write,
      request_ts: U.isoOfMs(lastInputMs),
      first_event: waiting.length ? waiting[0] : ps.events.length,
    });
    step.model_ms = U.msBetween(lastInputMs, ms);
    ps.steps.push(step);
    stepOf.set(mid, step);
    for (const idx of waiting) {
      const ev = ps.events[idx];
      ev.step = step.index;
      if (ev.kind === K.TOOL_CALL && U.T(ev.tool_use_id)) callStep.set(ev.tool_use_id, step);
    }
    if (!modelsSeen.includes(model)) modelsSeen.push(model);
  };

  for (const r of U.readRows(file)) {
    const t = r.type;
    const ms = r.timestamp;
    const pd = U.or(r.providerData, {});
    if (typeof ms === 'number') {
      lastMs = ms;
      meta.started_at = U.or(meta.started_at, U.isoOfMs(ms));
    }
    meta.project = U.or(r.cwd, meta.project);
    if (U.T(r.sessionId)) meta.id = U.pyStr(r.sessionId);
    const mid = U.get(pd, 'messageId', null);
    const model = U.or(pd.model, U.or(pd.requestModelId, U.get(pd, 'requestModelName', null)));

    if (t === 'ai-title') title = U.pyStr(U.or(r.aiTitle, title));
    else if (t === 'message') {
      const role = r.role;
      const text = textOf(r.content);
      if (role === 'user') {
        if (U.T(pd.isSummary) || U.T(pd.isCompacted)) {
          add(K.COMPACTION, ms, text, { label: 'summary' });
          continue;
        }
        if (!U.strip(text)) continue;
        const [injected, typed] = splitUserText(text);
        if (injected) add(K.CONTEXT, ms, injected, { label: 'system-reminder' });
        if (typed) {
          const [kind, label] = classifyText(typed);
          if (kind === K.CONTEXT) add(K.CONTEXT, ms, typed, { label });
          else {
            turn += 1;
            firstPrompt = U.or(firstPrompt, typed);
            search.add(typed);
            add(K.USER, ms, typed);
          }
        }
        lastInputMs = ms;
      } else if (role === 'assistant') {
        if (U.T(pd.error)) {
          add(K.SYSTEM_EVENT, ms, U.isObj(pd.error) ? U.pyDumps(pd.error) : U.pyStr(pd.error), { label: 'error' });
        } else if (U.strip(text)) {
          search.add(text);
          attach(add(K.ASSISTANT, ms, text), mid, model);
        }
        const usage = usageOf(r);
        if (usage && U.T(mid)) openStep(mid, usage, U.or(model, 'unknown'), ms);
      }
    } else if (t === 'reasoning') {
      attach(add(K.THINKING, ms, U.or(textOf(r.rawContent), textOf(r.content))), mid, model);
    } else if (t === 'function_call') {
      const callId = U.get(r, 'callId', null);
      const ev = add(K.TOOL_CALL, ms, '', { tool_name: U.get(r, 'name', null), tool_input: U.maybeJson(r.arguments) ?? null, tool_use_id: callId });
      if (U.T(callId)) callMs.set(callId, ms);
      attach(ev, mid, model);
      const usage = usageOf(r);
      if (usage && U.T(mid)) openStep(mid, usage, U.or(model, 'unknown'), ms);
    } else if (t === 'function_call_result') {
      const callId = U.get(r, 'callId', null);
      const failed = ['failed', 'error', 'rejected', 'cancelled'].includes(U.pyStr(U.or(r.status, 'completed')));
      add(K.TOOL_RESULT, ms, resultText(r), { tool_use_id: callId, is_error: failed });
      lastInputMs = ms;
      const st = callStep.get(callId || '');
      const took = U.msBetween(callMs.get(callId || ''), ms);
      if (st && took !== null) st.tools_ms = Math.max(st.tools_ms || 0, took);
    }
  }

  meta.ended_at = U.or(U.isoOfMs(lastMs), meta.started_at);
  M.finish(ps, {
    turn,
    models: modelsSeen,
    costOf: (st) => usageCost(st.model, M.usage(st)),
    title: U.or(U.firstLineOf(U.or(title, firstPrompt)), meta.id),
  });
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, root, discover, parse, splitUserText };
