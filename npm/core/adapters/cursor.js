'use strict';
// Cursor: Agent / Chat conversations in <Cursor User dir>/globalStorage/state.vscdb (port of sessions/cursor.py).
// VS Code's key-value table cursorDiskKV: composerData:<id> (header), composerConvHeaders:<id>:<chunk>
// (ordered bubble list), bubbleId:<id>:<bubble> (one message). Addressed as "<db>#<composerId>".
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');
const { openReadOnly, text: colText } = require('../sqlite');
const { classifyText } = require('./claude_code');

const AGENT = 'cursor';
const SEP = '#';
const PLACEHOLDER_TITLES = new Set(['', 'general chat', 'new chat', 'new agent', 'untitled']);
const FAILED = new Set(['error', 'failed', 'cancelled', 'canceled', 'rejected', 'aborted']);

function userDir() {
  if (process.env.CURSOR_USER_DIR) return process.env.CURSOR_USER_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'Cursor', 'User');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
}

const root = () => path.join(userDir(), 'globalStorage', 'state.vscdb');

function splitPath(p) {
  const i = p.lastIndexOf(SEP);
  return [p.slice(0, i), p.slice(i + 1)];
}

function j(value) {
  try {
    return JSON.parse(colText(value));
  } catch {
    return null;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** {"<db>#<composer id>": [mtime seconds, size]} for every conversation that has messages. */
function discover(db) {
  const out = new Map();
  if (!isFile(db)) return out;
  try {
    const c = openReadOnly(db);
    try {
      const counts = new Map();
      for (const r of c.prepare("SELECT substr(key, 10, 36) AS cid, COUNT(*) AS n FROM cursorDiskKV WHERE key >= 'bubbleId:' AND key < 'bubbleId;' GROUP BY 1").iterate()) {
        counts.set(colText(r.cid), r.n);
      }
      let skip = new Set();
      try {
        skip = new Set(c.prepare('SELECT composerId FROM composerHeaders WHERE isSubagent = 1').all().map((r) => r.composerId));
      } catch {
        // older databases have no composerHeaders table
      }
      for (const r of c.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").iterate()) {
        const cid = colText(r.key).slice('composerData:'.length);
        if (skip.has(cid) || !counts.get(cid)) continue;
        const d = U.or(j(r.value), {});
        const stamp = U.or(d.lastUpdatedAt, U.or(d.createdAt, 0));
        out.set(`${db}${SEP}${cid}`, [stamp / 1000, counts.get(cid)]);
      }
    } finally {
      c.close();
    }
  } catch {
    return new Map();
  }
  return out;
}

function iso(v) {
  if (typeof v === 'number') return U.isoOfMs(v);
  return typeof v === 'string' ? v : null;
}

function folderOf(db, workspaceId) {
  if (!workspaceId || workspaceId === 'empty-window') return null;
  const f = path.join(path.dirname(path.dirname(db)), 'workspaceStorage', workspaceId, 'workspace.json');
  let uri;
  try {
    uri = (JSON.parse(fs.readFileSync(f, 'utf8')) || {}).folder;
  } catch {
    return null;
  }
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null; // a remote workspace
  let p;
  try {
    p = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
  if (process.platform === 'win32' && p.length > 2 && p[0] === '/' && p[2] === ':') p = p.slice(1);
  return p;
}

function toolText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const v = j(value);
    if (v !== null && typeof v === 'object') return U.cpSlice(U.pyDumps(v, { ensureAscii: false, indent: 2 }), 100_000);
    return value;
  }
  return U.pyDumps(value, { ensureAscii: false });
}

function orderedIds(c, cid, header) {
  const ids = [];
  const chunks = c.prepare('SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key').all(`composerConvHeaders:${cid}:`, `composerConvHeaders:${cid};`);
  for (const r of chunks) for (const h of U.or(j(r.value), [])) if (U.isObj(h) && U.T(h.bubbleId)) ids.push(h.bubbleId);
  if (!ids.length) for (const h of U.or(header.fullConversationHeadersOnly, [])) if (U.isObj(h) && U.T(h.bubbleId)) ids.push(h.bubbleId);
  return ids;
}

function parse(p) {
  const [db, cid] = splitPath(p);
  const st = fs.statSync(db);
  const meta = M.meta({ id: cid, agent: AGENT, path: p, size_bytes: st.size, fidelity: 'estimated' });
  const ps = M.session(meta);
  const c = openReadOnly(db);
  let header;
  let ids;
  const bubbles = new Map();
  try {
    const row = c.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${cid}`);
    header = U.or(row ? j(row.value) : null, {});
    ids = orderedIds(c, cid, header);
    const prefix = `bubbleId:${cid}:`;
    for (const r of c.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?').iterate(prefix, `bubbleId:${cid};`)) {
      const b = j(r.value);
      if (U.isObj(b)) bubbles.set(colText(r.key).slice(prefix.length), b);
    }
    for (const b of U.or(header.conversation, [])) {
      if (U.isObj(b) && U.T(b.bubbleId)) {
        if (!bubbles.has(b.bubbleId)) bubbles.set(b.bubbleId, b);
        if (!ids.includes(b.bubbleId)) ids.push(b.bubbleId);
      }
    }
  } finally {
    c.close();
  }
  if (!ids.length) {
    const key = (k) => U.pyStr(U.or(bubbles.get(k).createdAt, ''));
    ids = [...bubbles.keys()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  meta.started_at = iso(header.createdAt);
  meta.ended_at = U.or(iso(header.lastUpdatedAt), meta.started_at);
  meta.project = folderOf(db, U.or(header.workspaceIdentifier, {}).id);

  let turn = 0;
  let firstPrompt = '';
  const modelsSeen = [];
  const search = new M.SearchText();
  const add = (kind, ts, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: iso(ts), turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };
  const seeModel = (b) => {
    const name = U.isObj(b.modelInfo) ? b.modelInfo.modelName : null;
    if (U.T(name) && !modelsSeen.includes(name)) modelsSeen.push(name);
    return name;
  };

  let model = U.isObj(header.modelConfig) ? header.modelConfig.modelName ?? null : null;
  for (const bid of ids) {
    const b = bubbles.get(bid);
    if (!U.T(b)) continue;
    const ts = b.createdAt;
    model = U.or(seeModel(b), model);
    const text = typeof b.text === 'string' ? b.text : '';
    if (b.type === 1) {
      if (!U.strip(text)) continue;
      const [kind, label] = classifyText(text);
      if (kind === K.CONTEXT) {
        add(K.CONTEXT, ts, text, { label });
        continue;
      }
      turn += 1;
      firstPrompt = U.or(firstPrompt, text);
      search.add(text);
      add(K.USER, ts, text);
      continue;
    }
    const thinking = b.thinking;
    if (U.isObj(thinking) && U.strip(U.pyStr(U.or(thinking.text, '')))) add(K.THINKING, ts, thinking.text, { model });
    const tool = b.toolFormerData;
    if (U.isObj(tool) && U.T(tool.name)) {
      const callId = U.pyStr(U.or(tool.toolCallId, bid));
      let args = typeof tool.rawArgs === 'string' ? j(tool.rawArgs) : tool.rawArgs ?? null;
      if (args === null) args = typeof tool.params === 'string' ? j(tool.params) : tool.params ?? null;
      add(K.TOOL_CALL, ts, '', { tool_name: U.pyStr(tool.name), tool_input: args, tool_use_id: callId, model });
      const failed = FAILED.has(U.pyStr(U.or(tool.status, '')).toLowerCase());
      add(K.TOOL_RESULT, ts, U.or(toolText(tool.result), U.pyStr(U.or(tool.error, ''))), { tool_use_id: callId, is_error: failed });
    }
    if (U.strip(text)) {
      search.add(text);
      add(K.ASSISTANT, ts, text, { model });
    }
    const tokens = U.isObj(b.tokenCount) ? b.tokenCount : {};
    const tin = U.toInt(U.or(tokens.inputTokens, 0));
    const tout = U.toInt(U.or(tokens.outputTokens, 0));
    if ((tin || tout) && ps.events.length) {
      // older versions recorded usage per message
      const step = M.step({ index: ps.steps.length, turn, model: U.or(model, 'unknown'), ts: iso(ts), end_ts: iso(ts), msg_id: bid, input_tokens: tin, output_tokens: tout, first_event: ps.events.length - 1 });
      ps.steps.push(step);
      ps.events[ps.events.length - 1].step = step.index;
    }
  }

  const name = U.strip(U.pyStr(U.or(header.name, '')));
  const title = PLACEHOLDER_TITLES.has(name.toLowerCase()) ? U.strip(firstPrompt) : name;
  M.finish(ps, {
    turn,
    models: modelsSeen.length ? modelsSeen : U.T(model) ? [model] : [],
    costOf: (s) => usageCost(s.model, M.usage(s)),
    title: U.or(title ? U.firstLine(title) : '', cid),
  });
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, SEP, root, discover, parse, splitPath };
