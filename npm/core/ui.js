'use strict';
// `lpa ui [SESSION] [--port N] [--detach] [--no-open]`: the dashboard in the browser.
//   foreground (default): serve until Ctrl-C.
//   --detach: start a background server that exits after an hour without requests, open the
//   browser and return at once (what the agent plugins and skills use). A LoopPrism UI already
//   listening on the port is reused.
const { spawn } = require('child_process');
const { Api, createServer, listen, DEFAULT_PORT, dashboardDir } = require('./server');
const { SessionStore } = require('./store');

const IDLE_MS = 60 * 60 * 1000;

function opener() {
  if (process.platform === 'darwin') return (url) => ['open', [url]];
  if (process.platform === 'win32') return (url) => ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]];
  return (url) => ['xdg-open', [url]];
}

function openBrowser(url) {
  const [cmd, args] = opener()(url);
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body && body.ui === 'node' ? body : null;
  } catch {
    return null;
  }
}

function liveUrl() {
  try {
    return require('../plugin/scripts/config').baseUrl();
  } catch {
    return 'http://127.0.0.1:8080';
  }
}

/** "#/sessions/<id>/chat" for a session reference, or "" for the session list. */
function hashFor(ref, cwd) {
  if (!ref) return '';
  const store = new SessionStore();
  try {
    store.refresh({ budgetMs: 10_000 });
    const r = store.resolve(ref, { cwd });
    if (r.error) {
      console.error(`${r.error} Opening the session list.`);
      return '';
    }
    return `#/sessions/${encodeURIComponent(r.row ? r.row.id : r.subagent)}/chat`;
  } finally {
    store.close();
  }
}

async function serveForeground({ port, idleMs = 0, quiet = false }) {
  if (!dashboardDir()) throw new Error('The dashboard is not in this package. Reinstall it with `npx loopprism install`.');
  let timer = null;
  const server = createServer({
    api: new Api({ liveUrl: liveUrl() }),
    onRequest: () => {
      if (!idleMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => process.exit(0), idleMs);
    },
  });
  const used = await listen(server, port);
  if (idleMs) timer = setTimeout(() => process.exit(0), idleMs);
  if (!quiet) console.log(`LoopPrism is serving http://127.0.0.1:${used}/ (Ctrl-C to stop)`);
  return used;
}

async function run(argv) {
  const opts = { port: DEFAULT_PORT, detach: false, open: true, serve: false, idle: 0, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--detach') opts.detach = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--serve') opts.serve = true; // the detached child
    else if (a === '--idle') opts.idle = Number(argv[++i]) * 1000;
    else if (!a.startsWith('-')) opts.ref = a;
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be a port number');

  if (opts.serve) {
    await serveForeground({ port: opts.port, idleMs: opts.idle || IDLE_MS, quiet: true });
    return new Promise(() => {});
  }

  const hash = hashFor(opts.ref, process.cwd());
  let port = (await health(opts.port)) ? opts.port : null;
  if (!port && opts.detach) {
    const child = spawn(process.execPath, [require.resolve('../bin/lpa.js'), 'ui', '--serve', '--port', String(opts.port), '--idle', String(IDLE_MS / 1000)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 50 && !port; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await health(opts.port)) port = opts.port;
    }
    if (!port) throw new Error(`The dashboard did not start on port ${opts.port} (in use by another program?). Try --port <another>.`);
  }
  if (port) {
    const url = `http://127.0.0.1:${port}/${hash}`;
    const opened = opts.open && openBrowser(url);
    console.log(`LoopPrism dashboard: ${url}${opened ? ' (opened in your browser)' : ''}`);
    return 0;
  }

  const used = await serveForeground({ port: opts.port });
  const url = `http://127.0.0.1:${used}/${hash}`;
  if (opts.open) openBrowser(url);
  console.log(`Dashboard: ${url}`);
  return new Promise(() => {});
}

module.exports = { run, hashFor };
