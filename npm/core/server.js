'use strict';
// `lpa ui`: LoopPrism's dashboard (the same React app as the desktop app) served by Node from this
// machine's session files, with no Python and no app. It answers the dashboard's /api/sessions/*
// routes (port of api/routes_sessions.py). The live run viewer needs the LoopPrism proxy: when a
// LoopPrism app or `lprism proxy` is running its routes are forwarded there, else they are empty.
//
// Only this machine may call it: it listens on 127.0.0.1, and every request must carry a loopback
// Host and, when a browser sends one, a same-origin Origin (session content must not be readable,
// and sessions not deletable, by other web pages).
const fs = require('fs');
const http = require('http');
const path = require('path');
const M = require('./models');
const { K } = M;
const context = require('./context');
const analysis = require('./analysis');
const agentsTree = require('./agents');
const actions = require('./actions');
const optimize = require('./optimize');
const extras = require('./optimize_extras');
const { SessionStore, READ_ONLY_AGENTS, sinceDays } = require('./store');
const { version } = require('../package.json');
const { cpSlice } = require('./util');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_PORT = 8765;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

/** The built dashboard: shipped in the package, or the repository's own build. */
function dashboardDir(root = path.resolve(__dirname, '..')) {
  for (const d of [path.join(root, 'dashboard'), path.join(root, '..', 'dashboard', 'dist')]) {
    if (fs.existsSync(path.join(d, 'index.html'))) return d;
  }
  return null;
}

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

const num = (v, dflt, { min = -Infinity, max = Infinity } = {}) => {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, `Invalid number: ${v}`);
  return n;
};

class Api {
  constructor({ store, liveUrl = null } = {}) {
    this.store = store || new SessionStore();
    this.liveUrl = liveUrl;
  }

  refresh(budgetMs) {
    return this.store.refresh({ budgetMs });
  }

  load(id) {
    let ps;
    if (id.includes('~')) {
      const i = id.indexOf('~');
      ps = this.store.loadSubagent(id.slice(0, i), id.slice(i + 1));
    } else {
      this.refresh(500);
      ps = this.store.load(id);
    }
    if (!ps) throw new HttpError(404, 'Session not found');
    return ps;
  }

