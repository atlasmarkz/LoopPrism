// Runs LoopPrism's Inspector off the TUI thread. It reads OpenCode's session database read-only and
// keeps a small index in ~/.loopprism (LOOPPRISM_INDEX overrides it); nothing is sent anywhere.
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { slim } from "./summary.js";

const require = createRequire(import.meta.url);
let inspector;

function open() {
  if (inspector) return inspector;
  // LOOPPRISM_API points at another copy of loopprism/core/api.js (tests, a checkout)
  const file = workerData?.apiPath || process.env.LOOPPRISM_API || require.resolve("loopprism/core/api.js");
  const { Inspector } = require(file);
  inspector = new Inspector({ ...(workerData?.inspector || {}) });
  return inspector;
}

function classify(e) {
  const msg = String(e?.message || e);
  if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") return /sqlite/.test(msg) ? "sqlite" : "missing";
  if (/node:sqlite/.test(msg)) return "sqlite";
  if (/Session not found|No sessions? found/.test(msg)) return "not_found";
  return "error";
}

parentPort.on("message", ({ id, session }) => {
  try {
    parentPort.postMessage({ id, ok: true, summary: slim(open().summary(session, { agent: "opencode" })) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, code: classify(e), message: String(e?.message || e).slice(0, 300) });
  }
});
