#!/usr/bin/env node
'use strict';
// Compare the dashboard API of the Node UI server (`lpa ui`) with the Python one (`lprism dashboard`),
// both running on the same machine's sessions:
//   node npm/parity/api_compare.js http://127.0.0.1:<python port> http://127.0.0.1:<node port>
const [py, js] = process.argv.slice(2);
const VOLATILE = new Set(['pending', 'resume_command', 'version', 'ui', 'size_bytes', 'path', 'ended_at', 'fetched_at']);

async function get(base, p) {
  const res = await fetch(base + p);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

function diff(a, b, where, out) {
  if (out.length > 8) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-6 + 1e-9 * Math.abs(a)) out.push(`${where}: py=${a} js=${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b && !(a == null && b == null)) out.push(`${where}: py=${JSON.stringify(a)?.slice(0, 100)} js=${JSON.stringify(b)?.slice(0, 100)}`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${where}: length py=${a.length} js=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${where}[${i}]`, out);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!VOLATILE.has(k)) diff(a[k], b[k], `${where}.${k}`, out);
}

(async () => {
  // Let both indexes finish (Python indexes within a time budget per request).
  for (let i = 0; i < 60; i++) {
    const a = (await get(py, '/api/sessions?limit=2000')).body;
    const b = (await get(js, '/api/sessions?limit=2000')).body;
    if (!a.pending && !b.pending) break;
  }
  const list = (await get(py, '/api/sessions?limit=2000')).body.sessions;
  // Sessions still being written change between the two reads: leave out the ones active in the last 10 minutes.
  const settled = list.filter((s) => Date.now() - Date.parse(s.ended_at || s.started_at || 0) > 10 * 60_000);
  const pick = [];
  const per = new Map();
  for (const s of settled) {
    const n = per.get(s.agent) || 0;
    if (n < 4) {
      pick.push(s);
      per.set(s.agent, n + 1);
    }
  }
  const paths = ['/api/health', '/api/sessions/projects', '/api/sessions/cost/overview?days=30', '/api/sessions/cost/overview?days=0', '/api/sessions/optimize?days=30', '/api/sessions/optimize/settings'];
  for (const s of pick) {
    const id = encodeURIComponent(s.id);
    paths.push(`/api/sessions/${id}`, `/api/sessions/${id}/trajectory`, `/api/sessions/${id}/timing`, `/api/sessions/${id}/cost`,
      `/api/sessions/${id}/context`, `/api/sessions/${id}/context/0`, `/api/sessions/${id}/events?offset=0&limit=80&preview=200`,
      `/api/sessions/${id}/events/0`, `/api/sessions/${id}/agents`, `/api/sessions/${id}/export.md`,
      `/api/sessions/${id}/events?kinds=tool_call,tool_result&q=a&limit=20`);
  }
  paths.push('/api/sessions?q=test&limit=20', '/api/sessions/not-a-session', '/api/sessions/x/events/99999');
  let bad = 0;
  for (const p of paths) {
    const [a, b] = await Promise.all([get(py, p), get(js, p)]);
    const out = [];
    if (a.status !== b.status) out.push(`status py=${a.status} js=${b.status}`);
    else if (a.status === 200) diff(a.body, b.body, '', out);
    if (out.length) {
      bad += 1;
      if (bad <= 12) console.log(`✗ ${p}\n  ${out.join('\n  ')}`);
    }
  }
  const all = (await get(py, '/api/sessions?limit=2000')).body;
  const alljs = (await get(js, '/api/sessions?limit=2000')).body;
  const out = [];
  diff(all.sessions.filter((s) => settled.some((x) => x.id === s.id)), alljs.sessions.filter((s) => settled.some((x) => x.id === s.id)), 'list', out);
  if (out.length) {
    bad += 1;
    console.log(`✗ session list\n  ${out.join('\n  ')}`);
  }
  console.log(`\n${paths.length + 1 - bad}/${paths.length + 1} responses identical (${pick.length} sessions: ${[...per].map(([a, n]) => `${a} ${n}`).join(', ')})`);
  process.exit(bad ? 1 : 0);
})();
