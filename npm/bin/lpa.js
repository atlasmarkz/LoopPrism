#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const claude = require('../lib/claude');
const { atomicWrite } = require('../lib/fsutil');
const codex = require('../lib/codex');
const workbuddy = require('../lib/workbuddy');
const opencode = require('../lib/opencode');
const dsh = require('../lib/dsh');
const gemini = require('../lib/gemini');
const cursor = require('../lib/cursor');
const inspector = require('../lib/inspector');
const { configPath } = require('../plugin/scripts/config');
const viewer = require('../plugin/scripts/viewer');
const { version } = require('../package.json');

const AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'workbuddy', 'dsh'];
const HOOKS = { codex, gemini, opencode, cursor, workbuddy, dsh };
const LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', cursor: 'Cursor', workbuddy: 'WorkBuddy', dsh: 'DeepSeek Harness' };

const HELP = `lpa ${version}: see what your coding agents did

Set up (one command, every agent found on this machine)
  npx loopprism install [${AGENTS.join('|')}|all] [--live] [--url <api-url>]
      Gives each agent the LoopPrism skill and MCP server, so you can ask it
      "review this session" or "what did my agents cost this week?".
      --live also adds hooks that stream each step to the LoopPrism app (on by
      default when the app is installed; --no-live to skip them).
  npx loopprism uninstall [agent|all]      remove everything LoopPrism added
  lpa status / lpa open                    the LoopPrism app: latest live runs, open it`;

function parse(argv) {
  const out = { command: argv[0], targets: [], url: null, live: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--url') out.url = argv[++i];
    else if (argv[i] === '--live') out.live = true;
    else if (argv[i] === '--no-live') out.live = false;
    else out.targets.push(argv[i]);
  }
  return out;
}

function pick(targets) {
  const unknown = targets.filter((t) => t !== 'all' && !AGENTS.includes(t));
  if (unknown.length) throw new Error(`Unknown agent: ${unknown.join(', ')}. One of: ${AGENTS.join(', ')}, all`);
  const all = !targets.length || targets.includes('all');
  return { list: all ? AGENTS : AGENTS.filter((a) => targets.includes(a)), explicit: !all };
}

function saveUrl(url) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify({ url }, null, 2)}\n`);
}

const tryOr = (fn, dflt) => {
  try {
    return fn();
  } catch {
    return dflt;
  }
};

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major < 22 || (major === 22 && minor < 15);
}

function present(agent) {
  switch (agent) {
    case 'claude':
      return claude.available();
    case 'workbuddy':
      return workbuddy.available();
    case 'dsh':
      return dsh.available();
    default:
      return inspector.available(agent);
  }
}

/** Live hooks: asked for, or the app is here, or they were installed before (keep them current). */
function wantLive(flag, url) {
  if (flag !== null) return flag;
  if (url || viewer.desktopApp()) return true;
  return Object.values(HOOKS).some((m) => tryOr(() => m.isInstalled({}), false));
}

function install({ targets, url, live: liveFlag }) {
  if (nodeTooOld()) {
    console.error(`LoopPrism needs Node.js 22.15 or newer (this is ${process.versions.node}). Update Node, then run this again.`);
    return 1;
  }
  const { list, explicit } = pick(targets);
  if (url) saveUrl(url);
  const live = wantLive(liveFlag, url);
  inspector.installApp();

  const rows = [];
  let failed = false;
  for (const agent of list) {
    const label = LABEL[agent];
    if (!present(agent)) {
      if (explicit) {
        rows.push(`  ✗ ${label.padEnd(17)} not found on this machine`);
        failed = true;
      }
      continue;
    }
    try {
      const parts = [];
      let next = '';
      if (agent === 'claude') {
        claude.install();
        parts.push('skill', 'MCP', 'live hooks', '/loopprism:status');
        next = 'Restart Claude Code.';
      } else if (agent === 'workbuddy' || agent === 'dsh') {
        if (!live) {
          rows.push(`  · ${label.padEnd(17)} its sessions are read; no skill/MCP support (--live adds hooks for the app)`);
          continue;
        }
        const r = HOOKS[agent].install();
        parts.push('live hooks');
        next = agent === 'dsh' ? `In DSH Desktop, install dsh-hooks-claude-code with configPath ${r.file}.` : 'Restart WorkBuddy.';
      } else {
        inspector.install(agent);
        parts.push('skill', 'MCP');
        if (live) {
          HOOKS[agent].install();
          parts.push('live hooks');
        }
        next = inspector.AGENTS[agent].restart;
        if (agent === 'codex' && live) next += ' Run /hooks once to trust the hooks.';
      }
      rows.push(`  ✓ ${label.padEnd(17)} ${parts.join(' + ')}. ${next}`);
    } catch (err) {
      rows.push(`  ✗ ${label.padEnd(17)} ${err.message.split('\n')[0]}`);
      failed = true;
    }
  }

  if (!rows.length) {
    console.log('No coding agent found (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, WorkBuddy, DeepSeek Harness).');
    console.log('Install one, run it once, then run `npx loopprism install` again.');
    return 1;
  }
  console.log(`LoopPrism ${version} is set up:\n${rows.join('\n')}`);
  console.log(`
Then just ask your agent, for example:
  "Use LoopPrism to review this session: what did it cost and where did the tokens go?"
  "What did my coding agents cost this week, and how could I spend less?"

Or from a terminal: lpa show · lpa cost · lpa optimize (lpa = ${inspector.shellCommand(inspector.launcher())})`);
  return failed ? 1 : 0;
}

function uninstall({ targets }) {
  const { list } = pick(targets);
  for (const agent of list) {
    if (agent === 'claude') {
      if (tryOr(() => claude.available(), false)) tryOr(() => claude.uninstall(), null);
      continue;
    }
    if (inspector.AGENTS[agent]) tryOr(() => inspector.uninstall(agent), null);
    tryOr(() => HOOKS[agent].uninstall(), null);
  }
  const claudeLeft = !list.includes('claude') && tryOr(() => claude.isInstalled(), false);
  inspector.removeAppIfUnused({}, { claudeInstalled: claudeLeft });
  console.log(`LoopPrism removed from ${list.map((a) => LABEL[a]).join(', ')}. Restart the agents to unload it.`);
  return 0;
}

async function main(argv) {
  if (argv[0] === 'mcp') return require('../core/mcp').serve();
  if (argv[0] === 'ui' || argv[0] === 'dashboard') return require('../core/ui').run(argv.slice(1));
  const cli = require('../core/cli');
  if (cli.COMMANDS.has(argv[0])) return cli.run(argv[0], argv.slice(1));

  const opts = parse(argv);
  if (opts.command === 'status') return viewer.status();
  if (opts.command === 'open') return viewer.open();
  if (opts.command === 'install') return install(opts);
  if (opts.command === 'uninstall') return uninstall(opts);

  console.log(`${HELP}\n\n${cli.HELP}`);
  return opts.command && !['help', '--help', '-h'].includes(opts.command) ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
