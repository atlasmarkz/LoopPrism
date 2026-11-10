"""The proxy passes ``text/event-stream`` answers on as they arrive.

A buffered SSE answer never reaches the client while the stream stays open,
which breaks the GET event stream of both the older HTTP+SSE transport and
Streamable HTTP. ``TestClient`` buffers whole responses, so these tests run
the proxy app for real under uvicorn and talk to it over sockets.
"""

import asyncio
import json
import queue
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
import uvicorn

from loopprism.proxy.server import ProxyServer
from loopprism.trace.collector import TraceCollector

# The proxy's read timeout in these tests; streams must outlive quiet spells
# longer than this.
READ_TIMEOUT = 1.0


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def event(data, name=None) -> bytes:
    head = f"event: {name}\n" if name else ""
    text = data if isinstance(data, str) else json.dumps(data)
    return f"{head}data: {text}\n\n".encode()


def answer(rid, text):
    return {"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}], "isError": False}}


class Backend:
    """A mock MCP server whose SSE streams the tests pace step by step."""

    def __init__(self):
        self.go = threading.Event()  # the test lets the second event out
        self.second_sent = threading.Event()
        self.upstream_closed = threading.Event()
        self.legacy_inbox: "queue.Queue[dict]" = queue.Queue()
        self.legacy_posts: list[str] = []
        backend = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def start_stream(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

            def emit(self, data: bytes):
                self.wfile.write(data)
                self.wfile.flush()

            def do_GET(self):
                if self.path == "/paced":
                    # One event, then (once allowed) a pause longer than the
                    # proxy's read timeout, then a second event.
                    self.start_stream()
                    self.emit(event({"n": 1}))
                    backend.go.wait(10)
                    time.sleep(READ_TIMEOUT * 1.5)
                    backend.second_sent.set()
                    self.emit(event({"n": 2}))
                elif self.path == "/silent":
                    # One event, then silence until the proxy hangs up.
                    self.start_stream()
                    self.emit(event({"n": 1}))
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        readable, _, _ = select.select([self.connection], [], [], 0.05)
                        if readable and not self.connection.recv(1, socket.MSG_PEEK):
                            backend.upstream_closed.set()
                            return
                elif self.path == "/sse":
                    # Older HTTP+SSE transport: an endpoint event, then the
                    # answers to what is POSTed there.
                    self.start_stream()
                    self.emit(event("/messages?sessionId=abc", "endpoint"))
                    try:
                        msg = backend.legacy_inbox.get(timeout=10)
                    except queue.Empty:
                        return
                    self.emit(event(answer(msg["id"], "legacy " + msg["params"]["name"]), "message"))
                else:
                    self.send_error(404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path.startswith("/messages"):
                    backend.legacy_posts.append(self.path)
                    backend.legacy_inbox.put(body)
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif self.path == "/mcp-sse":
                    # Streamable HTTP answering a call with SSE: a progress
                    # notification first, the result once allowed.
                    self.start_stream()
                    progress = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}
                    self.emit(event(progress, "message"))
                    backend.go.wait(10)
                    backend.second_sent.set()
                    self.emit(event(answer(body["id"], "streamed result"), "message"))
                elif self.path == "/mcp-json":
                    out = json.dumps(answer(body["id"], "plain result")).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                else:
                    self.send_error(404)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def backend():
    b = Backend()
    yield b
    b.go.set()
    b.server.shutdown()
    b.server.server_close()


@pytest.fixture
def proxy(db_path):
    """The proxy app (what ``lprism proxy`` serves) under uvicorn in a thread."""
    port = free_port()
    ready = threading.Event()
    state = {}

    async def run():
        collector = TraceCollector(db_path)
        await collector.initialize()
        async with ProxyServer(port=port, collector=collector) as proxy:
            proxy._client.timeout = httpx.Timeout(READ_TIMEOUT)
            server = uvicorn.Server(
                uvicorn.Config(proxy._app, host="127.0.0.1", port=port, log_level="warning", timeout_graceful_shutdown=2)
            )
            state["server"] = server
            task = asyncio.create_task(server.serve())
            while not server.started:
                await asyncio.sleep(0.02)
            ready.set()
            await task
        await collector.close()

    thread = threading.Thread(target=lambda: asyncio.run(run()), daemon=True)
    thread.start()
    assert ready.wait(10), "proxy did not start"
    yield f"http://127.0.0.1:{port}"
    state["server"].should_exit = True
    thread.join(10)


def data_lines(lines):
    for line in lines:
        if line.startswith("data:"):
            yield line[5:].strip()


async def finished_span(db_path, trace_id, timeout=5.0):
    """The span of a trace once it is finished (streams finish it at their end).

    A new span already has status 'ok' (the column default), so "finished" is
    read from latency_ms, which only finish_span() sets.
    """
    collector = TraceCollector(db_path)
    await collector.initialize()
    try:
        deadline = time.monotonic() + timeout
        while True:
            _, spans = await collector.get_trace(trace_id)
            if spans and spans[0]["latency_ms"] is not None:
                return spans[0]
            assert time.monotonic() < deadline, f"span not finished: {spans}"
            await asyncio.sleep(0.05)
    finally:
        await collector.close()


def test_events_arrive_as_they_are_sent(proxy, backend):
    url = f"{proxy}/srv/paced?backend={backend.url}"
    with httpx.stream("GET", url, headers={"Accept": "text/event-stream"}, timeout=10) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        events = data_lines(r.iter_lines())
        assert json.loads(next(events)) == {"n": 1}
        # The first event got here while the backend still holds the second.
        assert not backend.second_sent.is_set()
        backend.go.set()
        # The pause before it is longer than the read timeout.
        assert json.loads(next(events)) == {"n": 2}


def test_client_disconnect_closes_the_upstream_stream(proxy, backend):
    url = f"{proxy}/srv/silent?backend={backend.url}"
    with httpx.stream("GET", url, timeout=10) as r:
        assert json.loads(next(data_lines(r.iter_lines()))) == {"n": 1}
    assert backend.upstream_closed.wait(5), "the proxy kept the backend stream open"


async def test_traced_sse_call_streams_and_is_recorded(proxy, backend, db_path):
    call = {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "slow", "arguments": {}}}
    # A blocking client is fine here: the proxy runs on its own loop.
    with httpx.stream("POST", f"{proxy}/srv/mcp-sse?backend={backend.url}", json=call, timeout=10) as r:
        assert r.status_code == 200
        trace_id = r.headers["x-loopprism-trace-id"]
        events = data_lines(r.iter_lines())
        first = json.loads(next(events))
        # The progress notification is not held back for the result.
        assert first["method"] == "notifications/progress"
        assert not backend.second_sent.is_set()
        backend.go.set()
        assert json.loads(next(events)) == answer(7, "streamed result")

    span = await finished_span(db_path, trace_id)
    assert span["status"] == "ok" and not span["result_is_error"]
    assert span["tool_name"] == "slow"
    assert "streamed result" in span["result_content_preview"]


async def test_traced_sse_call_abandoned_by_the_client(proxy, backend, db_path):
    call = {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "slow", "arguments": {}}}
    with httpx.stream("POST", f"{proxy}/srv/mcp-sse?backend={backend.url}", json=call, timeout=10) as r:
        trace_id = r.headers["x-loopprism-trace-id"]
        next(data_lines(r.iter_lines()))  # progress only, then hang up
    span = await finished_span(db_path, trace_id)
    assert span["status"] == "error" and span["result_is_error"]
    assert "disconnected" in json.loads(span["attributes_json"])["error"]


