'use strict';
// The session inspector in every agent: the `loopprism` MCP server and the `loopprism` skill.
//
// `lpa install` copies the package to ~/.loopprism/app (it survives an npx cache clean) and points
// every agent at it with absolute paths: `<node> ~/.loopprism/app/bin/lpa.js mcp`. Using the node
// that ran the install keeps it working in GUI apps (Cursor) that do not see the shell's PATH.
//
//   agent        skill folder                    MCP server registered in
//   Codex        $CODEX_HOME/skills              $CODEX_HOME/config.toml   [mcp_servers.loopprism]
//   Gemini CLI   ~/.gemini/skills                ~/.gemini/settings.json   mcpServers.loopprism
//   OpenCode     ~/.config/opencode/skills       ~/.config/opencode/opencode.json  mcp.loopprism
//   Cursor       ~/.cursor/skills                ~/.cursor/mcp.json        mcpServers.loopprism
//   Claude Code  inside the LoopPrism plugin (lib/claude.js), with the hooks
//
// Only our own entries are ever changed or removed; the user's file is backed up the first time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packageRoot, stableDirs, codexHome } = require('./paths');
const { atomicWrite, backupOnce } = require('./fsutil');
const opencode = require('./opencode');

const NAME = 'loopprism';
const SKILL_MARKER = '<!-- loopprism-skill -->';
const APP_FILES = ['bin', 'core', 'lib', 'plugin', 'package.json'];
const NPX = 'npx -y loopprism';

const appDir = (home) => path.join(stableDirs(home).base, 'app');
const lpaPath = (home) => path.join(appDir(home), 'bin', 'lpa.js');

/** Copy the package to ~/.loopprism/app; returns how to run it. */
function installApp({ home } = {}) {
  const dir = appDir(home);
  const next = `${dir}.new`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true });
  for (const f of APP_FILES) fs.cpSync(path.join(packageRoot, f), path.join(next, f), { recursive: true });
  // The dashboard for `lpa ui`: shipped in the published package, or the repository's own build.
  const dist = require('../core/server').dashboardDir(packageRoot);
  if (dist) fs.cpSync(dist, path.join(next, 'dashboard'), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(next, dir);
  return launcher({ home });
}

function launcher({ home } = {}) {
  return { command: stableNode(), args: [lpaPath(home)] };
}

/**
 * The node running us, by a path that survives upgrades: process.execPath is the resolved binary
 * (Homebrew: .../Cellar/node/<version>/bin/node, gone after `brew upgrade`), so prefer the link on
 * PATH (/opt/homebrew/bin/node) when it is the same program.
 */
function stableNode(env = process.env) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = real(process.execPath);
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir || dir.includes('_npx') || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, exe);
    if (candidate !== process.execPath && real(candidate) === self) return candidate;
  }
  return process.execPath;
}

