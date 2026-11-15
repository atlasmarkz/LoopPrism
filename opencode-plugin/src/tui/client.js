// Talks to the worker thread: request/response by id, a timeout, and a fresh worker after a crash.
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./worker.js", import.meta.url);

export function createClient({ createWorker, timeoutMs = 20_000, workerData } = {}) {
  const make = createWorker || (() => new Worker(WORKER_URL, { workerData }));
  let worker = null;
  let seq = 0;
  const pending = new Map();

  const settle = (id, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  };
  const failAll = (code, message) => {
    for (const id of [...pending.keys()]) settle(id, { ok: false, code, message });
  };
  const drop = () => {
    const w = worker;
    worker = null;
    try {
      w?.terminate?.();
    } catch {
      // already gone
    }
  };

  function ensure() {
    if (worker) return worker;
    const w = make();
    worker = w;
    w.on("message", (m) => settle(m.id, m));
    w.on("error", (e) => {
      failAll("worker", String(e?.message || e));
      if (worker === w) drop();
    });
    w.on("exit", () => {
      failAll("worker", "worker exited");
      if (worker === w) worker = null;
    });
    w.unref?.();
    return w;
  }

  return {
    summary(session) {
      return new Promise((resolve) => {
        let w;
        try {
          w = ensure();
        } catch (e) {
          resolve({ ok: false, code: "worker", message: String(e?.message || e) });
          return;
        }
        const id = ++seq;
        const timer = setTimeout(() => {
          settle(id, { ok: false, code: "worker", message: "timed out" });
          drop(); // a stuck worker is replaced on the next request
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, timer });
        w.postMessage({ id, session });
      });
    },
    close() {
      failAll("worker", "closed");
      drop();
    },
  };
}
