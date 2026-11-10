#!/usr/bin/env node
'use strict';
// LoopPrism hook for Claude Code and Codex.
//
// Reads one hook event as JSON on stdin and forwards it to the LoopPrism API.
// It must never get in the agent's way: it always prints `{}`, always exits 0,
// gives up after one second, and skips sending for a few seconds when
// LoopPrism is unreachable (or timed out twice in a row) so a stopped or hung
// server does not slow every tool call. A single slow answer or an HTTP error
// does not pause recording: the server is there, the next event may get through.
//
//   node hook.js --agent claude-code|codex
//
// Environment: LOOPPRISM_URL (default http://127.0.0.1:8080),
// LOOPPRISM_DISABLE=1, LOOPPRISM_NO_PROMPTS=1 (do not send prompt text),
// LOOPPRISM_DEBUG=1 (print problems to stderr),
// LOOPPRISM_HOOK_TIMEOUT_MS (how long to wait for LoopPrism, default 1000).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseUrl } = require('./config');
const { turnUsage } = require('./usage');

const EVENTS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  PostToolUseFailure: 'tool_failure',
  Stop: 'stop',
  SessionEnd: 'session_end',
  // Gemini CLI's names for the same moments.
  BeforeAgent: 'prompt',
  AfterTool: 'tool',
  AfterAgent: 'stop',
  // Cursor's names. It identifies the conversation as conversation_id, the folder as workspace_roots,
  // the tool result as tool_output and the failure as error_message.
  beforeSubmitPrompt: 'prompt',
  postToolUse: 'tool',
  postToolUseFailure: 'tool_failure',
  stop: 'stop',
  sessionStart: 'session_start',
  sessionEnd: 'session_end',
};

// Claude Code feeds some automatic messages back as prompts (system reminders,
// background task notifications). They are not something the user typed, so
// their text is not sent.
const AUTOMATED_PROMPT = /^\s*<(system-reminder|task-notification|[a-z-]+-event)\b/;
const AUTOMATED_LABEL = '(automated message)';

const TIMEOUT_MS = 1000;
const BACKOFF_MS = 10_000;
const MAX_STRING = 4000;

function clip(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}... [${value.length - MAX_STRING} more chars]`
      : value;
  }
  if (depth >= 6) return '...';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = clip(v, depth + 1);
    return out;
  }
  return value;
}

/** Map a hook payload to a LoopPrism ingest event, or null if it should be skipped. */
function buildEvent(input, agent, env = process.env) {
  let kind = EVENTS[input && input.hook_event_name];
  const sessionId = input && (input.session_id || input.conversation_id);
  if (!kind || !sessionId) return null;
  // Gemini CLI reports a failed tool in the result of AfterTool.
  const failedResult = input.hook_event_name === 'AfterTool' && input.tool_response && input.tool_response.error;
  if (failedResult) kind = 'tool_failure';
  const event = {
    agent,
    event: kind,
    session_id: String(sessionId),
    turn_id: input.turn_id,
    cwd: input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined),
    model: input.model,
  };
  if (kind === 'prompt' && !env.LOOPPRISM_NO_PROMPTS) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    event.prompt = AUTOMATED_PROMPT.test(prompt) ? AUTOMATED_LABEL : clip(prompt);
  }
  if (kind === 'tool' || kind === 'tool_failure') {
    event.tool_name = input.tool_name;
    event.tool_input = clip(input.tool_input);
    event.tool_use_id = input.tool_use_id;
    event.duration_ms = input.duration_ms ?? input.duration;
    if (kind === 'tool') event.tool_response = clip(input.tool_response ?? input.tool_output);
    else event.error = clip(input.error || input.error_message || (failedResult && String(failedResult.message || failedResult)));
  }
  return event;
}

function backoffFile() {
  return path.join(os.tmpdir(), 'loopprism-hook-backoff');
}

function inBackoff(now = Date.now()) {
  try {
    return now - fs.statSync(backoffFile()).mtimeMs < BACKOFF_MS;
  } catch {
    return false;
  }
}

// A timeout leaves this mark; a second one while it is fresh starts the back-off.
function slowFile() {
  return path.join(os.tmpdir(), 'loopprism-hook-slow');
}

function recentlySlow(now = Date.now()) {
  try {
    return now - fs.statSync(slowFile()).mtimeMs < BACKOFF_MS;
  } catch {
    return false;
  }
}

function markSlow() {
  try {
    fs.writeFileSync(slowFile(), String(Date.now()));
  } catch {
    // best effort
  }
}

function clearSlow() {
  try {
    fs.unlinkSync(slowFile());
  } catch {
    // not there
  }
}

class HttpError extends Error {}

/** After a failed send: should the next hooks skip sending for a while? */
function shouldBackOff(err, slowBefore) {
  if (err instanceof HttpError) return false; // LoopPrism answered: it is running
  if (err && err.name === 'TimeoutError') return slowBefore; // hung, not just one slow answer
  return true; // unreachable: refused, no such host, ...
}

function startBackoff() {
  try {
    fs.writeFileSync(backoffFile(), String(Date.now()));
  } catch {
    // best effort
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function timeoutMs(env = process.env) {
  const ms = Number(env.LOOPPRISM_HOOK_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : TIMEOUT_MS;
}

async function send(event, url = baseUrl(), ms = TIMEOUT_MS) {
  const res = await fetch(`${url}/api/ingest/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new HttpError(`LoopPrism answered HTTP ${res.status}`);
}

async function main(argv = process.argv, env = process.env) {
  const i = argv.indexOf('--agent');
  const agent = i >= 0 && argv[i + 1] ? argv[i + 1] : 'unknown';
  let reply = '{}';
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (input.hook_event_name === 'beforeSubmitPrompt') reply = '{"continue":true}'; // Cursor asks whether the prompt may go ahead
    if (env.LOOPPRISM_DISABLE === '1' || inBackoff()) return;
    const event = buildEvent(input, agent, env);
    if (!event) return;
    if (event.event === 'stop') {
      const usage = turnUsage(agent, input, env);
      if (usage.length) event.usage = usage;
    }
    const slowBefore = recentlySlow();
    try {
      await send(event, baseUrl(env), timeoutMs(env));
      if (slowBefore) clearSlow();
    } catch (err) {
      if (shouldBackOff(err, slowBefore)) startBackoff();
      else if (err && err.name === 'TimeoutError') markSlow();
      throw err;
    }
  } catch (err) {
    if (env.LOOPPRISM_DEBUG === '1') process.stderr.write(`loopprism hook: ${err.message}\n`);
  } finally {
    // Cursor's beforeSubmitPrompt expects an answer to "may this prompt go ahead?".
    process.stdout.write(reply);
  }
}

module.exports = { EVENTS, AUTOMATED_LABEL, HttpError, buildEvent, clip, send, shouldBackOff };

if (require.main === module) main().then(() => process.exit(0));
