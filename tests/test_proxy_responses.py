"""The proxy passes every backend answer through and records it (issue #5).

Streamable HTTP servers often answer with ``text/event-stream``; error pages
are not JSON at all. Neither may turn into a 500 from the proxy.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.routing import Route
from starlette.testclient import TestClient

from loopprism.proxy.http_handler import MCPHttpHandler, decode_response

CALL = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "echo", "arguments": {}}}


def answer(rid, text="hi", is_error=False):
    return {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}}


def sse(*messages):
    return "".join(f"event: message\ndata: {json.dumps(m)}\n\n" for m in messages).encode()


class TestDecodeResponse:
    def test_json(self):
        assert decode_response(json.dumps(answer(7)).encode(), "application/json", 7) == answer(7)

    def test_sse_single_event(self):
        assert decode_response(sse(answer(7)), "text/event-stream", 7) == answer(7)

    def test_sse_skips_notifications_and_picks_the_matching_id(self):
        progress = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}
        body = sse(progress, answer(6, "other"), answer(7, "mine"))
        assert decode_response(body, "text/event-stream; charset=utf-8", 7)["result"]["content"][0]["text"] == "mine"

    def test_sse_crlf_and_multiline_data(self):
        body = b'data: {"jsonrpc": "2.0",\r\ndata:  "id": 7, "result": {}}\r\n\r\n'
        assert decode_response(body, "text/event-stream", 7) == {"jsonrpc": "2.0", "id": 7, "result": {}}

    def test_sse_without_an_answer(self):
        assert decode_response(b"event: ping\ndata: not json\n\n", "text/event-stream", 7) is None

    @pytest.mark.parametrize("body", [b"", b"<html>Not Found</html>", b"no route /mcp"])
    def test_empty_or_not_json(self, body):
        assert decode_response(body, "text/html", 7) is None


@pytest.fixture
def backend():
    """A backend whose reply is set per test: (status, content type, body)."""
    reply = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length") or 0))
            status, ctype, body = reply["value"]
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}", reply
    server.shutdown()


@pytest.fixture
def proxy(collector, backend):
    url, reply = backend
    handler = MCPHttpHandler(collector)

    async def endpoint(request: Request):
        return await handler.handle(request=request, server_name="srv", backend_url=url)

    app = Starlette(routes=[Route("/{path:path}", endpoint, methods=["POST"])])
    with TestClient(app) as client:
        yield client, reply


async def only_span(collector, response):
    _, spans = await collector.get_trace(response.headers["x-loopprism-trace-id"])
    (span,) = spans
    return span


class TestProxyPassesAnswersThrough:
    async def test_sse_answer(self, proxy, collector):
        client, reply = proxy
        body = sse(answer(7, "from sse"))
        reply["value"] = (200, "text/event-stream", body)
        r = client.post("/srv", json=CALL)
        assert r.status_code == 200
        assert r.content == body
        span = await only_span(collector, r)
        assert span["status"] == "ok" and not span["result_is_error"]
        assert "from sse" in span["result_content_preview"]

    async def test_sse_tool_error_is_recorded(self, proxy, collector):
        client, reply = proxy
        reply["value"] = (200, "text/event-stream", sse(answer(7, "boom", is_error=True)))
        r = client.post("/srv", json=CALL)
        assert r.status_code == 200
        span = await only_span(collector, r)
        assert span["status"] == "error" and span["result_is_error"]

    async def test_non_json_error_page_keeps_its_status(self, proxy, collector):
        client, reply = proxy
        reply["value"] = (404, "text/plain", b"no route /mcp/srv")
        r = client.post("/srv", json=CALL)
        assert r.status_code == 404
        assert r.text == "no route /mcp/srv"
        span = await only_span(collector, r)
        assert span["status"] == "error"
        assert json.loads(span["attributes_json"])["http_status"] == 404

    async def test_json_answer_unchanged(self, proxy, collector):
        client, reply = proxy
        reply["value"] = (200, "application/json", json.dumps(answer(7, "plain")).encode())
        r = client.post("/srv", json=CALL)
        assert r.json() == answer(7, "plain")
        span = await only_span(collector, r)
        assert span["status"] == "ok"
