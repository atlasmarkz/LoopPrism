// The sidebar card as plain data: a list of lines, each with a tone the renderer maps to a theme colour.
// Pure functions, so they are testable without OpenTUI.
//
// Tones: "title" | "base" | "muted" | "warn" | "error".

export function usd(x) {
  if (x === null || x === undefined) return "n/a";
  if (x > 0 && x < 0.01) return "<$0.01";
  return `$${x.toFixed(2)}`;
}

export function tok(n) {
  if (n === null || n === undefined) return "n/a";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

const line = (text, tone = "base") => ({ text, tone });

/** The context line: "ctx 45k / 200k  23%". A window LoopPrism only guessed is marked with "~". */
export function contextLine(d) {
  if (!d.context) return line("ctx n/a", "muted");
  if (!d.window) return line(`ctx ${tok(d.context)}`);
  const assumed = d.windowSource !== "reported";
  const win = `${assumed ? "~" : ""}${tok(d.window)}`;
  // a guessed window the real context already exceeds says nothing useful as a percentage
  if (d.context > d.window) return line(`ctx ${tok(d.context)} / ${win}`, assumed ? "base" : "error");
  const pct = Math.round((100 * d.context) / d.window);
  return line(`ctx ${tok(d.context)} / ${win}  ${pct}%`, pct >= 85 && !assumed ? "warn" : "base");
}

/** @param d what `slim()` returns */
export function buildCard(d) {
  const lines = [line("LoopPrism", "title")];
  let cost = usd(d.costUsd);
  if (d.costUsd !== null && d.costUsd !== undefined && d.unpricedSteps) cost += "+";
  lines.push(line(`${cost}  ${d.steps} step${d.steps === 1 ? "" : "s"}`));
  if (d.subagentUsd) lines.push(line(`+ ${usd(d.subagentUsd)} subagents`, "muted"));
  lines.push(contextLine(d));
  lines.push(line(d.cachePct === null || d.cachePct === undefined ? "cache n/a" : `cache hit ${Math.round(d.cachePct)}%`, "muted"));

  const by = Object.fromEntries((d.findings || []).map((f) => [f.kind, f]));
  const rep = by.repeated_call;
  const err = by.error_streak;
  const comp = by.compaction;
  if (rep) lines.push(line(`! ${rep.count} repeated call${rep.count === 1 ? "" : "s"} (worst ${rep.worst}x)`, "warn"));
  if (err) lines.push(line(`x ${err.count} error streak${err.count === 1 ? "" : "s"} (longest ${err.worst})`, "error"));
  if (comp) lines.push(line(`~ compacted ${comp.count}x`, "muted"));
  if (!rep && !err && !comp) lines.push(line("no loops or error streaks", "muted"));
  return { state: "ready", lines };
}

const REASONS = {
  not_found: "no data for this session yet",
  missing: "loopprism package not found",
  sqlite: "needs Node 22+ (node:sqlite)",
  worker: "reader stopped, will retry",
  error: "could not read the session",
};

/** One quiet line for "nothing to show". */
export function emptyCard(code, loading = false) {
  if (loading) return { state: "loading", lines: [line("LoopPrism", "title"), line("reading session...", "muted")] };
  return {
    state: code === "not_found" ? "empty" : "error",
    lines: [line("LoopPrism", "title"), line(REASONS[code] || REASONS.error, "muted")],
  };
}