async def test_plain_json_call_is_unchanged(proxy, backend, db_path):
    call = {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "quick", "arguments": {}}}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{proxy}/srv/mcp-json?backend={backend.url}", json=call)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/json"
    assert r.headers["content-length"] == str(len(r.content))
    assert r.json() == answer(8, "plain result")
    span = await finished_span(db_path, r.headers["x-loopprism-trace-id"])
    assert span["status"] == "ok"
    assert "plain result" in span["result_content_preview"]


def test_legacy_sse_transport_round_trip(proxy, backend):
    """GET stream gives the endpoint event; a POST to /<name>/messages reaches it.

    Note the endpoint event is passed on unchanged: a stock client resolves
    ``/messages?...`` against the proxy's root, not ``/<name>/messages``.
    """
    with httpx.Client(timeout=10) as client:
        with client.stream("GET", f"{proxy}/srv/sse?backend={backend.url}") as stream:
            lines = stream.iter_lines()
            assert next(lines) == "event: endpoint"
            assert next(lines) == "data: /messages?sessionId=abc"
            call = {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "old", "arguments": {}}}
            posted = client.post(f"{proxy}/srv/messages?sessionId=abc", json=call)
            assert posted.status_code == 202
            assert backend.legacy_posts == ["/messages?sessionId=abc"]
            assert json.loads(next(data_lines(lines))) == answer(9, "legacy old")
