'use strict';
// Discovery, index and cache of the agents' session files (port of sessions/store.py).
// The index lives in ~/.loopprism/sessions-index-node.db (LOOPPRISM_INDEX overrides it) and is
// refreshed incrementally: only files whose (mtime, size) changed are parsed again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./models');
const { sqlite } = require('./sqlite');
const claude = require('./adapters/claude_code');
const codex = require('./adapters/codex');
const gemini = require('./adapters/gemini');
const opencode = require('./adapters/opencode');
const cursor = require('./adapters/cursor');
const dsh = require('./adapters/dsh');
const workbuddy = require('./adapters/workbuddy');
const agentsTree = require('./agents');

const INDEX_VERSION = 3;
const CACHE_SIZE = 4;
const PARSERS = { 'claude-code': claude, codex, dsh, workbuddy, opencode, gemini, cursor };
const READ_ONLY_AGENTS = new Set(['dsh', 'workbuddy', 'opencode', 'gemini', 'cursor']);
const AGENTS = Object.keys(PARSERS);

function defaultRoots() {
  return {
    'claude-code': claude.root(),
    codex: codex.root(),
    dsh: dsh.root(),
    'dsh-desktop': dsh.desktopRoot(),
    workbuddy: workbuddy.root(),
    opencode: opencode.root(),
    gemini: gemini.root(),
    cursor: cursor.root(),
  };
}

function defaultIndexPath() {
  return process.env.LOOPPRISM_INDEX || path.join(os.homedir(), '.loopprism', 'sessions-index-node.db');
}

const SESSION_COLS = ['path', 'mtime', 'size', 'agent', 'id', 'project', 'title', 'started_at', 'ended_at', 'models', 'turns', 'steps', 'messages', 'tool_calls', 'cost_usd', 'fidelity', 'version', 'subagent_steps', 'git_branch'];

class SessionStore {
  constructor({ indexPath = defaultIndexPath(), roots = defaultRoots() } = {}) {
    this.roots = roots;
    this.sigs = new Map(); // database-backed sessions (OpenCode, Cursor): signature from discover()
    this.cache = new Map();
    this.pending = 0;
    if (indexPath !== ':memory:') fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(indexPath);
    this.fts = true;
    this.initDb();
  }

  close() {
    this.db.close();
  }

  /** Which Optimize suggestions were adopted (kept in the index database). */
  get adoptions() {
    if (!this._adoptions) {
      const { Adoptions } = require('./optimize_extras');
      this._adoptions = new Adoptions(this.db);
    }
    return this._adoptions;
  }

  allowedRoots() {
    return Object.values(this.roots).filter(Boolean);
  }

