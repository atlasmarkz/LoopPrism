'use strict';
// DeepSeek Harness (dsh): ~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd] (port of sessions/dsh.py).
// Files are usually a series of independent zstd frames (one per flush); a file being written can
// end in a half frame, which is left for the next scan. Replacement records (surfaceOp replace) only
// change what the model sees and are skipped, except that a replacement user message is a compaction.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const M = require('../models');
const { K } = M;
const { usageCost } = require('../pricing');
const U = require('../util');

const AGENT = 'dsh';
const MAX_BYTES = 256 * 1024 * 1024;
const FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

function root() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(base, 'sessions');
}

/** DSH Desktop keeps its own copy of the harness (and its sessions) in its app-data folder. */
function desktopRoot() {
  let base = process.env.DSH_DESKTOP_HOME;
  if (!base) {
    if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness');
    else if (process.platform === 'win32') base = path.join(process.env.APPDATA || os.homedir(), 'dsh-desktop', 'harness');
    else return '';
  }
  return path.join(base, 'sessions');
}

function dirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The newest generation of every session's log. */
function discover(dir) {
  const found = [];
  for (const project of dirs(dir)) {
    if (!project.isDirectory()) continue;
    for (const session of dirs(path.join(dir, project.name))) {
      if (!session.isDirectory()) continue;
      const sdir = path.join(dir, project.name, session.name);
      let best = null;
      for (const f of dirs(sdir)) {
        const m = f.name.match(FILE_RE);
        if (m && f.isFile()) {
          const key = [Number(m[1] || 0), f.name];
          if (!best || key[0] > best[0] || (key[0] === best[0] && key[1] > best[1])) best = key;
        }
      }
      if (best) found.push(path.join(sdir, best[1]));
    }
  }
  return found;
}

// ------------------------------------------------------------------ zstd frames
/** Length of the zstd (or skippable) frame at `off`, or -1 when it is cut off. Throws when it is not a frame. */
function frameLength(buf, off) {
  const magic = buf.readUInt32LE(off);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    if (off + 8 > buf.length) return -1;
    const n = 8 + buf.readUInt32LE(off + 4);
    return off + n <= buf.length ? n : -1;
  }
  if (magic !== 0xfd2fb528) throw new Error('not a zstd frame');
  let p = off + 4;
  if (p >= buf.length) return -1;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;
  if (!single) p += 1; // window descriptor
  p += [0, 1, 2, 4][didFlag];
  p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    if (type === 3) throw new Error('reserved zstd block type');
    p += type === 1 ? 1 : size;
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p <= buf.length ? p - off : -1;
}

/** Concatenated zstd frames, stopping quietly at an unfinished last frame. */
function decompress(data) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('Reading DeepSeek Harness sessions needs Node.js 22.15 or newer (zstd support)');
  }
  const out = [];
  let size = 0;
  let off = 0;
  while (off < data.length) {
    if (data.length - off < 4) break; // the start of a frame that is still being written
    let n;
    try {
      n = frameLength(data, off);
    } catch (err) {
      if (out.length) break;
      throw new Error(`not a valid zstd session: ${err.message}`);
    }
    if (n < 0) break; // truncated final frame: wait for the next scan
    const frame = data.subarray(off, off + n);
    off += n;
    if ((frame.readUInt32LE(0) & 0xfffffff0) === 0x184d2a50) continue;
    let chunk;
    try {
      chunk = zlib.zstdDecompressSync(frame);
    } catch (err) {
      if (out.length) break;
      throw new Error(`not a valid zstd session: ${err.message}`);
    }
    out.push(chunk);
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('DeepSeek Harness session is too large');
  }
  return Buffer.concat(out);
}

/** Complete JSONL lines only: a line without its newline is still being written. */
function readRecords(file) {
  let data = fs.readFileSync(file);
  if (file.endsWith('.zstd')) data = decompress(data);
  const lines = data.toString('utf8').split('\n');
  lines.pop();
  const rows = [];
  for (const raw of lines) {
    const line = U.strip(raw);
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (U.isObj(row)) rows.push(row);
    } catch {
      // partial or foreign line
    }
  }
  return rows;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!U.isObj(p)) continue;
    parts.push(typeof p.text === 'string' ? p.text : `[${'type' in p ? U.pyStr(p.type) : 'block'}]`);
  }
  return parts.filter((x) => U.T(x)).join('\n');
}

/** [call id, text, is_error] of a tool/result message, in either shape dsh wrote. */
function resultOf(message) {
  let callId = U.or(message.toolCallId, U.or(message.source, {}).callId ?? null);
  let isError = Boolean(message.isError);
  const texts = [];
  for (const part of U.or(message.content, [])) {
    if (!U.isObj(part)) continue;
    if (part.type === 'tool-result') {
      callId = U.or(callId, part.toolCallId ?? null);
      isError = isError || Boolean(part.isError);
      texts.push(textOf(part.content));
    } else texts.push(textOf([part]));
  }
  return [callId ?? null, texts.filter((t) => U.T(t)).join('\n'), isError];
}

