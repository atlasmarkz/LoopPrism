'use strict';
// Claude Code: ~/.claude/projects/<project>/<session>.jsonl (port of sessions/claude_code.py).
//
// Newer Claude Code versions also log the exact request each model call sent (api-request +
// api-request-shape + api-request-blob records). Those make the Context view exact; for older
// sessions the request is rebuilt from the conversation.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');

const AGENT = 'claude-code';
const CONTEXT_TAGS = ['<system-reminder>', '<local-command-', '<command-stdout>', '<user-prompt-submit-hook>'];
const LONG_CONTEXT_TOKENS = 100_000;
const MAX_MODEL_MS = 30 * 60 * 1000;

function root() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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

/** Claude Code's content hash of a request message (sha256 of canonical JSON). */
function messageHash(message) {
  const blob = U.pyDumps(message, { sep: [',', ':'], sortKeys: true, ensureAscii: false });
  return crypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

/** Is a user-role text block typed by the human, or injected by the harness? */
function classifyText(text) {
  const head = U.cpSlice(U.lstrip(text), 300);
  if (head.includes('This session is being continued from a previous conversation')) return [K.COMPACTION, null];
  if (U.cpSlice(text, 300).includes('Base directory for this skill') || head.startsWith('Launching skill')) return [K.CONTEXT, 'skill'];
  if (CONTEXT_TAGS.some((t) => head.startsWith(t)) || head.startsWith('Caveat:')) return [K.CONTEXT, 'system-reminder'];
  return [K.USER, null];
}

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(U.isObj) : [];
}

function resultText(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!U.isObj(b)) continue;
    parts.push(b.type === 'text' ? b.text : `[${'type' in b ? U.pyStr(b.type) : 'block'}]`);
  }
  return parts.filter((p) => U.T(p)).join('\n');
}

