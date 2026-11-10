'use strict';
// LoopPrism as an MCP server (stdio, newline-delimited JSON-RPC 2.0), with no dependencies.
//   npx -y loopprism mcp
// Read-only tools over the coding-agent sessions on this machine. stdout carries only protocol
// messages; anything else goes to stderr.
const { Inspector } = require('./api');
const { AGENTS } = require('./store');
const { version } = require('../package.json');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 80_000;

const SESSION = {
  type: 'string',
  description: 'A session id (or a unique prefix of 8+ characters), "current" for the newest session in `cwd`, or "latest" for the newest session of all. Subagents are "<session id>~<agent id>".',
};
const CWD = { type: 'string', description: 'Your working directory, to find the "current" session. Defaults to the server\'s own working directory.' };
const AGENT = { type: 'string', enum: AGENTS, description: 'Only sessions of this coding agent.' };
const DAYS = { type: 'integer', minimum: 0, maximum: 3650, default: 30, description: 'The last N days (0: all time).' };

const TOOLS = [
  {
    name: 'list_sessions',
    title: 'List agent sessions',
    description: 'Lists the coding-agent sessions on this machine (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, DeepSeek Harness, WorkBuddy), newest first, with their cost. `query` searches every prompt and answer.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT,
        project: { type: 'string', description: 'Only sessions of this project folder (exact path).' },
        query: { type: 'string', description: 'Full-text search over prompts and answers.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    run: (ins, a) => ins.sessions({ agent: a.agent, project: a.project, query: a.query, limit: a.limit ?? 20, offset: a.offset ?? 0 }),
  },
  {
    name: 'session_summary',
    title: 'Review a session',
    description: 'What a session cost and where the money, the context and the time went; loops (the same tool call repeated), error streaks and compactions; the largest tool outputs; subagents; and concrete ways to spend less. Use it to review the session you are in ("current") or any other.',
    inputSchema: { type: 'object', properties: { session: SESSION, cwd: CWD, agent: AGENT } },
    run: (ins, a) => ins.summary(a.session ?? 'current', { cwd: a.cwd, agent: a.agent }),
  },
  {
    name: 'session_events',
    title: 'Read session steps',
    description: 'The trajectory of a session: prompts, injected context, thinking, tool calls and results, in order. Filter by kind or text, page with offset/limit. Text is cut to `preview` characters; fetch one event in full with `event`.',
    inputSchema: {
      type: 'object',
      properties: {
        session: SESSION,
        cwd: CWD,
        agent: AGENT,
        kinds: { type: 'array', items: { type: 'string', enum: ['system', 'user', 'context', 'assistant', 'thinking', 'tool_call', 'tool_result', 'compaction', 'model_change', 'system_event'] } },
        query: { type: 'string', description: 'Only events whose text or tool name contains this.' },
        event: { type: 'integer', minimum: 0, description: 'Return this one event (by idx) in full instead of a page.' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        preview: { type: 'integer', minimum: 0, maximum: 20000, default: 300 },
      },
    },
    run: (ins, a) =>
      a.event !== undefined && a.event !== null
        ? ins.event(a.session ?? 'current', a.event, { cwd: a.cwd, agent: a.agent })
        : ins.events(a.session ?? 'current', { kinds: a.kinds, query: a.query, offset: a.offset ?? 0, limit: a.limit ?? 50, preview: a.preview ?? 300, cwd: a.cwd, agent: a.agent }),
  },
  {
    name: 'session_context',
    title: 'Context window breakdown',
    description: 'What filled the model\'s context: system prompt, tool schemas, user messages, injected context, skills, assistant messages, tool results. Without `step`: the latest step, the biggest jumps and the trend. With `step`: every item that step sent.',
    inputSchema: { type: 'object', properties: { session: SESSION, cwd: CWD, agent: AGENT, step: { type: 'integer', minimum: 0 } } },
    run: (ins, a) => ins.context(a.session ?? 'current', { step: a.step, cwd: a.cwd, agent: a.agent }),
  },
  {
    name: 'session_agents',
    title: 'Subagent tree',
    description: 'The main agent and every subagent it spawned (Claude Code): what each was asked, what it returned, its cost and duration, and how much ran in parallel.',
    inputSchema: { type: 'object', properties: { session: SESSION, cwd: CWD, agent: AGENT } },
    run: (ins, a) => ins.agents(a.session ?? 'current', { cwd: a.cwd, agent: a.agent }),
  },
  {
    name: 'cost_overview',
    title: 'Spend across sessions',
    description: 'What every coding agent on this machine cost (at API list prices), by day, model, agent and project, plus the most expensive sessions.',
    inputSchema: { type: 'object', properties: { days: DAYS, agent: AGENT } },
    run: (ins, a) => ins.cost({ days: a.days ?? 30, agent: a.agent }),
  },
  {
    name: 'find_savings',
    title: 'Ways to spend less',
    description: 'Looks at the most expensive sessions of the period and estimates what would have cost less: prompt caching, a smaller model for simple tasks, repeated tool calls, huge tool outputs, sessions that ran too long. Each suggestion has a saving in USD and a confidence.',
    inputSchema: { type: 'object', properties: { days: DAYS, agent: AGENT } },
    run: (ins, a) => ins.optimize({ days: a.days ?? 30, agent: a.agent }),
  },
  {
    name: 'export_session',
    title: 'Export as Markdown',
    description: 'The conversation of a session as Markdown: prompts, answers and the tools used.',
    inputSchema: { type: 'object', properties: { session: SESSION, cwd: CWD, agent: AGENT } },
    run: (ins, a) => ins.exportMarkdown(a.session ?? 'current', { cwd: a.cwd, agent: a.agent }),
  },
];
for (const t of TOOLS) t.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Start the dashboard (`lpa ui --detach`) and open it in the user's browser. */
function openDashboard(a) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const args = [require.resolve('../bin/lpa.js'), 'ui', '--detach'];
  if (a.session) args.splice(2, 0, String(a.session));
  const cwd = a.cwd && fs.existsSync(a.cwd) ? a.cwd : process.cwd();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(out || 'The dashboard did not start');
  return out;
}

TOOLS.push({
  name: 'open_dashboard',
  title: 'Open the dashboard',
  description: "Open LoopPrism's visual dashboard in the user's browser: sessions, the step timeline, the context breakdown, the subagent flow, cost and optimize pages. Starts a local server in the background (127.0.0.1 only). Returns the address; give it to the user.",
  inputSchema: { type: 'object', properties: { session: { ...SESSION, description: `${SESSION.description} Leave out for the session list.` }, cwd: CWD } },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: (_ins, a) => openDashboard(a),
});

const INSTRUCTIONS =
  'LoopPrism reads the session transcripts that coding agents keep on this machine. Use session_summary with session "current" ' +
  '(and your working directory as cwd) to review the session you are in; list_sessions and the other tools to look at any session; ' +
  'cost_overview and find_savings for spend across sessions. Costs are estimates at API list prices.';

function textOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n… [${text.length - MAX_TEXT} more characters; narrow the request]` : text;
}

class Server {
  constructor({ write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n'), inspector = null } = {}) {
    this.write = write;
    this.inspector = inspector;
  }

  ins() {
    if (!this.inspector) this.inspector = new Inspector();
    return this.inspector;
  }

  handle(msg) {
    if (Array.isArray(msg)) {
      const out = msg.map((m) => this.handle(m)).filter(Boolean);
      return out.length ? out : null;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    }
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return null; // notifications: initialized, cancelled, ...
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'loopprism', title: 'LoopPrism', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
        try {
          return ok({ content: [{ type: 'text', text: textOf(tool.run(this.ins(), params.arguments || {})) }] });
        } catch (err) {
          return ok({ content: [{ type: 'text', text: err.message }], isError: true });
        }
      }
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  line(text) {
    if (!text.trim()) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const reply = this.handle(msg);
    if (reply) this.write(reply);
  }
}

/** Serve on stdin/stdout until stdin closes. */
function serve() {
  const server = new Server();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      server.line(line);
    }
  });
  process.stdin.on('end', () => {
    if (buf.trim()) server.line(buf);
    process.exit(0);
  });
  return new Promise(() => {});
}

module.exports = { Server, serve, TOOLS, PROTOCOL_VERSIONS };
