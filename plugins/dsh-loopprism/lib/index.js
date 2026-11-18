// LoopPrism for DeepSeek Harness: the plugin's logic. plugin.js is the thin Cordis entry.
//
// Two jobs, both optional through config:
//   1. live: forward SessionStart / prompt / tool / failure / stop moments to the LoopPrism app
//      (POST /api/ingest/events, the same wire the Claude Code and Codex hooks use);
//   2. tools: register LoopPrism's session-review tools (the ones `lpa mcp` serves) as DSH tools.
//
// Everything LoopPrism-specific comes from the published `loopprism` npm package (CommonJS), so
// the event mapping and the tool list are not copied here.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const AGENT = 'dsh';
const BACKOFF_MS = 10_000;
const MAX_TEXT = 80_000;

/** Text of a list of content blocks. */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

/** The cwd of an agent's session, when it has one. */
function cwdOf(agent) {
  const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
  return typeof cwd === 'string' && cwd ? cwd : undefined;
}

function sessionIdOf(agent) {
  const id = agent && agent.session && agent.session.header && agent.session.header.id;
  return typeof id === 'string' ? id : '';
}

/** Claude Code shaped hook payload, which is what LoopPrism's `buildEvent` reads. */
function payload(agent, hook_event_name, extra = {}) {
  return { hook_event_name, session_id: sessionIdOf(agent), cwd: cwdOf(agent), ...extra };
}

class HttpError extends Error {}