  initDb() {
    const db = this.db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        path TEXT PRIMARY KEY, mtime REAL, size INTEGER, agent TEXT, id TEXT,
        project TEXT, title TEXT, started_at TEXT, ended_at TEXT, models TEXT,
        turns INTEGER, steps INTEGER, messages INTEGER, tool_calls INTEGER,
        cost_usd REAL, fidelity TEXT, version TEXT, subagent_steps INTEGER, git_branch TEXT
      );
      CREATE TABLE IF NOT EXISTS usage (
        path TEXT, day TEXT, agent TEXT, project TEXT, model TEXT, steps INTEGER,
        input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, priced INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_usage_path ON usage(path);
      CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);
      CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    `);
    if (db.prepare('PRAGMA user_version').get().user_version < INDEX_VERSION) {
      db.exec('DELETE FROM sessions; DELETE FROM usage;');
      db.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
    }
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, body)');
    } catch {
      this.fts = false;
      db.exec('CREATE TABLE IF NOT EXISTS fts (path TEXT PRIMARY KEY, title TEXT, body TEXT)');
    }
  }

  // ------------------------------------------------------------------ discovery
  discover() {
    const r = this.roots;
    const found = [];
    if (r['claude-code']) for (const p of claude.discover(r['claude-code'])) found.push([p, 'claude-code']);
    if (r.codex) for (const p of codex.discover(r.codex)) found.push([p, 'codex']);
    this.sigs = new Map();
    for (const [key, mod] of [['opencode', opencode], ['cursor', cursor]]) {
      if (!r[key]) continue;
      let mine;
      try {
        mine = mod.discover(r[key]);
      } catch {
        mine = new Map();
      }
      for (const [p, sig] of mine) {
        this.sigs.set(p, sig);
        found.push([p, key]);
      }
    }
    for (const key of ['dsh', 'dsh-desktop']) if (r[key]) for (const p of dsh.discover(r[key])) found.push([p, 'dsh']);
    if (r.workbuddy) for (const p of workbuddy.discover(r.workbuddy)) found.push([p, 'workbuddy']);
    if (r.gemini) for (const p of gemini.discover(r.gemini)) found.push([p, 'gemini']);
    return found;
  }

  sig(p) {
    if (this.sigs.has(p)) return this.sigs.get(p);
    const st = fs.statSync(p);
    return [st.mtimeMs / 1000, st.size];
  }

  static usageRows(p, ps) {
    const agg = new Map();
    for (const st of ps.steps) {
      const day = (st.end_ts || st.ts || ps.meta.started_at || '').slice(0, 10) || 'unknown';
      const key = JSON.stringify([day, st.model || 'unknown']);
      if (!agg.has(key)) agg.set(key, [0, 0, 0, 0, 0, 0, 0]);
      const a = agg.get(key);
      a[0] += 1;
      a[1] += st.input_tokens;
      a[2] += st.output_tokens;
      a[3] += st.cache_read_tokens;
      a[4] += st.cache_write_tokens + st.cache_write_1h_tokens;
      if (st.cost_usd !== null) {
        a[5] += st.cost_usd;
        a[6] += 1;
      }
    }
    const m = ps.meta;
    return [...agg.entries()].map(([key, a]) => {
      const [day, model] = JSON.parse(key);
      return [p, day, m.agent, m.project, model, a[0], a[1], a[2], a[3], a[4], a[6] ? Number(a[5].toFixed(6)) : null, a[6]];
    });
  }

  indexFile(p, agent) {
    const sig = this.sig(p);
    const ps = PARSERS[agent].parse(p);
    const m = ps.meta;
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT OR REPLACE INTO sessions VALUES (${SESSION_COLS.map(() => '?').join(',')})`).run(
        p, sig[0], sig[1], m.agent, m.id, m.project, m.title, m.started_at, m.ended_at, JSON.stringify(m.models),
        m.turns, m.steps, m.messages, m.tool_calls, m.cost_usd, m.fidelity, m.version == null ? null : String(m.version),
        m.subagent_steps, m.git_branch,
      );
      db.prepare('DELETE FROM fts WHERE path = ?').run(p);
      db.prepare('INSERT INTO fts (path, title, body) VALUES (?,?,?)').run(p, m.title, ps.search_text);
      db.prepare('DELETE FROM usage WHERE path = ?').run(p);
      const ins = db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const row of SessionStore.usageRows(p, ps)) ins.run(...row);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.remember(p, sig, ps);
  }

  forgetRow(p) {
    for (const t of ['sessions', 'fts', 'usage']) this.db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(p);
    this.cache.delete(p);
  }

  /** Index new and changed files (newest first, within a time budget) and forget deleted ones. */
  refresh({ budgetMs = Infinity, onProgress = null } = {}) {
    const files = this.discover();
    const known = new Map(this.db.prepare('SELECT path, mtime, size FROM sessions').all().map((r) => [r.path, [r.mtime, r.size]]));
    const live = new Set(files.map(([p]) => p));
    for (const gone of known.keys()) if (!live.has(gone)) this.forgetRow(gone);
    const todo = [];
    for (const [p, agent] of files) {
      let sig;
      try {
        sig = this.sig(p);
      } catch {
        continue;
      }
      const k = known.get(p);
      if (!k || k[0] !== sig[0] || k[1] !== sig[1]) todo.push([sig[0], p, agent]);
    }
    todo.sort((a, b) => b[0] - a[0] || (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0));
    const deadline = Date.now() + budgetMs;
    let done = 0;
    for (const [, p, agent] of todo) {
      if (Date.now() > deadline) break;
      try {
        this.indexFile(p, agent);
      } catch {
        // a broken file must not hide the others
      }
      done += 1;
      if (onProgress) onProgress(done, todo.length);
    }
    this.pending = Math.max(0, todo.length - done);
    return { indexed: done, pending: this.pending, total: files.length };
  }

  // ------------------------------------------------------------------ query
  static row(r) {
    const d = { ...r };
    d.models = JSON.parse(d.models || '[]');
    delete d.mtime;
    d.read_only = READ_ONLY_AGENTS.has(d.agent);
    return d;
  }

  list({ agent = null, q = null, project = null, limit = 200, offset = 0 } = {}) {
    let sql = 'SELECT s.*';
    const params = [];
    if (q && q.trim()) {
      const terms = q.match(/[\p{L}\p{N}_]+/gu) || [q.trim()];
      if (this.fts) {
        sql += ", snippet(fts, 2, '[', ']', '…', 12) AS snippet FROM sessions s JOIN fts ON fts.path = s.path WHERE fts MATCH ?";
        params.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' '));
      } else {
        const like = `%${q.trim()}%`;
        sql += ', substr(f.body, 1, 160) AS snippet FROM sessions s JOIN fts f ON f.path = s.path WHERE (f.title LIKE ? OR f.body LIKE ?)';
        params.push(like, like);
      }
    } else sql += ' FROM sessions s WHERE 1=1';
    if (agent) {
      sql += ' AND s.agent = ?';
      params.push(agent);
    }
    if (project) {
      sql += ' AND s.project = ?';
      params.push(project);
    }
    sql += ' ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params).map(SessionStore.row);
  }

  count(agent = null) {
    if (agent) return this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent = ?').get(agent).n;
    return this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  }

  countsByAgent() {
    return Object.fromEntries(this.db.prepare('SELECT agent, COUNT(*) AS n FROM sessions GROUP BY agent').all().map((r) => [r.agent, r.n]));
  }

  projects() {
    return this.db
      .prepare('SELECT project, COUNT(*) AS sessions FROM sessions WHERE project IS NOT NULL GROUP BY project ORDER BY MAX(COALESCE(ended_at, started_at)) DESC')
      .all()
      .map((r) => ({ ...r }));
  }

  find(sessionId) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ? ORDER BY mtime DESC').get(sessionId);
    return r ? { ...SessionStore.row(r), path: r.path } : null;
  }

  /**
   * A session by reference: an exact id, a unique id prefix (8+ characters), "latest", or "current"
   * (the newest session whose project folder is `cwd`). Returns { row } or { error }.
   */
  resolve(ref, { cwd = process.cwd(), agent = null } = {}) {
    ref = String(ref || 'current').trim();
    if (ref === 'latest' || ref === 'current') {
      let rows = this.list({ agent, limit: 2000 });
      if (ref === 'current') {
        const want = norm(cwd);
        rows = rows.filter((r) => r.project && norm(r.project) === want);
        if (!rows.length) return { error: `No session found for the folder ${cwd}${agent ? ` (agent ${agent})` : ''}. Pass a session id, or "latest".` };
      }
      if (!rows.length) return { error: 'No sessions found on this machine.' };
      return { row: this.find(rows[0].id) };
    }
    const exact = this.find(ref);
    if (exact) return { row: exact };
    if (ref.includes('~')) return { row: null, subagent: ref };
    if (ref.length >= 6) {
      const hits = this.db.prepare("SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' GROUP BY id LIMIT 3").all(`${ref.replace(/[\\%_]/g, '\\$&')}%`);
      if (hits.length === 1) return { row: this.find(hits[0].id) };
      if (hits.length > 1) return { error: `"${ref}" matches several sessions: ${hits.map((h) => h.id).join(', ')}` };
    }
    return { error: `Session not found: ${ref}` };
  }

  // ------------------------------------------------------------------ parse
  remember(p, sig, ps) {
    this.cache.delete(p);
    this.cache.set(p, [sig, ps]);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }

  cached(p, sig) {
    const hit = this.cache.get(p);
    if (hit && hit[0][0] === sig[0] && hit[0][1] === sig[1]) {
      this.remember(p, sig, hit[1]);
      return hit[1];
    }
    return null;
  }

  load(sessionId) {
    if (sessionId.includes('~')) {
      const i = sessionId.indexOf('~');
      return this.loadSubagent(sessionId.slice(0, i), sessionId.slice(i + 1));
    }
    const row = this.find(sessionId);
    if (!row) return null;
    let sig;
    try {
      sig = this.sig(row.path);
    } catch {
      return null;
    }
    const hit = this.cached(row.path, sig);
    if (hit) return hit;
    const ps = PARSERS[row.agent].parse(row.path);
    this.remember(row.path, sig, ps);
    return ps;
  }

  /** A subagent's own transcript, addressed as "<session>~<agent>". */
  loadSubagent(parentId, agentId) {
    if (!agentsTree.AGENT_ID.test(agentId)) return null;
    const row = this.find(parentId);
    if (!row || row.agent !== 'claude-code') return null;
    let folder;
    let file;
    try {
      folder = fs.realpathSync(agentsTree.subagentDir(row.path));
      file = fs.realpathSync(agentsTree.subagentFile(row.path, agentId));
    } catch {
      return null;
    }
    if (path.dirname(file) !== folder || !fs.statSync(file).isFile()) return null;
    const st = fs.statSync(file);
    const sig = [st.mtimeMs / 1000, st.size];
    const hit = this.cached(file, sig);
    if (hit) return hit;
    const ps = claude.parse(file, true);
    const first = (ps.events.find((e) => e.kind === M.K.USER && e.text.trim()) || {}).text || '';
    ps.meta.id = `${parentId}~${agentId}`;
    ps.meta.title = ('Subagent: ' + (first.trim() ? first.trim().split(/\r?\n/)[0] : agentId)).slice(0, 200);
    this.remember(file, sig, ps);
    return ps;
  }

  // ------------------------------------------------------------------ cost
  costliest({ since = null, agent = null, limit = 80 } = {}) {
    let sql = 'SELECT * FROM sessions WHERE cost_usd IS NOT NULL AND cost_usd > 0';
    const params = [];
    if (since) {
      sql += ' AND substr(started_at, 1, 10) >= ?';
      params.push(since);
    }
    if (agent) {
      sql += ' AND agent = ?';
      params.push(agent);
    }
    return this.db.prepare(sql + ' ORDER BY cost_usd DESC LIMIT ?').all(...params, limit).map(SessionStore.row);
  }

  /** Spend and tokens across every indexed session, by day, model, agent and project. */
  costOverview({ since = null, agent = null } = {}) {
    const where = [];
    const params = [];
    if (since) {
      where.push('day >= ?');
      params.push(since);
    }
    if (agent) {
      where.push('agent = ?');
      params.push(agent);
    }
    const cond = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const q = (group) =>
      this.db
        .prepare(
          `SELECT ${group} AS key, SUM(steps) steps, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, ` +
            `SUM(cache_write) cache_write, SUM(cost) cost, SUM(priced) priced FROM usage ${cond} GROUP BY ${group} ` +
            'ORDER BY COALESCE(SUM(cost), 0) DESC, SUM(input + output + cache_read) DESC',
        )
        .all(...params)
        .map((r) => ({ ...r }));
    const tot = this.db
      .prepare(`SELECT COUNT(DISTINCT path) sessions, SUM(steps) steps, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write, SUM(cost) cost, SUM(priced) priced FROM usage ${cond}`)
      .get(...params);
    const top = this.db
      .prepare(
        `SELECT s.id, s.agent, s.title, s.project, s.started_at, u.cost FROM ` +
          `(SELECT path, SUM(cost) cost FROM usage ${cond} GROUP BY path HAVING SUM(cost) IS NOT NULL ORDER BY SUM(cost) DESC LIMIT 10) u ` +
          'JOIN sessions s ON s.path = u.path ORDER BY u.cost DESC',
      )
      .all(...params)
      .map((r) => ({ ...r }));
    const byDay = q('day').sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const models = q('model');
    const steps = Number(tot.steps || 0);
    const priced = Number(tot.priced || 0);
    return {
      totals: { ...tot, unpriced_steps: steps - priced },
      by_day: byDay,
      by_model: models,
      by_agent: q('agent'),
      by_project: q("COALESCE(project, '')").slice(0, 15),
      top_sessions: top,
      unpriced_models: models.filter((m) => m.cost === null && (m.input || m.output || m.cache_read)).map((m) => m.key),
    };
  }
}

function norm(p) {
  let out = path.resolve(p);
  try {
    out = fs.realpathSync(out);
  } catch {
    // a folder that no longer exists: compare as written
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? out.toLowerCase() : out;
}

/** "YYYY-MM-DD" of the first day of the last `days` days (UTC), or null for all time. */
function sinceDays(days) {
  if (!days) return null;
  return new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
}

module.exports = { SessionStore, AGENTS, READ_ONLY_AGENTS, defaultRoots, defaultIndexPath, sinceDays };