  /** [status, body, contentType?] for one request. */
  async handle(method, pathname, q, readBody) {
    const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const [, a, b, c, d] = seg;
    if (a === 'health') return [200, { status: 'ok', ui: 'node', version }];
    if (a !== 'sessions') return this.live(method, pathname, q);

    // ---- collections
    if (!b && method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!b) {
      const progress = this.refresh(1500);
      const rows = this.store.list({ agent: q.get('agent'), q: q.get('q'), project: q.get('project'), limit: num(q.get('limit'), 300, { min: 1, max: 2000 }), offset: num(q.get('offset'), 0, { min: 0 }) });
      return [200, { sessions: rows, total: this.store.count(q.get('agent')), by_agent: this.store.countsByAgent(), pending: progress.pending }];
    }
    if (b === 'projects') return [200, { projects: this.store.projects() }];
    if (b === 'cost' && c === 'overview') {
      this.refresh(5000);
      const days = num(q.get('days'), 30, { min: 0, max: 3650 });
      const out = this.store.costOverview({ since: sinceDays(days), agent: q.get('agent') });
      return [200, { ...out, days, pending: this.store.pending }];
    }
    if (b === 'optimize') return this.optimize(method, c, d, q, readBody);

    // ---- one session
    const id = b;
    if (method === 'POST' && c === 'resume') {
      if (id.includes('~')) throw new HttpError(400, 'Subagent transcripts cannot be resumed on their own');
      const ps = this.load(id);
      if (READ_ONLY_AGENTS.has(ps.meta.agent)) throw new HttpError(400, 'Resume this session from its own app; LoopPrism only reads it');
      const command = actions.resumeCommand(ps.meta);
      if (!command) throw new HttpError(400, 'This session cannot be resumed');
      const terminal = q.get('terminal') === 'true';
      if (terminal) {
        try {
          actions.openInTerminal(command);
        } catch (err) {
          throw new HttpError(500, err.message);
        }
      }
      return [200, { command, opened: terminal }];
    }
    if (method === 'POST' && c === 'delete') {
      if (id.includes('~')) throw new HttpError(400, 'Delete the parent session instead');
      const row = this.store.find(id);
      if (!row) throw new HttpError(404, 'Session not found');
      if (READ_ONLY_AGENTS.has(row.agent)) throw new HttpError(400, 'Delete this session from its own app; LoopPrism only reads it');
      let dest;
      try {
        dest = actions.trash(row.path, this.store.allowedRoots());
      } catch (err) {
        if (err.code === 'EPERM') throw new HttpError(403, err.message);
        if (err.code === 'ENOENT') throw new HttpError(404, 'Session file is already gone');
        throw new HttpError(500, err.message);
      }
      this.store.forgetRow(row.path);
      return [200, { trashed: dest }];
    }
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed');

    const ps = this.load(id);
    if (!c) {
      const meta = { ...ps.meta, read_only: READ_ONLY_AGENTS.has(ps.meta.agent) };
      meta.resume_command = id.includes('~') || meta.read_only ? null : actions.resumeCommand(ps.meta);
      return [200, { session: meta, stats: context.stats(ps), findings: analysis.findings(ps) }];
    }
    switch (c) {
      case 'agents':
        if (id.includes('~')) throw new HttpError(400, 'Open the agent tree from the parent session');
        return [200, agentsTree.build(ps)];
      case 'events': {
        if (d !== undefined) {
          const idx = num(d, null);
          if (idx === null || idx < 0 || idx >= ps.events.length) throw new HttpError(404, 'Event not found');
          return [200, M.eventToDict(ps.events[idx])];
        }
        const wanted = q.get('kinds') ? new Set(q.get('kinds').split(',')) : null;
        const needle = q.get('q') ? q.get('q').toLowerCase() : null;
        const pool = ps.events.filter((e) => (!wanted || wanted.has(e.kind)) && (!needle || e.text.toLowerCase().includes(needle) || (e.tool_name || '').toLowerCase().includes(needle)));
        const offset = num(q.get('offset'), 0, { min: 0 });
        const limit = num(q.get('limit'), 500, { min: 1, max: 5000 });
        const preview = num(q.get('preview'), null, { min: 0, max: 100_000 });
        return [200, { total: pool.length, events: pool.slice(offset, offset + limit).map((e) => M.eventToDict(e, preview)) }];
      }
      case 'trajectory': {
        const turns = new Map();
        for (const e of ps.events) {
          if (e.turn && !turns.has(e.turn) && e.kind === K.USER && !e.sidechain) turns.set(e.turn, { turn: e.turn, first_event: e.idx, ts: e.ts, text: cpSlice(e.text, 200) });
        }
        const steps = ps.steps.filter((s) => s.model !== '<synthetic>').map((s) => ({
          step: s.index, turn: s.turn, model: s.model, ts: s.ts, sidechain: s.sidechain, first_event: s.first_event,
          input_tokens: M.totalInput(s), output_tokens: s.output_tokens, cost_usd: s.cost_usd, model_ms: s.model_ms, thinking_ms: s.thinking_ms, tools_ms: s.tools_ms,
        }));
        return [200, { turns: [...turns.values()], steps, findings: analysis.findings(ps), event_count: ps.events.length }];
      }
      case 'context':
        if (d !== undefined) {
          const step = num(d, null);
          if (step === null || step < 0 || step >= ps.steps.length) throw new HttpError(404, 'Step not found');
          return [200, context.stepContext(ps, step, q.get('detail') !== 'false')];
        }
        return [200, { stats: context.stats(ps), trend: context.trend(ps) }];
      case 'cost':
        return [200, analysis.costBreakdown(ps)];
      case 'timing':
        return [200, analysis.timing(ps)];
      case 'export.md':
        return [200, actions.exportMarkdown(ps), 'text/markdown; charset=utf-8'];
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  overviewAndResult(days, agent) {
    this.refresh(5000);
    const since = sinceDays(days);
    const overview = this.store.costOverview({ since, agent });
    const result = optimize.analyze(this.store.costliest({ since, agent }), (id) => this.store.load(id), overview.totals.cost || 0);
    result.days = days;
    return [overview, result];
  }

  async optimize(method, c, d, q, readBody) {
    const agent = q.get('agent');
    if (!c && method === 'GET') {
      const days = num(q.get('days'), 30, { min: 1, max: 3650 });
      const [, result] = this.overviewAndResult(days, agent);
      const states = this.store.adoptions.states();
      for (const s of result.suggestions) s.adoption = states[s.id] ?? null;
      return [200, { ...result, pending: this.store.pending }];
    }
    if (c === 'tools' && method === 'GET') return [200, await extras.toolsFor(extras.loadConfig().live_tools, q.get('refresh') === 'true')];
    if (c === 'settings') {
      if (method === 'GET') return [200, extras.publicConfig(extras.loadConfig())];
      if (method === 'PUT') {
        let body;
        try {
          body = JSON.parse(await readBody());
        } catch {
          body = {};
        }
        try {
          return [200, extras.publicConfig(extras.saveConfig(body && typeof body === 'object' && !Array.isArray(body) ? body : {}))];
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
    }
    if (c === 'ai' && method === 'POST') {
      if (d !== 'preview' && d !== 'run') throw new HttpError(404, 'Unknown step');
      const cfg = extras.loadConfig();
      const [overview, result] = this.overviewAndResult(num(q.get('days'), 30, { min: 1, max: 3650 }), agent);
      const messages = extras.buildMessages(overview, result, q.get('language') || 'en');
      if (d === 'preview') return [200, { endpoint: cfg.ai.url ? extras.endpoint(cfg.ai.url) : null, model: cfg.ai.model, messages, ready: cfg.ai.enabled }];
      if (!cfg.ai.enabled) throw new HttpError(400, 'AI analysis is turned off in the Optimize settings');
      try {
        return [200, { text: await extras.runAi(cfg, messages) }];
      } catch (err) {
        throw new HttpError(502, String(err.message).split(cfg.ai.api_key).join('***')); // the endpoint's answer, never the key
      }
    }
    if (c && d && method === 'POST') {
      if (!optimize.COPY[c]) throw new HttpError(404, 'Unknown suggestion');
      const ad = this.store.adoptions;
      if (d === 'adopt') return [200, ad.adopt(c)];
      if (d === 'dismiss') return [200, ad.dismiss(c)];
      if (d === 'reset') {
        ad.reset(c);
        return [200, { state: null }];
      }
      throw new HttpError(400, 'Unknown action');
    }
    throw new HttpError(404, 'Not found');
  }

  /** The live run viewer's routes: forwarded to a running LoopPrism, else empty. */
  async live(method, pathname, q) {
    if (this.liveUrl && method === 'GET') {
      try {
        const res = await fetch(`${this.liveUrl}${pathname}${q.size ? `?${q}` : ''}`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return [200, await res.json()];
      } catch {
        // not running: fall through to the empty answers
      }
    }
    const p = pathname.replace(/^\/api/, '');
    if (p === '/traces') return [200, { traces: [], limit: num(q.get('limit'), 20), offset: num(q.get('offset'), 0) }];
    if (p === '/mcp-servers' || p === '/mcp-tools' || p === '/cost/top-tools') return [200, []];
    if (p === '/cost/trend') return [200, { trends: [] }];
    if (p === '/cost/summary') {
      const { PRICING_AS_OF } = require('./pricing');
      return [200, {
        run_count: 0, priced_runs: 0, tool_call_count: 0, pricing_as_of: PRICING_AS_OF, pricing_sources: {}, total_tool_calls: 0,
        total_errors: 0, total_result_bytes: 0, estimated_cost_usd: 0, mcp_servers: [], tools: [],
      }];
    }
    throw new HttpError(404, 'Live runs need the LoopPrism app or `lprism proxy`');
  }
}

/** Requests must come from this machine's own pages. */
function checkLocal(req) {
  const host = req.headers.host || '';
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    hostname = '';
  }
  if (!LOOPBACK.has(hostname)) throw new HttpError(403, 'Sessions are only available on this machine');
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try {
      o = new URL(origin).host;
    } catch {
      o = null;
    }
    if (o !== host) throw new HttpError(403, 'Cross-origin requests are not accepted');
  }
}

function createServer({ api = new Api(), dist = dashboardDir(), onRequest = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    onRequest();
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type) => {
      const text = typeof body === 'string' && type ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(text);
    };
    try {
      checkLocal(req);
      if (url.pathname.startsWith('/api/')) {
        const readBody = () =>
          new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => {
              data += chunk;
              if (data.length > 1_000_000) reject(new HttpError(413, 'Too large'));
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
        const [status, body, type] = await api.handle(req.method, url.pathname, url.searchParams, readBody);
        return send(status, body, type);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (!dist) return send(500, 'The dashboard is not in this package.', 'text/plain; charset=utf-8');
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(dist, '.' + rel);
      if (!file.startsWith(dist + path.sep)) throw new HttpError(404, 'Not found');
      let data;
      try {
        data = fs.readFileSync(file);
      } catch {
        data = fs.readFileSync(path.join(dist, 'index.html'));
        res.writeHead(200, { 'Content-Type': TYPES['.html'] });
        return res.end(data);
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      send(status, { detail: err.message });
    }
  });
}

/** Listen on 127.0.0.1, from `port` up to the next free one. Resolves to the port used. */
function listen(server, port = DEFAULT_PORT, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0 && port !== 0) attempt(p + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    };
    attempt(port, tries);
  });
}

module.exports = { Api, createServer, listen, dashboardDir, checkLocal, DEFAULT_PORT, HttpError };
