'use strict';
// Codex: register LoopPrism's hook in ~/.codex/hooks.json (merged, idempotent)
// and keep a copy of the hook scripts under ~/.loopprism/hooks.
const fs = require('fs');
const path = require('path');
const { packageRoot, stableDirs, codexHome } = require('./paths');
const { atomicWrite, backupOnce } = require('./fsutil');

const MARKER = path.join('.loopprism', 'hooks', 'hook.js');
// `message` is the hook's `statusMessage`: the only human-readable label Codex has for a command
// hook (there is no name field), shown where the hook is listed and while it runs. Without it Codex
// can only number the hooks.
const WANTED = [
  { event: 'SessionStart', async: true, message: 'LoopPrism: session started' },
  { event: 'UserPromptSubmit', async: true, message: 'LoopPrism: recording prompt' },
  { event: 'PostToolUse', async: true, message: 'LoopPrism: recording tool call' },
  { event: 'Stop', async: true, message: 'LoopPrism: recording end of turn' },
  { event: 'SessionEnd', async: false, timeout: 2, message: 'LoopPrism: session ended' },
];

const isOurs = (handler) =>
  typeof handler.command === 'string' && handler.command.includes(MARKER);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${err.message}. Fix or remove it, then retry.`);
  }
}

/** Remove our handlers (and any groups/events left empty). Mutates and returns config. */
function stripOurs(config) {
  const hooks = config.hooks || {};
  for (const [event, groups] of Object.entries(hooks)) {
    hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  config.hooks = hooks;
  return config;
}

function addOurs(config, hookJs) {
  const command = `node "${hookJs}" --agent codex`;
  for (const w of WANTED) {
    const handler = { type: 'command', command, statusMessage: w.message };
    if (w.async) handler.async = true;
    if (w.timeout) handler.timeout = w.timeout;
    (config.hooks[w.event] ||= []).push({ hooks: [handler] });
  }
  return config;
}

function install({ home, env = process.env } = {}) {
  const dirs = stableDirs(home);
  fs.rmSync(dirs.hooks, { recursive: true, force: true });
  fs.cpSync(path.join(packageRoot, 'plugin', 'scripts'), dirs.hooks, { recursive: true });

  const file = path.join(codexHome(env, home), 'hooks.json');
  const config = stripOurs(readJson(file));
  addOurs(config, path.join(dirs.hooks, 'hook.js'));
  backupOnce(file); // the user's own file: keep how it was before we first touched it
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, hookScript: path.join(dirs.hooks, 'hook.js') };
}

function uninstall({ home, env = process.env } = {}) {
  const file = path.join(codexHome(env, home), 'hooks.json');
  if (fs.existsSync(file)) {
    atomicWrite(file, `${JSON.stringify(stripOurs(readJson(file)), null, 2)}\n`);
  }
  // The scripts are shared with the other apps' hooks: keep them while one still uses them.
  const shared = require('./shared').hooksInUse('codex', { home, env });
  if (!shared) fs.rmSync(stableDirs(home).hooks, { recursive: true, force: true });
  return { file };
}

function isInstalled({ home, env = process.env } = {}) {
  const config = readJson(path.join(codexHome(env, home), 'hooks.json'));
  return Object.values(config.hooks || {}).some((groups) =>
    groups.some((g) => (g.hooks || []).some(isOurs)),
  );
}

/**
 * Is LoopPrism installed as a Codex plugin (`codex plugin add loopprism@...`)? Codex lists it in
 * config.toml as [plugins."loopprism@<marketplace>"] with enabled = true (the default when absent).
 * The plugin already carries the skill, the MCP server and the hooks: adding ours as well would
 * register every one of them twice (and send each event twice).
 */
function pluginEnabled({ home, env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(path.join(codexHome(env, home), 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  let inPlugin = false;
  let enabled = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (section) {
      inPlugin = /^plugins\.["']loopprism@[^"']+["']$/.test(section[1]);
      if (inPlugin) enabled = true;
    } else if (inPlugin && /^\s*enabled\s*=\s*false\b/.test(line)) enabled = false;
  }
  return enabled;
}

module.exports = { install, uninstall, isInstalled, pluginEnabled, stripOurs, addOurs, MARKER };
