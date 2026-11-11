// Manual end-to-end helper: one local server that plays both LoopPrism's ingest endpoint and a
// DeepSeek "Messages" API, so a real `dsh` run can be checked without keys or network.
//
//   node mock-server.mjs <capture-file>      (listens on 127.0.0.1:18080)
//
// The model "asks" for loopprism_cost_overview on its first step and says "Done" afterwards. Every
// request is appended to <capture-file> as one JSON line. See docs/dsh-plugin-exploration.md.
import http from 'node:http';
import fs from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node mock-server.mjs <capture-file>');

const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}
const text = (value) => [['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }], ['message_stop', {}]];
const toolUse = (name, input) => [['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }], ['message_stop', {}]];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    const tools = (parsed.tools || []).map((t) => t.name);
    const last = (parsed.messages || []).at(-1);
    const afterTool = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
    const record = { method: req.method, url: req.url, tools: tools.filter((n) => n.startsWith('loopprism')), toolCount: tools.length };
    if (req.url.startsWith('/api/ingest/events')) record.event = parsed.events?.[0];
    if (afterTool) record.toolResult = JSON.stringify(last.content.find((c) => c.type === 'tool_result')).slice(0, 400);
    fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
    if (req.url.startsWith('/api/ingest/events')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url.startsWith('/v1/messages')) return sse(res, tools.length === 0 || afterTool ? text('Done') : toolUse('loopprism_cost_overview', { days: 7 }));
    res.writeHead(404); res.end();
  });
}).listen(18080, '127.0.0.1');
