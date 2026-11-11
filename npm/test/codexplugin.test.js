'use strict';
// LoopPrism as a Codex plugin: the files Codex reads (.agents/plugins/marketplace.json at the
// repository root, .codex-plugin/plugin.json and hooks/codex-hooks.json in the plugin folder) must
// agree with each other and with the package.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

const repo = path.resolve(__dirname, '..', '..');
const plugin = path.join(repo, 'npm', 'plugin');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Events Codex runs hooks for (https://developers.openai.com/codex/hooks); PostToolUseFailure is Claude Code's.
const CODEX_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

test('Codex marketplace points at the plugin folder', () => {
  const m = json(path.join(repo, '.agents', 'plugins', 'marketplace.json'));
  assert.equal(m.plugins.length, 1);
  const entry = m.plugins[0];
  assert.equal(entry.name, 'loopprism');
  assert.equal(entry.source.source, 'local');
  assert.match(entry.source.path, /^\.\//);
  assert.ok(fs.existsSync(path.join(repo, entry.source.path, '.codex-plugin', 'plugin.json')));
  assert.ok(entry.policy.installation && entry.policy.authentication && entry.category);
});

test('Codex manifest: same name and version as the package, every path it names exists', () => {
  const m = json(path.join(plugin, '.codex-plugin', 'plugin.json'));
  assert.equal(m.name, 'loopprism');
  assert.equal(m.version, version, 'bump .codex-plugin/plugin.json with package.json');
  for (const key of ['skills', 'mcpServers', 'hooks']) {
    assert.match(m[key], /^\.\//, key);
    assert.ok(fs.existsSync(path.join(plugin, m[key])), `${key}: ${m[key]}`);
  }
  assert.notEqual(m.hooks, './hooks/hooks.json', "hooks/hooks.json is Claude Code's (--agent claude-code)");
  assert.ok(fs.existsSync(path.join(plugin, m.skills, 'loopprism', 'SKILL.md')));
});

test('Codex hooks: Codex events only, tagged as codex, scripts shipped in the plugin', () => {
  const { hooks } = json(path.join(plugin, 'hooks', 'codex-hooks.json'));
  const events = Object.keys(hooks);
  assert.deepEqual(events.sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit', 'PostToolUse'].sort());
  for (const event of events) {
    assert.ok(CODEX_EVENTS.has(event), event);
    for (const group of hooks[event]) {
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        assert.match(h.command, /--agent codex$/);
        assert.match(h.command, /\$\{PLUGIN_ROOT\}\/scripts\/hook\.js/);
      }
    }
  }
  assert.equal(hooks.SessionEnd[0].hooks[0].async, undefined, 'SessionEnd always runs synchronously');
  assert.ok(fs.existsSync(path.join(plugin, 'scripts', 'hook.js')));
});

test('Codex marketplace and the Claude Code one describe the same plugin version', () => {
  const claude = json(path.join(repo, '.claude-plugin', 'marketplace.json'));
  assert.equal(claude.plugins[0].version, version);
});
