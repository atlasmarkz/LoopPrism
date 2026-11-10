'use strict';
// node:sqlite (Node >= 22.13), loaded lazily so that agents without a database never touch it,
// and without its ExperimentalWarning on older Node versions.
let mod = null;

function sqlite() {
  if (mod) return mod;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' || (w && w.name === 'ExperimentalWarning')) return;
    return emit.call(process, w, ...rest);
  };
  try {
    mod = require('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
  return mod;
}

/** A read-only connection to another app's database. */
function openReadOnly(file) {
  const { DatabaseSync } = sqlite();
  return new DatabaseSync(file, { readOnly: true, timeout: 2000 });
}

const decoder = new TextDecoder('utf-8');

/** Text of a column that may come back as a BLOB. */
function text(value) {
  if (value instanceof Uint8Array) return decoder.decode(value);
  return value;
}

module.exports = { sqlite, openReadOnly, text };
