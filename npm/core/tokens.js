'use strict';
// Cheap token estimates; real counts come from the model's reported usage (port of sessions/tokens.py).
const { pyDumps } = require('./util');

/** ~3.8 characters per token for ASCII, ~1 token per wide character (code points, like Python). */
function estimateText(text) {
  if (!text) return 0;
  let ascii = 0;
  let cps = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) ascii++;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    cps++;
  }
  return ascii / 3.8 + (cps - ascii) * 0.95;
}

function estimateJson(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateText(value);
  return estimateText(pyDumps(value, { sep: [',', ':'], ensureAscii: false }));
}

module.exports = { estimateText, estimateJson };
