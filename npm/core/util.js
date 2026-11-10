'use strict';
// Small helpers that make the Node port behave like the Python original (src/loopprism):
// Python truthiness, code-point string lengths, json.dumps formatting, round-half-even.
// The parity test (npm/test/parity) compares both implementations on the same sessions.
const fs = require('fs');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Python truthiness: empty strings, lists and dicts, 0, null and undefined are false. */
function T(v) {
  if (Array.isArray(v) || typeof v === 'string') return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python's `a or b`. */
const or = (a, b) => (T(a) ? a : b);

/** Python's int(): truncates, 0 when it is not a number (Python would raise). */
function toInt(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

const get = (o, k, dflt = undefined) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : dflt);

/** Python's str() of a scalar. */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return pyDumps(v);
}

// ------------------------------------------------------------------ code points
const SURROGATE = /[\uD800-\uDFFF]/;

/** len() of a Python str: code points, not UTF-16 units. */
function cpLen(s) {
  if (!SURROGATE.test(s)) return s.length;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** s[:n] of a Python str. */
function cpSlice(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, n + 1);
  if (!SURROGATE.test(head)) return s.slice(0, n);
  let units = 0;
  for (let k = 0; k < n && units < s.length; k++) {
    const c = s.charCodeAt(units);
    units += c >= 0xd800 && c <= 0xdbff && units + 1 < s.length ? 2 : 1;
  }
  return s.slice(0, units);
}

// Python's str.isspace() set, for strip().
const WS = ' \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0            \u2028\u2029  　';
function strip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && WS.includes(s[a])) a++;
  while (b > a && WS.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
function lstrip(s) {
  let a = 0;
  while (a < s.length && WS.includes(s[a])) a++;
  return s.slice(a);
}

// The line boundaries of Python's str.splitlines().
const LINE_BREAKS = new RegExp('\\r\\n|[\\n\\r\\x0b\\x0c\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');

/** str.splitlines()[0] of a non-empty stripped string. */
function firstLine(s) {
  return s.split(LINE_BREAKS)[0];
}

/** `(text.strip().splitlines()[0] if text.strip() else "")`. */
function firstLineOf(text) {
  const s = strip(text || '');
  return s ? firstLine(s) : '';
}

// ------------------------------------------------------------------ json.dumps
function escapeString(s, ensureAscii) {
  let out = JSON.stringify(s);
  if (ensureAscii) {
    out = out.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  return out;
}

/**
 * Python's json.dumps: `sep` is [item, key] separators (default ", " and ": "),
 * `sortKeys`, `ensureAscii` (default true), `indent`.
 */
function pyDumps(value, { sep = [', ', ': '], sortKeys = false, ensureAscii = true, indent = null } = {}) {
  const [itemSep, keySep] = indent != null ? [',', ': '] : sep;
  const walk = (v, depth) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return 'NaN';
      if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
      return String(v);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return escapeString(v, ensureAscii);
    const nl = indent != null ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
    const close = indent != null ? '\n' + ' '.repeat(indent * depth) : '';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[' + nl + v.map((x) => walk(x, depth + 1)).join(itemSep + nl) + close + ']';
    }
    if (typeof v === 'object') {
      let keys = Object.keys(v);
      if (!keys.length) return '{}';
      if (sortKeys) keys = keys.sort();
      return '{' + nl + keys.map((k) => escapeString(k, ensureAscii) + keySep + walk(v[k], depth + 1)).join(itemSep + nl) + close + '}';
    }
    return escapeString(String(v), ensureAscii);
  };
  return walk(value, 0);
}

// ------------------------------------------------------------------ numbers
/** Python's round(): half to even for ndigits 0, the exact decimal value otherwise. */
function pyRound(x, nd = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  if (nd === 0) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  if (Math.abs(x) >= 1e21) return x;
  return Number(x.toFixed(nd));
}

/** Python's sum() of floats, which (since 3.12) uses Neumaier compensated summation. */
function sum(xs) {
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return Number.isFinite(c) ? s + c : s;
}

// ------------------------------------------------------------------ time
/** Milliseconds between two ISO timestamps, never negative; null when either is missing or bad. */
function isoMs(a, b) {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.max(0, db - da);
}

/** Epoch milliseconds to "YYYY-MM-DDTHH:MM:SS.mmmZ" (Python adapters' _iso). */
function isoOfMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  try {
    return new Date(Math.trunc(ms)).toISOString();
  } catch {
    return null;
  }
}

function msBetween(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.max(0, b - a) : null;
}

// ------------------------------------------------------------------ files
/** Lines of a JSONL file as objects (bad lines skipped), without one huge string. */
function readRows(path) {
  const buf = fs.readFileSync(path);
  const rows = [];
  let start = 0;
  const push = (end) => {
    if (end <= start) return;
    const line = strip(buf.toString('utf8', start, end));
    if (!line) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (isObj(row)) rows.push(row);
  };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x0a || c === 0x0d) {
      push(i);
      start = i + 1;
    }
  }
  push(buf.length);
  return rows;
}

/** json.loads of a string, else the value itself. */
function maybeJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function bisectLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

module.exports = {
  isObj, T, or, toInt, get, pyStr, cpLen, cpSlice, strip, lstrip, firstLine, firstLineOf,
  pyDumps, pyRound, sum, isoMs, isoOfMs, msBetween, readRows, maybeJson, bisectLeft,
};