function parse(file) {
  const stat = fs.statSync(file);
  const meta = M.meta({ id: path.basename(path.dirname(file)), agent: AGENT, path: file, size_bytes: stat.size, fidelity: 'exact' });
  const ps = M.session(meta);

  let turn = 0;
  let firstPrompt = '';
  let title = '';
  let window = null;
  const modelsSeen = [];
  const seenIds = new Set();
  const search = new M.SearchText();
  let lastInputMs = null;
  const stepStartMs = new Map();
  const callMs = new Map();
  const callStep = new Map();
  let systemText = '';
  let toolsSchema = [];
  let lastMs = null;

  const add = (kind, ms, text = '', kw = {}) => {
    const ev = M.event({ idx: ps.events.length, kind, ts: U.isoOfMs(ms), turn, text: M.clip(text), ...kw });
    ps.events.push(ev);
    return ev;
  };

  for (const r of readRecords(file)) {
    const t = r.type;
    const d = U.isObj(r.data) ? r.data : {};
    const ms = r.time;
    if ((t === 'session' || t === 'header') && 'id' in r) {
      meta.id = U.or(U.pyStr(r.id), meta.id);
      meta.project = U.or(r.cwd, meta.project);
      meta.started_at = U.or(U.isoOfMs(r.createdAt), meta.started_at);
      if (r.version !== null && r.version !== undefined) meta.version = `v${U.pyStr(r.version)}`;
      continue;
    }
    if (typeof ms === 'number') {
      lastMs = ms;
      meta.started_at = U.or(meta.started_at, U.isoOfMs(ms));
    }
    const op = r.surfaceOp;
    const replacement = U.isObj(op) && op.op === 'replace';

    if (t === 'request/context') window = U.or(d.contextWindow, window);
    else if (t === 'request/header') {
      const header = U.or(d.header, {});
      if (typeof header.system === 'string' && header.system) systemText = header.system;
      if (Array.isArray(header.tools) && header.tools.length) toolsSchema = header.tools;
    } else if (t === 'session/title') title = U.pyStr(U.or(d.title, title));
    else if (t === 'step/start') stepStartMs.set(d.step ?? null, ms);
    else if (t === 'user/message') {
      if (replacement) {
        add(K.COMPACTION, ms, textOf(d.content), { label: 'summary' });
        continue;
      }
      const mid = d.id;
      if (U.T(mid)) {
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);
      }
      const text = textOf(d.content);
      if (!U.strip(text)) continue;
      const source = U.or(d.source, {});
      if (source.kind !== null && source.kind !== undefined && source.kind !== 'user') {
        add(K.CONTEXT, ms, text, { label: U.pyStr(U.or(source.plugin, source.kind)) });
      } else {
        turn += 1;
        firstPrompt = U.or(firstPrompt, text);
        search.add(text);
        add(K.USER, ms, text);
      }
      lastInputMs = ms;
    } else if (t === 'assistant/message') {
      if (replacement) continue;
      const msg = U.or(d.message, {});
      const mid = U.get(msg, 'id', null);
      if (U.T(mid)) {
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);
      }
      const model = U.or(U.or(msg.source, {}).model, 'unknown');
      const first = ps.events.length;
      const created = [];
      for (const part of U.or(msg.content, [])) {
        if (!U.isObj(part)) continue;
        const pt = part.type;
        if (pt === 'text' && typeof part.text === 'string' && U.strip(part.text)) {
          search.add(part.text);
          created.push(add(K.ASSISTANT, ms, part.text));
        } else if (pt === 'reasoning' || pt === 'thinking') {
          created.push(add(K.THINKING, ms, U.pyStr(U.or(part.text, U.or(part.thinking, '')))));
        } else if (pt === 'tool-call') {
          created.push(add(K.TOOL_CALL, ms, '', { tool_name: U.get(part, 'name', null), tool_input: U.maybeJson(part.arguments) ?? null, tool_use_id: U.get(part, 'id', null) }));
        }
      }
      const usage = U.or(d.usage, {});
      if (U.T(usage)) {
        const start = U.or(stepStartMs.get(d.step ?? null), lastInputMs);
        const step = M.step({
          index: ps.steps.length,
          turn,
          model,
          ts: U.isoOfMs(start),
          end_ts: U.isoOfMs(ms),
          msg_id: mid,
          input_tokens: U.toInt(U.or(usage.inputTokens, 0)), // dsh reports uncached input
          output_tokens: U.toInt(U.or(usage.outputTokens, 0)),
          cache_read_tokens: U.toInt(U.or(usage.cacheReadTokens, 0)),
          cache_write_tokens: U.toInt(U.or(usage.cacheWriteTokens, 0)),
          request_ts: U.isoOfMs(lastInputMs),
          first_event: first,
          system_key: AGENT,
          context_window: U.T(window) ? U.toInt(window) : null,
        });
        step.model_ms = U.msBetween(start, ms);
        ps.steps.push(step);
        for (const ev of created) {
          ev.step = step.index;
          ev.model = model;
          if (ev.kind === K.TOOL_CALL && U.T(ev.tool_use_id)) callStep.set(ev.tool_use_id, step);
        }
        if (!modelsSeen.includes(model)) modelsSeen.push(model);
      }
    } else if (t === 'tool/call') {
      if (U.T(d.callId)) callMs.set(d.callId, ms);
    } else if (t === 'tool/result') {
      if (replacement) continue;
      const [callId, text, isError] = resultOf(U.or(d.message, {}));
      add(K.TOOL_RESULT, ms, text, { tool_use_id: callId, is_error: isError });
      lastInputMs = ms;
      const st = callStep.get(callId || '');
      const took = U.msBetween(callMs.get(callId || ''), ms);
      if (st && took !== null) st.tools_ms = Math.max(st.tools_ms || 0, took);
    }
  }

  meta.ended_at = U.or(U.isoOfMs(lastMs), meta.started_at);
  ps.shapes.set(AGENT, { system: systemText ? [{ type: 'text', text: systemText }] : [], tools: toolsSchema });
  M.finish(ps, {
    turn,
    models: modelsSeen,
    costOf: (st) => usageCost(st.model, M.usage(st)),
    title: U.or(U.firstLineOf(U.or(title, firstPrompt)), meta.id),
  });
  ps.search_text = search.toString();
  return ps;
}

module.exports = { AGENT, root, desktopRoot, discover, parse, decompress };
