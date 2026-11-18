// Shared reporting core for both OpenCode plugin APIs (V1 hooks and V2 setup(ctx)).
// Sends prompts, tool calls and the end of each turn to the local LoopPrism API. It never gets in
// OpenCode's way: every request has a one second limit and errors are swallowed. When LoopPrism is
// unreachable (or times out twice in a row) nothing is sent for ten seconds; one slow answer or an
// HTTP error does not pause recording.
//
// Environment: LOOPPRISM_URL (default: ~/.loopprism/agent.json, else http://127.0.0.1:8080),
// LOOPPRISM_DISABLE=1, LOOPPRISM_NO_PROMPTS=1 (do not send prompt text).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT = "opencode";
const TIMEOUT_MS = 1000;
const BACKOFF_MS = 10_000;
const MAX_STRING = 4000;

export function baseUrl() {
  if (process.env.LOOPPRISM_URL) return process.env.LOOPPRISM_URL.replace(/\/+$/, "");
  try {
    const url = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".loopprism", "agent.json"), "utf8")).url;
    if (typeof url === "string" && url) return url.replace(/\/+$/, "");
  } catch {
    // no config file: the default
  }
  return "http://127.0.0.1:8080";
}

export function clip(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... [${value.length - MAX_STRING} more chars]` : value;
  }
  if (depth >= 6) return "...";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = clip(v, depth + 1);
    return out;
  }
  return value;
}

/** One reporter per plugin instance: it owns the back-off state and the per-session bookkeeping. */
export function createReporter({ directory }) {
  let quietUntil = 0;
  let slowAt = 0; // when the last request timed out; a second timeout soon after starts the quiet time
  const started = new Map(); // call id -> start time
  const open = new Set(); // sessions with a run in progress
  const models = new Map(); // session id -> model id

  async function send(event) {
    if (process.env.LOOPPRISM_DISABLE === "1" || Date.now() < quietUntil) return;
    try {
      await fetch(`${baseUrl()}/api/ingest/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [{ agent: AGENT, ...event }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const now = Date.now();
      if (err && err.name === "TimeoutError" && now - slowAt >= BACKOFF_MS) slowAt = now; // one slow answer
      else quietUntil = now + BACKOFF_MS; // unreachable, or hung
      return;
    }
    slowAt = 0; // answered (even with an HTTP error): LoopPrism is running
  }

  return {
    send,
    setModel(sessionID, model) {
      if (sessionID && model) models.set(sessionID, model);
    },
    prompt({ sessionID, text, model }) {
      if (!sessionID) return Promise.resolve();
      this.setModel(sessionID, model);
      open.add(sessionID);
      return send({
        event: "prompt",
        session_id: sessionID,
        cwd: directory,
        model: models.get(sessionID),
        ...(process.env.LOOPPRISM_NO_PROMPTS ? {} : { prompt: clip(text ?? "") }),
      });
    },
    toolStart(callID) {
      if (callID) started.set(callID, Date.now());
    },
    toolEnd({ sessionID, callID, tool, input, response, error }) {
      const t0 = started.get(callID);
      started.delete(callID);
      return send({
        event: error ? "tool_failure" : "tool",
        session_id: sessionID,
        cwd: directory,
        model: models.get(sessionID),
        tool_name: tool,
        tool_input: clip(input),
        tool_use_id: callID,
        ...(error ? { error: clip(String(error)) } : { tool_response: clip(response) }),
        duration_ms: t0 ? Date.now() - t0 : undefined,
      });
    },
    /** The end of a turn. Reported once per run that was opened by a prompt. */
    stop(sessionID, outcome) {
      if (!sessionID || !open.delete(sessionID)) return Promise.resolve();
      return send({ event: "stop", session_id: sessionID, cwd: directory, model: models.get(sessionID), ...(outcome ? { outcome } : {}) });
    },
    sessionEnd(sessionID) {
      if (!sessionID) return Promise.resolve();
      open.delete(sessionID);
      models.delete(sessionID);
      return send({ event: "session_end", session_id: sessionID, cwd: directory });
    },
  };
}
