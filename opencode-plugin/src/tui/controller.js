// State and refresh logic of the sidebar card, kept free of JSX so it can be tested with a fake context.
//
// - One card per root session (a sub-agent's sidebar shows its parent's card: LoopPrism lists sub-agents
//   as part of the root session).
// - A card is read when the sidebar first shows a session and again when a turn ends (or a compaction
//   finishes), never while the model streams.
// - Reads are throttled per session: at most one every `throttleMs`, one at a time, extra requests
//   collapse into one trailing read.
// - The read itself runs in a worker thread (client.js), so a large session cannot stall the TUI.
import { buildCard, emptyCard } from "./card.js";
import { createClient } from "./client.js";

/** Events after which the numbers changed. Payload: `event.data.sessionID`. */
export const REFRESH_EVENTS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.ended",
];

export function createController(ctx, opts = {}) {
  const {
    client = createClient(),
    throttleMs = 5_000,
    // OpenCode writes the finished turn to its database around the event: wait a moment before reading
    settleMs = 800,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  } = opts;

  const [store, set] = ctx.storage.memory("loopprism.sidebar", { initial: { cards: {} } });
  const jobs = new Map(); // root session -> { last, running, dirty, timer }
  let closed = false;

  const rootOf = (sessionID) => {
    try {
      return ctx.data.session.root(sessionID) || sessionID;
    } catch {
      return sessionID;
    }
  };

  const put = (root, card) =>
    set((draft) => {
      draft.cards[root] = card;
    });

  async function run(root, job) {
    job.running = true;
    job.last = now();
    let res;
    try {
      res = await client.summary(root);
    } catch (e) {
      res = { ok: false, code: "error", message: String(e?.message || e) };
    }
    job.running = false;
    if (closed) return;
    if (res.ok) put(root, buildCard(res.summary));
    else if (res.code === "not_found" || !store.cards[root] || store.cards[root].state !== "ready") put(root, emptyCard(res.code));
    // else: a transient failure keeps the last good card on screen
    if (job.dirty) {
      job.dirty = false;
      schedule(root, job, 0);
    }
  }

  function schedule(root, job, delay) {
    if (closed) return;
    if (job.running) {
      job.dirty = true;
      return;
    }
    const wait = Math.max(delay, job.last === undefined ? 0 : job.last + throttleMs - now());
    if (job.timer) return; // one trailing read is already planned
    job.timer = setTimer(() => {
      job.timer = undefined;
      void run(root, job);
    }, wait);
    job.timer?.unref?.();
  }

  /** Ask for a read of the session's card. `delay` waits for the database to catch up first. */
  function request(sessionID, delay = 0) {
    if (!sessionID || closed) return;
    const root = rootOf(sessionID);
    let job = jobs.get(root);
    if (!job) jobs.set(root, (job = {}));
    schedule(root, job, delay);
  }

  const offs = REFRESH_EVENTS.map((type) => ctx.data.on(type, (e) => request(e?.data?.sessionID, settleMs)));

  return {
    /** Called by the slot when it renders: the first call for a session starts the first read. */
    ensure(sessionID) {
      if (!sessionID || closed) return;
      if (!jobs.has(rootOf(sessionID))) request(sessionID);
    },
    /** The card to draw (reactive: reads the Solid store). */
    card(sessionID) {
      return store.cards[rootOf(sessionID)] || emptyCard(null, true);
    },
    request,
    dispose() {
      closed = true;
      for (const off of offs) {
        try {
          off();
        } catch {
          // already unsubscribed
        }
      }
      for (const job of jobs.values()) if (job.timer) clearTimer(job.timer);
      client.close();
    },
  };
}
