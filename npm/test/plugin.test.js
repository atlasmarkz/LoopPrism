'use strict';
// The plugin ships from four manifests that must agree with package.json, and its MCP
// launcher must pin the exact package version (Anthropic's plugin directory blocks
// `npx loopprism` / `@latest`). Bump all of them together when releasing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const json = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));
const version = json('package.json').version;

test('plugin.json, both marketplace files and the MCP pin carry the package version', () => {
  assert.equal(json('plugin', '.claude-plugin', 'plugin.json').version, version);
  for (const file of [[root, '.claude-plugin', 'marketplace.json'], [root, '..', '.claude-plugin', 'marketplace.json']]) {
    const entry = JSON.parse(fs.readFileSync(path.join(...file), 'utf8')).plugins.find((p) => p.name === 'loopprism');
    assert.equal(entry.version, version, file.join('/'));
  }
  const mcp = json('plugin', '.mcp.json').mcpServers.loopprism;
  assert.deepEqual(mcp.args, ['-y', `loopprism@${version}`, 'mcp']);
});

test('the marketplace files point at the plugin folder from where each is the marketplace root', () => {
  const entry = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8')).plugins[0];
  const inNpm = path.join(root, entry(root, '.claude-plugin', 'marketplace.json').source);
  const atRoot = path.join(root, '..', entry(root, '..', '.claude-plugin', 'marketplace.json').source);
  for (const dir of [inNpm, atRoot]) assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')), dir);
});

test('plugin.json icon exists and every hook command runs through ${CLAUDE_PLUGIN_ROOT}', () => {
  const manifest = json('plugin', '.claude-plugin', 'plugin.json');
  assert.ok(fs.existsSync(path.join(root, 'plugin', manifest.icon)));
  const hooks = json('plugin', 'hooks', 'hooks.json').hooks;
  for (const groups of Object.values(hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  }
});
