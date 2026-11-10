"""The server name picks the backend and is not forwarded to it (issue #6)."""

import pytest

from loopprism.proxy.http_handler import backend_target

MCP = "http://127.0.0.1:3000/mcp"


@pytest.mark.parametrize(
    "backend, path, query, expected",
    [
        (MCP, "/github", "", MCP),
        (MCP, "/github/", "", MCP),
        ("http://127.0.0.1:3000", "/github", "", "http://127.0.0.1:3000"),
        ("http://127.0.0.1:3000/", "/github/messages", "", "http://127.0.0.1:3000/messages"),
        (MCP, "/github/extra/path", "", MCP + "/extra/path"),
        # The legacy SSE transport keeps its session id in the query.
        ("http://h:1", "/srv/messages", "sessionId=abc", "http://h:1/messages?sessionId=abc"),
        # ?backend= only names the backend.
        (MCP, "/srv", "backend=http%3A%2F%2Fh%3A1%2Fmcp", MCP),
        (MCP, "/srv", "backend=x&a=1", MCP + "?a=1"),
        ("http://h:1/mcp?key=k", "/srv", "a=1", "http://h:1/mcp?key=k&a=1"),
    ],
)
def test_backend_target(backend, path, query, expected):
    assert backend_target(backend, path, query) == expected