/** One POST to the LoopPrism ingest endpoint. */
export async function post(event, url, ms) {
  const res = await fetch(`${url}/api/ingest/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new HttpError(`LoopPrism answered HTTP ${res.status}`);
}

/**
 * Serial, non-blocking sender: events go out in order, a failure never reaches the agent, and
 * while LoopPrism is unreachable (or timed out twice in a row) sends are skipped for a few seconds,
 * the same idea as the file based back-off in LoopPrism's command hooks, kept in memory because this
 * process is long-lived. An HTTP error does not pause sending: the app is there.
 */
export function createSender({ post: send = post, baseUrl, buildEvent, env = process.env, now = Date.now, config = {} }) {
  let pausedUntil = 0;
  let slowBefore = false;
  let tail = Promise.resolve();
  const timeout = Number(env.LOOPPRISM_HOOK_TIMEOUT_MS) > 0 ? Number(env.LOOPPRISM_HOOK_TIMEOUT_MS) : 1000;

  async function deliver(input) {
    if (env.LOOPPRISM_DISABLE === '1' || now() < pausedUntil) return;
    const eventEnv = config.sendPrompts === false ? { ...env, LOOPPRISM_NO_PROMPTS: '1' } : env;
    const event = buildEvent(input, AGENT, eventEnv);
    if (!event) return;
    const url = config.url ? String(config.url).replace(/\/+$/, '') : baseUrl(env);
    try {
      await send(event, url, timeout);
      slowBefore = false;
    } catch (err) {
      if (err instanceof HttpError) {
        /* answered: it is running */
      } else if (err && err.name === 'TimeoutError') {
        if (slowBefore) pausedUntil = now() + BACKOFF_MS;
        slowBefore = true;
      } else {
        pausedUntil = now() + BACKOFF_MS;
      }
      throw err;
    }
  }

  return {
    /** Queue one hook-shaped payload; resolves once it was tried. Never rejects. */
    push(input) {
      tail = tail.then(() => deliver(input)).catch((err) => {
        if (env.LOOPPRISM_DEBUG === '1') process.stderr.write(`loopprism (dsh): ${err && err.message}
`);
      });
      return tail;
    },
    drain: () => tail,
  };
}

/** Subscribe to the interception points that map onto LoopPrism's live events. Observe only. */
export function registerLive(ctx, sender) {
  ctx.on('agent/created', ({ agent, source }) => {
    sender.push(payload(agent, 'SessionStart', { source }));
  });

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.length > 0) {
      const prompt = messages.map((m) => textOf(m && m.content)).join('');
      sender.push(payload(agent, 'UserPromptSubmit', { prompt }));
    }
    return next();
  });

  ctx.on('tools/post-execute', (exec, result, next) => {
    const base = { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId };
    if (result && result.isError) {
      const message = (result.error && result.error.message) || textOf(result.content);
      sender.push(payload(exec.agent, 'PostToolUseFailure', { ...base, error: message }));
    } else {
      sender.push(payload(exec.agent, 'PostToolUse', { ...base, tool_response: textOf(result && result.content) }));
    }
    return next();
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    sender.push(payload(agent, 'Stop'));
  });
}

// ---- review tools ----------------------------------------------------------------------------

const SCALARS = new Set(['string', 'integer', 'number', 'boolean']);

/**
 * JSON Schema (as `lpa mcp` declares it) -> the DSH parameter DSL. Only keywords the DSL is known
 * to take are carried over; `minimum`, `maximum` and the like are dropped (LoopPrism checks its own
 * input).
 */
export function toParameters(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set((inputSchema && inputSchema.required) || []);
  const out = {};
  for (const [key, node] of Object.entries(props)) out[key] = toNode(node, required.has(key));
  return out;
}

function toNode(node, isRequired) {
  const spec = {};
  if (node && typeof node.description === 'string') spec.description = node.description;
  if (isRequired) spec.required = true;
  if (node && SCALARS.has(node.type)) {
    spec.type = node.type;
    if (Array.isArray(node.enum)) spec.enum = node.enum;
  } else if (node && node.type === 'array') {
    spec.type = 'array';
    if (node.items && SCALARS.has(node.items.type)) spec.items = toNode({ type: node.items.type, enum: node.items.enum });
  } else {
    spec.type = 'json';
  }
  return spec;
}

/** What a tool's result looks like to the model. */
export function render(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… [${text.length - MAX_TEXT} more characters; narrow the request]` : text;
}

/** Register every LoopPrism MCP tool as a DSH tool named `loopprism_<tool>`. Returns the names. */
export function registerTools(ctx, { tools, makeInspector, defineTool }) {
  let inspector = null;
  const names = [];
  for (const tool of tools) {
    const name = `loopprism_${tool.name}`;
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name,
            description: tool.description,
            parameters: toParameters(tool.inputSchema),
            output: {
              schema: { type: 'json' },
              render: (_args, value) => [{ type: 'text', text: render(value) }],
            },
            isConcurrencySafe: () => tool.annotations?.readOnlyHint === true,
            async execute(args, exec) {
              if (!inspector) inspector = makeInspector();
              const input = { ...(args || {}) };
              // "current" session means the newest one in the agent's own folder.
              if (input.cwd === undefined) input.cwd = cwdOf(exec && exec.agent);
              return render(tool.run(inspector, input));
            },
          }),
        ),
      `loopprism: ${name}`,
    );
    names.push(name);
  }
  return names;
}

/** Install both halves. `deps` is injectable for tests. */
export function install(ctx, config = {}, deps = {}) {
  const { defineTool } = deps;
  const loaded = {};
  const lazy = (key, load) => (loaded[key] ??= load());

  if (config.live !== false) {
    const hook = deps.hook ?? lazy('hook', () => require('loopprism/plugin/scripts/hook.js'));
    const { baseUrl } = deps.configModule ?? lazy('config', () => require('loopprism/plugin/scripts/config.js'));
    const sender = createSender({ post: deps.post, buildEvent: hook.buildEvent, baseUrl, config });
    registerLive(ctx, sender);
    ctx.effect(() => () => sender.drain(), 'loopprism: let queued events finish');
  }

  if (config.tools !== false && typeof defineTool !== 'function') {
    ctx.logger.warn('loopprism: @deepseek-ai/dsh-tools could not be loaded, so the review tools are not registered');
  } else if (config.tools !== false) {
    const tools = deps.tools ?? lazy('mcp', () => require('loopprism/core/mcp.js')).TOOLS;
    const makeInspector = deps.makeInspector ?? (() => new (require('loopprism/core/api.js').Inspector)());
    const names = registerTools(ctx, { tools, makeInspector, defineTool });
    ctx.logger.info(`loopprism: registered ${names.length} review tools`);
  }
}
