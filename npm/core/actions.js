'use strict';
// Resume command and Markdown export of a session (port of the read-only half of sessions/actions.py).
const fs = require('fs');
const { K } = require('./models');
const U = require('./util');

const SAFE_ID = /^[A-Za-z0-9._-]{6,80}$/;
const AGENT_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness', workbuddy: 'WorkBuddy',
  opencode: 'OpenCode', gemini: 'Gemini CLI', cursor: 'Cursor',
};

const shQuote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The shell command that resumes a Claude Code or Codex session, including the cd; null for the others. */
function resumeCommand(meta) {
  if (meta.agent !== 'claude-code' && meta.agent !== 'codex') return null;
  const rid = meta.agent === 'claude-code' ? meta.id : String(meta.id).split('_')[0];
  if (!SAFE_ID.test(rid)) return null;
  const cmd = meta.agent === 'claude-code' ? `claude --resume ${rid}` : `codex resume ${rid}`;
  if (meta.project && isDir(meta.project)) {
    return process.platform === 'win32' ? `cd /d "${meta.project}" && ${cmd}` : `cd ${shQuote(meta.project)} && ${cmd}`;
  }
  return cmd;
}

function exportMarkdown(ps) {
  const m = ps.meta;
  const lines = [`# ${m.title}`, '', `- Agent: ${AGENT_NAMES[m.agent] || m.agent}`, `- Session: \`${m.id}\``];
  if (m.project) lines.push(`- Project: \`${m.project}\``);
  if (m.started_at) lines.push(`- Started: ${m.started_at}`);
  if (m.models.length) lines.push(`- Models: ${m.models.join(', ')}`);
  if (m.cost_usd !== null) lines.push(`- Estimated API cost: $${m.cost_usd.toFixed(2)}`);
  lines.push('');
  let turn = 0;
  for (const e of ps.events) {
    if (e.sidechain) continue;
    if (e.kind === K.USER) {
      turn += 1;
      lines.push(`## Turn ${turn}`, '', '**User**', '', U.strip(e.text), '');
    } else if (e.kind === K.ASSISTANT) {
      lines.push('**Assistant**', '', U.strip(e.text), '');
    } else if (e.kind === K.TOOL_CALL) {
      let arg = '';
      if (U.isObj(e.tool_input)) {
        const i = e.tool_input;
        arg = U.or(i.command, U.or(i.file_path, U.or(i.path, U.or(i.pattern, ''))));
      }
      lines.push(`- \`${e.tool_name}\` ${typeof arg === 'object' ? '' : arg}`.trimEnd());
    }
  }
  return U.strip(lines.join('\n')) + '\n';
}

/** Run a command in a new terminal window (macOS Terminal, a Windows console). */
function openInTerminal(command) {
  const { spawnSync, spawn } = require('child_process');
  if (process.platform === 'win32') {
    // A string (not a list) so cmd.exe sees the quotes in `cd /d "..."` as written.
    spawn(`start "" cmd.exe /k ${command}`, { shell: true, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Opening a terminal is only supported on macOS and Windows');
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r = spawnSync('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`], { timeout: 15_000 });
  if (r.status !== 0) throw new Error(`osascript failed: ${String(r.stderr || '').trim()}`);
}

function within(file, roots) {
  const path = require('path');
  return roots.filter(Boolean).some((r) => {
    let root;
    try {
      root = fs.realpathSync(r);
    } catch {
      return false;
    }
    const rel = path.relative(root, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** Move a session file (and its sibling folder) to the Trash; only inside the agents' own session folders. */
function trash(file, allowedRoots) {
  const path = require('path');
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    const err = new Error(file);
    err.code = 'ENOENT';
    throw err;
  }
  if (!within(real, allowedRoots)) {
    const err = new Error('Not inside a known session folder');
    err.code = 'EPERM';
    throw err;
  }
  if (path.extname(real) !== '.jsonl' || !fs.statSync(real).isFile()) {
    const err = new Error(real);
    err.code = 'ENOENT';
    throw err;
  }
  const sibling = real.slice(0, -'.jsonl'.length);
  const hasSibling = fs.existsSync(sibling) && fs.statSync(sibling).isDirectory();
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const script =
      'Add-Type -AssemblyName Microsoft.VisualBasic;$f=[Microsoft.VisualBasic.FileIO.FileSystem];' +
      "$p=$env:LP_RECYCLE_FILE; $d=$env:LP_RECYCLE_DIR;$f::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin');" +
      "if ($d) { $f::DeleteDirectory($d,'OnlyErrorDialogs','SendToRecycleBin') }";
    // Paths travel in the environment, never spliced into the script text.
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, LP_RECYCLE_FILE: real, LP_RECYCLE_DIR: hasSibling ? sibling : '' }, timeout: 60_000, windowsHide: true,
    });
    if (r.status !== 0) throw new Error('Could not move the session to the Recycle Bin');
    return 'Recycle Bin';
  }
  if (process.platform !== 'darwin') throw new Error('Moving sessions to the Trash is supported on macOS and Windows');
  const trashDir = path.join(require('os').homedir(), '.Trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const unique = (name) => {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let dest = path.join(trashDir, name);
    for (let n = 1; fs.existsSync(dest); n++) dest = path.join(trashDir, `${stem} ${n}${ext}`);
    return dest;
  };
  const move = (from, to) => {
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  const dest = unique(path.basename(real));
  move(real, dest);
  if (hasSibling) move(sibling, unique(path.basename(sibling))); // Claude Code keeps per-session files in a folder of the same name
  return dest;
}

module.exports = { resumeCommand, exportMarkdown, openInTerminal, trash, AGENT_NAMES };