function parse(file, standalone = false) {
  const stat = fs.statSync(file);
  const rows = U.readRows(file);
  const sid = path.basename(file, path.extname(file));
  const meta = M.meta({ id: sid, agent: AGENT, path: file, size_bytes: stat.size });
  const ps = M.session(meta);
  const side = (row) => (standalone ? false : Boolean(row.isSidechain));

  // ---- pass 1: message pool (so request records can be resolved)
  const blobs = new Map();
  const assistantMsgs = new Map();
  let userRun = [];
  for (const r of rows) {
    const t = r.type;
    if (t === 'api-request-blob' && U.isObj(r.message)) {
      blobs.set(U.get(r, 'hash', ''), r.message);
    } else if (t === 'user' && U.isObj(r.message)) {
      const m = r.message;
      const role = U.get(m, 'role', 'user');
      const content = U.get(m, 'content', null);
      ps.pool.set(messageHash({ role, content }), { role, content });
      // The API merges adjacent user messages (parallel tool results, then the next prompt); index those too.
      userRun.push(blocks(content));
      for (let start = Math.max(0, userRun.length - 8); start < userRun.length - 1; start++) {
        const merged = userRun.slice(start).flat();
        ps.pool.set(messageHash({ role: 'user', content: merged }), { role: 'user', content: merged });
      }
    } else if (t === 'assistant' && U.isObj(r.message)) {
      userRun = [];
      const m = r.message;
      const key = U.or(m.id, U.get(r, 'uuid', ''));
      if (!assistantMsgs.has(key)) assistantMsgs.set(key, { role: 'assistant', content: [] });
      const c = U.or(m.content, []);
      assistantMsgs.get(key).content.push(...(typeof c === 'string' ? [...c] : c));
    }
  }
  for (const a of assistantMsgs.values()) ps.pool.set(messageHash(a), a);
  for (const [h, m] of blobs) ps.pool.set(h, m);
  for (const r of rows) if (r.type === 'api-request-shape' && U.T(r.shapeHash)) ps.shapes.set(r.shapeHash, U.or(r.shape, {}));

  // ---- pass 2: events and steps
  let turn = 0;
  let titleCustom = '';
  let titleAgent = '';
  let lastPrompt = '';
  let firstPrompt = '';
  const pendingRequests = [];
  const requestLists = new Map();
  const stepsByMsg = new Map();
  let lastModel = null;
  const toolUseTs = new Map();
  const toolUseStep = new Map();
  const search = new M.SearchText();
  const modelsSeen = [];
  let exactSteps = 0;

  const add = (kind, row, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: U.get(row, 'timestamp', null), turn, text: M.clip(text), sidechain: side(row), ...kw });
    ps.events.push(ev);
    return ev;
  };

  for (const r of rows) {
    const t = r.type;
    const ts = U.get(r, 'timestamp', null);
    if (U.T(ts)) {
      meta.started_at = U.or(meta.started_at, ts);
      meta.ended_at = ts;
    }
    if (U.T(r.cwd) && !meta.project) meta.project = r.cwd;
    if (U.T(r.version)) meta.version = r.version;
    if (U.T(r.gitBranch)) meta.git_branch = r.gitBranch;

    if (t === 'custom-title') titleCustom = U.or(r.customTitle, titleCustom);
    else if (t === 'agent-name') titleAgent = U.or(r.agentName, titleAgent);
    else if (t === 'last-prompt') lastPrompt = U.or(r.lastPrompt, lastPrompt);
    else if (t === 'api-request') {
      pendingRequests.push(r);
      const base = requestLists.get(U.or(r.base, '')) || [];
      requestLists.set(U.get(r, 'id', ''), [...base.slice(0, U.toInt(U.or(r.keep, 0))), ...U.or(r.tail, [])]);
    } else if (t === 'attachment') {
      const att = U.or(r.attachment, {});
      let text = '';
      for (const b of U.or(r.rendered, [])) {
        if (U.isObj(b)) text += U.or(typeof b.content === 'string' ? b.content : U.get(b, 'text', ''), '');
      }
      if (!text) text = U.pyDumps(att, { ensureAscii: false });
      add(K.CONTEXT, r, text, { label: U.or(att.type, 'attachment') });
    } else if (t === 'system') {
      const sub = U.or(r.subtype, 'system');
      if (sub === 'compact_boundary') add(K.COMPACTION, r, U.or(r.content, 'Conversation compacted'), { label: sub });
      else {
        const picked = {};
        for (const [k, v] of Object.entries(r)) if (['hookCount', 'stopReason', 'level'].includes(k)) picked[k] = v;
        add(K.SYSTEM_EVENT, r, U.or(r.content, U.pyDumps(picked)), { label: sub });
      }
    } else if (t === 'user' && U.isObj(r.message)) {
      const content = U.get(r.message, 'content', null);
      const sidechain = side(r);
      if (U.T(r.isCompactSummary)) {
        add(K.COMPACTION, r, typeof content === 'string' ? content : resultText(content), { label: 'summary' });
        continue;
      }
      for (const b of blocks(content)) {
        const bt = b.type;
        if (bt === 'tool_result') {
          const uid = U.get(b, 'tool_use_id', null);
          add(K.TOOL_RESULT, r, resultText(b.content), { tool_use_id: uid, is_error: Boolean(b.is_error) });
          const st = toolUseStep.get(uid || '');
          if (st && U.T(ts) && U.T(toolUseTs.get(uid || ''))) {
            const d = U.isoMs(toolUseTs.get(uid), ts);
            if (d !== null) st.tools_ms = Math.max(st.tools_ms || 0, d);
          }
        } else if (bt === 'text') {
          const text = U.or(b.text, '');
          if (!U.strip(text)) continue;
          const [kind, label] = classifyText(text);
          if (kind === K.USER && !sidechain) {
            turn += 1;
            firstPrompt = U.or(firstPrompt, text);
            search.add(text);
          }
          add(kind, r, text, { label });
        } else if (bt === 'image') {
          add(K.USER, r, '[image]');
        }
      }
    } else if (t === 'assistant' && U.isObj(r.message)) {
      const m = r.message;
      const mid = U.or(m.id, U.or(r.uuid, ''));
      const model = U.or(m.model, 'unknown');
      let step = stepsByMsg.get(mid);
      if (!step) {
        if (model !== '<synthetic>' && lastModel && model !== lastModel && !side(r)) {
          add(K.MODEL_CHANGE, r, `model changed: ${lastModel} → ${model}`, { model });
        }
        if (model !== '<synthetic>' && !side(r)) {
          lastModel = model;
          if (!modelsSeen.includes(model)) modelsSeen.push(model);
        }
        step = M.step({ index: ps.steps.length, turn, model, ts, msg_id: mid, sidechain: side(r), first_event: ps.events.length });
        // The request that produced this response is the latest one logged before it.
        const req = pendingRequests.length ? pendingRequests[pendingRequests.length - 1] : null;
        pendingRequests.length = 0;
        if (req) {
          step.request_ts = U.get(req, 'timestamp', null);
          step.refs = requestLists.get(U.get(req, 'id', '')) ?? null;
          step.system_key = U.get(req, 'shapeHash', null);
          exactSteps += 1;
        }
        ps.steps.push(step);
        stepsByMsg.set(mid, step);
      }
      step.end_ts = U.or(ts, step.end_ts);
      const u = U.or(m.usage, {});
      const cc = U.or(u.cache_creation, {});
      step.input_tokens = Math.max(step.input_tokens, U.toInt(U.or(u.input_tokens, 0)));
      step.output_tokens = Math.max(step.output_tokens, U.toInt(U.or(u.output_tokens, 0)));
      step.cache_read_tokens = Math.max(step.cache_read_tokens, U.toInt(U.or(u.cache_read_input_tokens, 0)));
      if (U.isObj(cc) && ('ephemeral_5m_input_tokens' in cc || 'ephemeral_1h_input_tokens' in cc)) {
        step.cache_write_tokens = Math.max(step.cache_write_tokens, U.toInt(U.or(cc.ephemeral_5m_input_tokens, 0)));
        step.cache_write_1h_tokens = Math.max(step.cache_write_1h_tokens, U.toInt(U.or(cc.ephemeral_1h_input_tokens, 0)));
      } else {
        step.cache_write_tokens = Math.max(step.cache_write_tokens, U.toInt(U.or(u.cache_creation_input_tokens, 0)));
      }
      if (U.T(r.thinkingDurationMs)) step.thinking_ms = Math.max(step.thinking_ms || 0, Number(r.thinkingDurationMs));
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!U.isObj(b)) continue;
        const bt = b.type;
        if (bt === 'thinking') add(K.THINKING, r, U.or(b.thinking, ''), { step: step.index, model });
        else if (bt === 'text') {
          const text = U.or(b.text, '');
          if (U.strip(text)) {
            add(K.ASSISTANT, r, text, { step: step.index, model });
            if (!side(r)) search.add(text);
          }
        } else if (bt === 'tool_use') {
          const uid = U.get(b, 'id', null);
          add(K.TOOL_CALL, r, '', { step: step.index, model, tool_name: U.get(b, 'name', null), tool_input: U.get(b, 'input', null), tool_use_id: uid });
          if (U.T(uid)) {
            toolUseStep.set(uid, step);
            if (U.T(ts)) toolUseTs.set(uid, ts);
          }
        }
      }
    }
  }

  // ---- finish steps: cost, timing
  for (const st of ps.steps) {
    if (st.model === '<synthetic>') continue;
    st.cost_usd = usageCost(st.model, { ...M.usage(st), long_context: M.totalInput(st) > LONG_CONTEXT_TOKENS });
    if (st.request_ts && st.end_ts) {
      const d = U.isoMs(st.request_ts, st.end_ts);
      // A model call lasting over 30 minutes is a mispairing, not data.
      st.model_ms = d !== null && d <= MAX_MODEL_MS ? d : null;
    }
  }
  const real = ps.steps.filter((s) => s.model !== '<synthetic>').length;
  const firstLine = U.firstLineOf(U.or(firstPrompt, lastPrompt));
  M.finish(ps, {
    turn,
    models: modelsSeen,
    steps: ps.steps.filter((s) => !s.sidechain && s.model !== '<synthetic>').length,
    title: U.or(titleCustom, U.or(titleAgent, U.or(firstLine, sid))),
  });
  meta.subagent_steps = ps.steps.filter((s) => s.sidechain).length;
  meta.fidelity = ps.steps.length && exactSteps >= real * 0.9 && exactSteps ? 'exact' : 'estimated';
  ps.search_text = search.toString();

  const seen = new Set();
  for (const st of ps.steps) for (const h of st.refs || []) if (!ps.pool.has(h)) seen.add(h);
  ps.unresolved = seen.size;
  return ps;
}

module.exports = { AGENT, root, discover, parse, messageHash, classifyText, resultText };
