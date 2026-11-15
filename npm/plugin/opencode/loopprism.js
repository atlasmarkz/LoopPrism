// loopprism-opencode-plugin
// LoopPrism plugin for OpenCode: reports prompts, tool calls and the end of each turn to the local
// LoopPrism API, so they show up as live runs. It never gets in OpenCode's way: every request has a
// one second limit and errors are swallowed. When LoopPrism is unreachable (or times out twice in a
// row) nothing is sent for ten seconds; one slow answer or an HTTP error does not pause recording.
//
// Installed to ~/.config/opencode/plugins/ by `lpa install opencode` or the LoopPrism desktop app.
// Environment: LOOPPRISM_URL (default: ~/.loopprism/agent.json, else http://127.0.0.1:8080),
// LOOPPRISM_DISABLE=1, LOOPPRISM_NO_PROMPTS=1 (do not send prompt text).
//
// One default export that two OpenCode generations read:
//   - OpenCode 2.x reads `id` and `setup(ctx)` and ignores `server`.
//   - OpenCode 1.x (1.18.29 and later) calls `server(input)` and uses the hooks it returns.
// 2.x refuses a plugin file without a default export that has an id and a setup function; that is
// why the 1.x-only version of this file never loaded there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT = "opencode";
const TIMEOUT_MS = 1000;
const BACKOFF_MS = 10_000;
const MAX_STRING = 4000;

function baseUrl() {
  if (process.env.LOOPPRISM_URL) return process.env.LOOPPRISM_URL.replace(/\/+$/, "");
  try {
    const url = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".loopprism", "agent.json"), "utf8")).url;
    if (typeof url === "string" && url) return url.replace(/\/+$/, "");
  } catch {
    // no config file: the default
  }
  return "http://127.0.0.1:8080";
}

function clip(value, depth = 0) {
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
function createReporter(directory) {
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
    setModel(sessionID, model) {
      if (sessionID && model) models.set(sessionID, model);
    },
    prompt({ sessionID, text, model }) {
      if (!sessionID) return;
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
      if (!sessionID || !open.delete(sessionID)) return;
      return send({ event: "stop", session_id: sessionID, cwd: directory, model: models.get(sessionID), ...(outcome ? { outcome } : {}) });
    },
    sessionEnd(sessionID) {
      if (!sessionID) return;
      open.delete(sessionID);
      models.delete(sessionID);
      return send({ event: "session_end", session_id: sessionID, cwd: directory });
    },
  };
}

const textOf = (parts) =>
  (parts || [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text)
    .join("\n");

const resultText = (result) =>
  (result?.content || [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");

export default {
  id: "loopprism",

  // ---- OpenCode 2.x ----
  async setup(ctx) {
    const reporter = createReporter(ctx.location?.directory);

    await ctx.session.hook("prompt", (e) => {
      void reporter.prompt({ sessionID: e.sessionID, text: e.prompt?.text });
    });
    await ctx.tool.hook("execute.before", (e) => reporter.toolStart(e.id));
    await ctx.tool.hook("execute.after", (e) => {
      void reporter.toolEnd({
        sessionID: e.sessionID,
        callID: e.id,
        tool: e.tool,
        input: e.input,
        response: e.status === "completed" ? resultText(e.result) : undefined,
        error: e.status === "error" ? (e.error?.message ?? "tool failed") : undefined,
      });
    });

    // The turn's end and the model come from the event stream; payloads sit under `data`.
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({
          signal: abort.signal,
          types: [
            "session.step.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.deleted",
          ],
        })) {
          const d = ev.data || {};
          if (ev.type === "session.step.started") reporter.setModel(d.sessionID, d.model?.id);
          else if (ev.type === "session.execution.succeeded") void reporter.stop(d.sessionID);
          else if (ev.type === "session.execution.failed") void reporter.stop(d.sessionID, "failed");
          else if (ev.type === "session.execution.interrupted") void reporter.stop(d.sessionID, "interrupted");
          else if (ev.type === "session.deleted") void reporter.sessionEnd(d.sessionID);
        }
      } catch {
        // aborted on unload, or the stream ended
      }
    })();

    return () => abort.abort();
  },

  // ---- OpenCode 1.x ----
  async server({ directory }) {
    const reporter = createReporter(directory);
    return {
      "chat.message": async (input, output) => {
        await reporter.prompt({ sessionID: input.sessionID, text: textOf(output.parts), model: input.model?.modelID });
      },
      "tool.execute.before": async (input) => reporter.toolStart(input.callID),
      "tool.execute.after": async (input, output) => {
        await reporter.toolEnd({
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
          input: input.args,
          response: output?.output,
        });
      },
      event: async ({ event }) => {
        const sid = event?.properties?.sessionID ?? event?.properties?.info?.id;
        if (!sid) return;
        if (event.type === "session.idle") await reporter.stop(sid);
        else if (event.type === "session.error") await reporter.stop(sid, "failed");
        else if (event.type === "session.deleted") await reporter.sessionEnd(sid);
      },
    };
  },
};
