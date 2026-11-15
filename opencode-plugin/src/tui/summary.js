// The part of LoopPrism's session summary the sidebar card needs. Runs in the worker thread, so only
// this small object crosses to the TUI thread.

/** Group LoopPrism findings by kind: how many, and how big the worst one is. */
function groupFindings(findings) {
  const by = new Map();
  for (const f of findings || []) {
    const size = Array.isArray(f.events) ? f.events.length : 0;
    const g = by.get(f.kind) || { kind: f.kind, count: 0, worst: 0, worstTitle: "" };
    g.count += 1;
    if (size >= g.worst) {
      g.worst = size;
      g.worstTitle = f.title || "";
    }
    by.set(f.kind, g);
  }
  return [...by.values()];
}

/** @param summary the result of `Inspector.summary()` */
export function slim(summary) {
  const s = summary?.stats || {};
  return {
    sessionId: summary?.session?.id,
    steps: s.steps ?? 0,
    costUsd: summary?.cost?.total_usd ?? s.cost_usd ?? null,
    subagentUsd: summary?.cost?.subagent_usd ?? s.subagent_cost_usd ?? null,
    unpricedSteps: summary?.cost?.unpriced_steps ?? 0,
    context: s.current_context ?? 0,
    window: s.window ?? null,
    windowSource: s.window_source ?? "unknown",
    cachePct: s.cache_hit_pct ?? null,
    models: s.models || [],
    findings: groupFindings(summary?.findings),
  };
}
