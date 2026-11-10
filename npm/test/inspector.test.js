'use strict';
// `lpa install`: the skill and the MCP server in Codex, Gemini CLI, OpenCode and Cursor, next to
// the user's own configuration, idempotent, and removed without touching anything else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inspector = require('../lib/inspector');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lpa-insp-'));
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function setup() {
  const home = tmp();
  const env = {};
  put(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-6.1-sol"',
    '',
    '[mcp_servers.loopprism]',
    'command = "old"',
    '',
    '[mcp_servers.loopprism.env]',
    'X = "1"',
    '',
    '[mcp_servers.github]',
    'command = "gh-mcp"',
    '',
  ].join('\n'));
  put(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
  put(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { mine: { type: 'remote', url: 'https://x' } } }));
  put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'y' } } }));
  return { home, env };
}

test('install gives every agent the skill and the MCP server, keeping their other settings', () => {
  const opts = setup();
  const { home } = opts;
  const l = inspector.installApp(opts);
  assert.equal(fs.realpathSync(l.command), fs.realpathSync(process.execPath));
  assert.ok(fs.existsSync(path.join(home, '.loopprism', 'app', 'core', 'mcp.js')));

  for (let i = 0; i < 2; i++) for (const a of ['codex', 'gemini', 'opencode', 'cursor']) inspector.install(a, opts);
  const lpa = path.join(home, '.loopprism', 'app', 'bin', 'lpa.js');

  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal(toml.match(/\[mcp_servers\.loopprism\]/g).length, 1, 'replaced, not duplicated');
  assert.ok(!toml.includes('command = "old"') && !toml.includes('[mcp_servers.loopprism.env]'));
  assert.ok(toml.includes('model = "gpt-6.1-sol"') && toml.includes('[mcp_servers.github]\ncommand = "gh-mcp"'));
  assert.ok(toml.includes(`args = [${JSON.stringify(lpa)}, "mcp"]`));

  const g = json(path.join(home, '.gemini', 'settings.json'));
  assert.equal(g.theme, 'dark');
  assert.deepEqual(Object.keys(g.mcpServers), ['other', 'loopprism']);
  assert.deepEqual(g.mcpServers.loopprism, { command: l.command, args: [lpa, "mcp"] });

  const oc = json(path.join(home, '.config', 'opencode', 'opencode.json'));
  assert.deepEqual(oc.mcp.loopprism, { type: 'local', command: [l.command, lpa, "mcp"], enabled: true });
  assert.equal(oc.mcp.mine.type, 'remote');

  assert.deepEqual(Object.keys(json(path.join(home, '.cursor', 'mcp.json')).mcpServers), ['other', 'loopprism']);

  for (const dir of [['.codex', 'skills'], ['.gemini', 'skills'], ['.config', 'opencode', 'skills'], ['.cursor', 'skills']]) {
    const skill = fs.readFileSync(path.join(home, ...dir, 'loopprism', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: loopprism\ndescription: /);
    assert.ok(skill.includes(lpa) && !skill.includes('npx -y loopprism'), dir.join('/'));
  }
  for (const a of ['codex', 'gemini', 'opencode', 'cursor']) assert.equal(inspector.isInstalled(a, opts), true);

  for (const a of ['codex', 'gemini', 'opencode', 'cursor']) inspector.uninstall(a, opts);
  const after = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(!after.includes('loopprism') && after.includes('[mcp_servers.github]'));
  assert.deepEqual(json(path.join(home, '.gemini', 'settings.json')), { theme: 'dark', mcpServers: { other: { command: 'x' } } });
  assert.deepEqual(Object.keys(json(path.join(home, '.config', 'opencode', 'opencode.json')).mcp), ['mine']);
  assert.ok(!fs.existsSync(path.join(home, '.cursor', 'skills', 'loopprism')));
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'settings.json.loopprism.bak')), 'the original is kept');
  assert.equal(inspector.removeAppIfUnused(opts), true);
  assert.ok(!fs.existsSync(path.join(home, '.loopprism', 'app')));
});

test('a broken config or a skill of the user\'s own with our name is left alone', () => {
  const opts = setup();
  inspector.installApp(opts);
  put(path.join(opts.home, '.cursor', 'mcp.json'), '{ nope');
  assert.throws(() => inspector.install('cursor', opts), /Cannot parse/);
  assert.equal(fs.readFileSync(path.join(opts.home, '.cursor', 'mcp.json'), 'utf8'), '{ nope');

  put(path.join(opts.home, '.gemini', 'skills', 'loopprism', 'SKILL.md'), '---\nname: loopprism\n---\nmine');
  assert.throws(() => inspector.install('gemini', opts), /not LoopPrism's/);
  inspector.uninstall('gemini', opts);
  assert.ok(fs.existsSync(path.join(opts.home, '.gemini', 'skills', 'loopprism', 'SKILL.md')));
});

test('codex config.toml is created when missing, and an untouched file stays untouched', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex'));
  inspector.installApp({ home });
  inspector.install('codex', { home, env: {} });
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /^\[mcp_servers\.loopprism\]\ncommand = /);
  assert.equal(inspector.stripTomlServer('a = 1\n\n[x]\nb = 2\n'), 'a = 1\n\n[x]\nb = 2\n');
});

test('the installed copy runs as an MCP server', () => {
  const home = tmp();
  const l = inspector.installApp({ home });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const r = spawnSync(l.command, [...l.args, 'mcp'], {
    input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, LOOPPRISM_INDEX: path.join(home, 'idx.db') },
    timeout: 20000,
  });
  const replies = r.stdout.trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(replies[0].result.serverInfo.name, 'loopprism');
  assert.ok(replies[1].result.tools.some((t) => t.name === 'session_summary'));
  assert.equal(r.stderr, '');
});
