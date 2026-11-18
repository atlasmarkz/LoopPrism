// LoopPrism for OpenCode.
//
// One default export that two OpenCode generations read:
//   - OpenCode V2 reads `id` and `setup(ctx)`; hooks, MCP server and skill are registered there.
//   - OpenCode V1 (>= 1.18.29, per the OpenCode docs) calls `server(input)` and uses the hooks it returns.
// The two APIs are separate; both feed the same reporter (see reporter.js).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createReporter } from "./reporter.js";

const ID = "loopprism";
const require = createRequire(import.meta.url);

const text = (parts) =>
  (parts || [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text)
    .join("\n");

/** The `lpa` entry point of the `loopprism` npm package this plugin depends on, or undefined. */
function lpaPath() {
  try {
    return require.resolve("loopprism/bin/lpa.js");
  } catch {
    return undefined;
  }
}

/** Command that starts the stdio MCP server (`lpa mcp`). LOOPPRISM_MCP_COMMAND overrides it (JSON array). */
export function mcpCommand(env = process.env) {
  if (env.LOOPPRISM_MCP_COMMAND) {
    try {
      const cmd = JSON.parse(env.LOOPPRISM_MCP_COMMAND);
      if (Array.isArray(cmd) && cmd.length && cmd.every((s) => typeof s === "string")) return cmd;
    } catch {
      // fall through to the default
    }
  }
  const lpa = lpaPath();
  return lpa ? ["node", lpa, "mcp"] : undefined;
}

/** The LoopPrism skill shipped inside the `loopprism` npm package, or undefined. */
function loadSkill() {
  const lpa = lpaPath();
  if (!lpa) return undefined;
  const file = path.join(path.dirname(lpa), "..", "plugin", "skills", "loopprism", "SKILL.md");
  try {
    const content = fs.readFileSync(file, "utf8");
    const description = /^description:\s*(.+)$/m.exec(content)?.[1];
    return { id: ID, name: ID, description, path: path.resolve(file), content };
  } catch {
    return undefined;
  }
}

const eventText = (result) =>
  (result?.content || [])
    .map((c) => (c && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");

export default {
  id: ID,

  // ---- OpenCode V2 ----
  async setup(ctx) {
    const reporter = createReporter({ directory: ctx.location?.directory });

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
        response: e.status === "completed" ? eventText(e.result) : undefined,
        error: e.status === "error" ? e.error?.message ?? "tool failed" : undefined,
      });
    });

    // Session lifecycle comes from the event stream. Payloads sit under `data`.
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

    // The MCP server and the skill, registered by the plugin instead of by editing opencode.json.
    // An entry the user already has under the same name is left alone.
    const command = mcpCommand();
    if (command) {
      await ctx.mcp.transform((editor) => {
        if (!editor.get(ID)) editor.set(ID, { type: "local", command });
      });
    }
    const skill = loadSkill();
    if (skill && ctx.skill?.transform) {
      await ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill);
      });
    }

    return () => abort.abort();
  },

  // ---- OpenCode V1 ----
  async server({ directory }) {
    const reporter = createReporter({ directory });
    return {
      "chat.message": async (input, output) => {
        await reporter.prompt({ sessionID: input.sessionID, text: text(output.parts), model: input.model?.modelID });
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