/** `"<node>" "<lpa.js>"`, for the skill's shell examples. */
function shellCommand(l) {
  const q = (s) => (/[\s"'$`\\]/.test(s) || process.platform === 'win32' ? `"${s}"` : s);
  return [l.command, ...l.args].map(q).join(' ');
}

/** The skill text with `npx -y loopprism` replaced by the installed copy. */
function skillText(l) {
  // LF line ends whatever the checkout did (git on Windows may hand us CRLF).
  const src = fs.readFileSync(path.join(packageRoot, 'plugin', 'skills', NAME, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  return src.split(NPX).join(shellCommand(l));
}

function mcpServer(l) {
  return { command: l.command, args: [...l.args, 'mcp'] };
}

// ------------------------------------------------------------------ files
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Cannot parse ${file}: ${err.message}. Fix it (or add LoopPrism by hand), then retry.`);
  }
}

function writeJson(file, value) {
  backupOnce(file);
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(dir, l) {
  const target = path.join(dir, NAME);
  const file = path.join(target, 'SKILL.md');
  if (fs.existsSync(file) && !isOurSkill(file)) {
    throw new Error(`${file} exists and is not LoopPrism's. Rename or remove it, then retry.`);
  }
  fs.mkdirSync(target, { recursive: true });
  atomicWrite(file, skillText(l));
  return file;
}

function isOurSkill(file) {
  try {
    return fs.readFileSync(file, 'utf8').includes(SKILL_MARKER);
  } catch {
    return false;
  }
}

function removeSkill(dir) {
  const target = path.join(dir, NAME);
  if (isOurSkill(path.join(target, 'SKILL.md'))) fs.rmSync(target, { recursive: true, force: true });
}

/** Set (or with `server` null, remove) key `name` of the object at `keyPath` in a JSON file. */
function setJsonEntry(file, keyPath, server) {
  const config = readJson(file);
  let obj = config;
  for (const k of keyPath) {
    if (!obj[k] || typeof obj[k] !== 'object' || Array.isArray(obj[k])) {
      if (!server) return false;
      obj[k] = {};
    }
    obj = obj[k];
  }
  if (!server && !(NAME in obj)) return false;
  if (server) obj[NAME] = server;
  else delete obj[NAME];
  writeJson(file, config);
  return true;
}

function hasJsonEntry(file, keyPath) {
  let obj;
  try {
    obj = readJson(file);
  } catch {
    return false;
  }
  for (const k of keyPath) obj = obj && typeof obj === 'object' ? obj[k] : undefined;
  return Boolean(obj && typeof obj === 'object' && obj[NAME]);
}

// ------------------------------------------------------------------ TOML (Codex)
const SECTION = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const isOurSection = (name) => name === `mcp_servers.${NAME}` || name.startsWith(`mcp_servers.${NAME}.`);

/** Remove `[mcp_servers.loopprism]` (and its sub-tables) from a config.toml text. */
function stripTomlServer(text) {
  const out = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(SECTION);
    if (m) skip = isOurSection(m[1].replace(/["']/g, ''));
    if (!skip) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.length ? `${out.join('\n')}\n` : '';
}

function tomlServer(server) {
  const s = (v) => JSON.stringify(v); // a TOML basic string accepts JSON's escapes
  return `[mcp_servers.${NAME}]\ncommand = ${s(server.command)}\nargs = [${server.args.map(s).join(', ')}]\n`;
}

// ------------------------------------------------------------------ agents
const exists = (p) => fs.existsSync(p);

const AGENTS = {
  codex: {
    label: 'Codex',
    available: ({ home, env }) => exists(codexHome(env, home)),
    skills: ({ home, env }) => path.join(codexHome(env, home), 'skills'),
    configFile: ({ home, env }) => path.join(codexHome(env, home), 'config.toml'),
    setMcp(opts, server) {
      const file = this.configFile(opts);
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const stripped = stripTomlServer(text);
      if (!server && stripped === text) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      backupOnce(file);
      atomicWrite(file, server ? `${stripped}${stripped ? '\n' : ''}${tomlServer(server)}` : stripped);
    },
    hasMcp(opts) {
      try {
        return fs.readFileSync(this.configFile(opts), 'utf8').split(/\r?\n/).some((l) => {
          const m = l.match(SECTION);
          return m && isOurSection(m[1].replace(/["']/g, ''));
        });
      } catch {
        return false;
      }
    },
    restart: 'Restart Codex.',
  },
  gemini: {
    label: 'Gemini CLI',
    home: ({ home, env }) => path.join(env.GEMINI_CLI_HOME || home, '.gemini'),
    available(opts) {
      return exists(this.home(opts));
    },
    skills(opts) {
      return path.join(this.home(opts), 'skills');
    },
    setMcp(opts, server) {
      setJsonEntry(path.join(this.home(opts), 'settings.json'), ['mcpServers'], server);
    },
    hasMcp(opts) {
      return hasJsonEntry(path.join(this.home(opts), 'settings.json'), ['mcpServers']);
    },
    restart: 'Restart Gemini CLI.',
  },
  opencode: {
    label: 'OpenCode',
    available: ({ home, env }) => opencode.available({ home, env }),
    skills: ({ home, env }) => path.join(opencode.configDir(env, home), 'skills'),
    configFile({ home, env }) {
      const dir = opencode.configDir(env, home);
      const jsonc = path.join(dir, 'opencode.jsonc');
      const json = path.join(dir, 'opencode.json');
      return !exists(json) && exists(jsonc) ? jsonc : json;
    },
    setMcp(opts, server) {
      setJsonEntry(this.configFile(opts), ['mcp'], server && { type: 'local', command: [server.command, ...server.args], enabled: true });
    },
    hasMcp(opts) {
      return hasJsonEntry(this.configFile(opts), ['mcp']);
    },
    restart: 'Restart OpenCode.',
  },
  cursor: {
    label: 'Cursor',
    home: ({ home }) => path.join(home, '.cursor'),
    available(opts) {
      return require('./cursor').available(opts);
    },
    skills(opts) {
      return path.join(this.home(opts), 'skills');
    },
    setMcp(opts, server) {
      setJsonEntry(path.join(this.home(opts), 'mcp.json'), ['mcpServers'], server);
    },
    hasMcp(opts) {
      return hasJsonEntry(path.join(this.home(opts), 'mcp.json'), ['mcpServers']);
    },
    restart: 'Cursor picks up new MCP servers in Settings → MCP; restart it if LoopPrism is not listed.',
  },
};

const norm = ({ home = os.homedir(), env = process.env } = {}) => ({ home, env });

/** Install the skill and the MCP server for one agent (the app copy must be in place). */
function install(agent, opts = {}) {
  const a = AGENTS[agent];
  const o = norm(opts);
  const l = launcher(o);
  const skill = writeSkill(a.skills(o), l);
  a.setMcp(o, mcpServer(l));
  return { skill };
}

function uninstall(agent, opts = {}) {
  const a = AGENTS[agent];
  const o = norm(opts);
  removeSkill(a.skills(o));
  a.setMcp(o, null);
}

function isInstalled(agent, opts = {}) {
  const a = AGENTS[agent];
  const o = norm(opts);
  return isOurSkill(path.join(a.skills(o), NAME, 'SKILL.md')) || a.hasMcp(o);
}

function available(agent, opts = {}) {
  return AGENTS[agent].available(norm(opts));
}

/** The app copy is needed while any agent (or the Claude Code plugin) still points at it. */
function removeAppIfUnused(opts = {}, { claudeInstalled = false } = {}) {
  if (claudeInstalled || Object.keys(AGENTS).some((a) => isInstalled(a, opts))) return false;
  fs.rmSync(appDir(norm(opts).home), { recursive: true, force: true });
  return true;
}

module.exports = {
  AGENTS, NAME, SKILL_MARKER, installApp, launcher, skillText, mcpServer, shellCommand,
  install, uninstall, isInstalled, available, removeAppIfUnused, stripTomlServer, appDir,
};
