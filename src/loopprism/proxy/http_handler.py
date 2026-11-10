"""HTTP handler for MCP proxy interception.

Transparently proxies MCP JSON-RPC traffic, intercepts requests/responses,
extracts tracing metadata, and forwards to the real MCP server.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode

import anyio
import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

from ..trace.collector import TraceCollector
from ..trace.correlation import SESSION, Correlation, RunCorrelator
from ..trace.mcp_semantics import MCPProtocol, ParsedMCPRequest
from ..utils.logging import logger


def backend_target(backend_url: str, path: str, query: str = "") -> str:
    """Where a request to ``/<server>[/rest][?query]`` goes on the backend.

    The first path segment only picks the backend, so it is dropped:
    ``/github`` goes to the backend URL itself and ``/github/messages`` to
    ``<backend>/messages``. The query is kept (the legacy SSE transport puts
    its session id there), except ``backend``, which only names the backend.
    """
    rest = path.strip("/").partition("/")[2]
    url = backend_url.rstrip("/") + "/" + rest if rest else backend_url
    params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != "backend"]
    if params:
        url += ("&" if "?" in url else "?") + urlencode(params)
    return url


# Called once a streamed answer ends: (bytes that passed, error or None).
StreamEnd = Callable[[bytes, Optional[str]], Awaitable[None]]


def is_event_stream(content_type: str) -> bool:
    """Whether a response is an SSE stream, which is passed on as it arrives."""
    return (content_type or "").split(";")[0].strip().lower() == "text/event-stream"


def _sse_messages(text: str) -> list[Any]:
    """JSON payloads of the events in a ``text/event-stream`` body."""
    messages: list[Any] = []
    data: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") + [""]:
        if line == "":
            if data:
                try:
                    messages.append(json.loads("\n".join(data)))
                except json.JSONDecodeError:
                    pass
                data = []
        elif line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    return messages


def decode_response(body: bytes, content_type: str, request_id: Any = None) -> Optional[Any]:
    """The JSON-RPC answer in a backend response, or ``None`` when there is none.

    Streamable HTTP servers may answer with an SSE stream that carries
    notifications before the response; the response is the message whose
    ``id`` matches the request (else the last one with a result or error).
    Bodies that are neither JSON nor SSE (an HTML error page, say) give ``None``.
    """
    if not body:
        return None
    text = body.decode("utf-8", errors="replace")
    if "text/event-stream" in (content_type or "").lower():
        answers = [m for m in _sse_messages(text) if isinstance(m, dict) and ("result" in m or "error" in m)]
        for m in answers:
            if request_id is not None and m.get("id") == request_id:
                return m
        return answers[-1] if answers else None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


class MCPHttpHandler:
    """Intercepts MCP HTTP requests, traces them, and forwards to backend."""

    def __init__(
        self,
        collector: TraceCollector,
        client: Optional[httpx.AsyncClient] = None,
        correlator: Optional[RunCorrelator] = None,
    ) -> None:
        self.collector = collector
        self.correlator = correlator or RunCorrelator()
        self._client = client
        self._own_client = False

    async def _get_client(self) -> httpx.AsyncClient:
        """Lazily create or return the shared httpx client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(120.0),
                follow_redirects=True,
            )
            self._own_client = True
        return self._client

    async def close(self) -> None:
        """Close the HTTP client if we own it."""
        if self._own_client and self._client:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------
    # Main handler entry point
    # ------------------------------------------------------------------

    async def handle(
        self,
        request: Request,
        server_name: str,
        backend_url: str,
    ) -> Response:
        """Handle an incoming proxy request.

        Args:
            request: The Starlette request from the client.
            server_name: The logical MCP server name (from URL path).
            backend_url: The real MCP server URL to forward to.

        Returns:
            The proxied response (JSON-RPC or streaming).
        """
        # Read body
        body_bytes = await request.body()

        # Parse JSON-RPC body
        try:
            body = json.loads(body_bytes) if body_bytes else {}
        except json.JSONDecodeError:
            # Not JSON — just forward without tracing
            return await self._forward(request, backend_url, body_bytes)

        # Parse MCP semantics
        parsed = MCPProtocol.parse(body)

        if not parsed.is_mcp or not parsed.should_trace:
            # Not an MCP call we care about — forward transparently
            return await self._forward(request, backend_url, body_bytes)

        # --- Traceable MCP call ---
        return await self._handle_traced(
            request=request,
            body=body,
            body_bytes=body_bytes,
            parsed=parsed,
            server_name=server_name,
            backend_url=backend_url,
        )

    # ------------------------------------------------------------------
    # Traced handling
    # ------------------------------------------------------------------

    async def _handle_traced(
        self,
        request: Request,
        body: dict,
        body_bytes: bytes,
        parsed: ParsedMCPRequest,
        server_name: str,
        backend_url: str,
    ) -> Response:
        """Handle a traceable MCP request with span creation."""

        # Decide which run this request belongs to
        correlation = self.correlator.resolve(
            headers=request.headers,
            body=body,
            server_name=server_name,
            client=request.client.host if request.client else None,
            method=parsed.method,
        )
        trace_id = correlation.trace_id

        # Ensure trace exists
        await self._ensure_trace(correlation, parsed)
        if correlation.session_id:
            # The run may have been opened earlier without a session id.
            await self.collector.tag_run(
                trace_id,
                session_id=correlation.session_id,
                correlation_source=correlation.source,
            )

        attributes = {
            "backend_url": backend_url,
            "user_agent": request.headers.get("user-agent", ""),
        }
        if correlation.remote_parent_span_id:
            # Kept out of parent_span_id: that span lives in the caller's
            # tracer, not in this run, and would orphan this span in the UI.
            attributes["remote_parent_span_id"] = correlation.remote_parent_span_id

        # Start span
        span_id = await self.collector.start_span(
            trace_id=trace_id,
            span_type=parsed.span_type or "mcp.generic",
            mcp_server_name=server_name,
            mcp_transport="http",
            mcp_request_method=parsed.method,
            mcp_request_id=str(parsed.request_id) if parsed.request_id else None,
            tool_name=parsed.tool_name,
            tool_arguments=parsed.tool_arguments,
            tool_call_id=parsed.tool_call_id,
            attributes=attributes,
        )

        # Forward and measure
        start = time.monotonic()
        response: Optional[Response] = None

        async def stream_ended(body: bytes, error: Optional[str]) -> None:
            # A streamed answer is recorded once all of it has gone through.
            assert response is not None
            await self._finish_span(
                response, parsed, trace_id, span_id,
                (time.monotonic() - start) * 1000, body, error,
            )

        try:
            response = await self._forward(
                request, backend_url, body_bytes, on_stream_end=stream_ended
            )
        except Exception as exc:
            latency = (time.monotonic() - start) * 1000
            await self.collector.finish_span(
                span_id=span_id,
                latency_ms=latency,
                result_is_error=True,
                status="error",
                attributes={"error": str(exc)},
            )
            await self.collector.finalize_trace(trace_id)
            raise

        latency = (time.monotonic() - start) * 1000

        # The backend's answer goes back to the client whatever happens to
        # the bookkeeping below: a tracing problem must never break a call.
        try:
            await self._bind_issued_session(response, correlation, server_name, trace_id)
            if not isinstance(response, StreamingResponse):
                await self._finish_span(
                    response, parsed, trace_id, span_id, latency, response.body
                )
        except Exception:
            logger.exception("Could not record the response of %s on %s", parsed.method, server_name)

        response.headers["X-LoopPrism-Trace-Id"] = trace_id
        return response

    async def _bind_issued_session(
        self,
        response: Response,
        correlation: Correlation,
        server_name: str,
        trace_id: str,
    ) -> None:
        """Join follow-up requests to this run once the server names a session."""
        # initialize has no session header yet; the server assigns one in its
        # response. Bind it so follow-up requests join this run.
        issued_session = response.headers.get("mcp-session-id")
        if issued_session and not correlation.session_id:
            self.correlator.bind_session(server_name, issued_session, correlation)
            await self.collector.tag_run(
                trace_id, session_id=issued_session, correlation_source=SESSION
            )

    async def _finish_span(
        self,
        response: Response,
        parsed: ParsedMCPRequest,
        trace_id: str,
        span_id: str,
        latency: float,
        body_bytes: bytes,
        error: Optional[str] = None,
    ) -> None:
        """Finish the span from the backend's answer (JSON, SSE or anything else).

        ``error`` is set when a streamed answer broke off before its end.
        """
        body_bytes = body_bytes or b""
        answer = decode_response(body_bytes, response.headers.get("content-type", ""), parsed.request_id)
        meta = MCPProtocol.parse_response(answer, parsed.span_type) if isinstance(answer, dict) else {}
        result_is_error = bool(meta.pop("result_is_error", False))
        if response.status_code >= 400:
            # An HTTP failure (a 404 page, a 502 from a gateway) is an error
            # even when its body is not a JSON-RPC error.
            result_is_error = True
            meta.setdefault("http_status", response.status_code)
        if error and answer is None:
            # The stream broke off before the answer came. Once the answer is
            # in, a dropped connection afterwards changes nothing.
            result_is_error = True
            meta.setdefault("error", error)

        await self.collector.finish_span(
            span_id=span_id,
            latency_ms=latency,
            result_content=answer,
            result_size_bytes=len(body_bytes),
            result_is_error=result_is_error,
            status="error" if result_is_error else "ok",
            attributes=meta,
        )
        await self.collector.finalize_trace(trace_id)

    # ------------------------------------------------------------------
    # Forwarding
    # ------------------------------------------------------------------

    async def _forward(
        self,
        request: Request,
        backend_url: str,
        body_bytes: bytes,
        on_stream_end: Optional[StreamEnd] = None,
    ) -> Response:
        """Forward a request to the backend MCP server.

        Copies method, headers (except host), and body. An SSE answer comes
        back as a StreamingResponse that relays events as they arrive, and
        ``on_stream_end`` gets its bytes once it ends. Anything else is read
        whole and returned as a Response.
        """
        client = await self._get_client()

        url = backend_target(backend_url, request.url.path, request.url.query)

        # Forward headers (exclude host, transfer-encoding)
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower()
            not in ("host", "transfer-encoding", "content-length")
        }

        backend_req = client.build_request(
            method=request.method,
            url=url,
            headers=headers,
            content=body_bytes or None,
        )
        try:
            backend_resp = await client.send(backend_req, stream=True)
        except httpx.RequestError as exc:
            return self._unreachable(request.method, url, exc)

        # Build response
        response_headers = {
            k: v
            for k, v in backend_resp.headers.items()
            if k.lower() not in ("transfer-encoding", "content-encoding")
        }

        content_type = backend_resp.headers.get(
            "content-type",
            "application/json",
        )

        if is_event_stream(content_type):
            # Pass the stream on as it arrives: a GET event stream may stay
            # open for as long as the session lasts, with quiet spells longer
            # than the read timeout. httpcore takes the read timeout when the
            # body starts (after this), so it is lifted for this response.
            sent = backend_resp.request  # the last one, after any redirect
            sent.extensions["timeout"] = {**sent.extensions.get("timeout", {}), "read": None}
            response_headers.pop("content-length", None)
            return StreamingResponse(
                self._relay(backend_resp, on_stream_end),
                status_code=backend_resp.status_code,
                headers=response_headers,
                media_type=content_type,
            )

        try:
            content = await backend_resp.aread()
        except httpx.RequestError as exc:
            return self._unreachable(request.method, url, exc)
        finally:
            await backend_resp.aclose()

        return Response(
            content=content,
            status_code=backend_resp.status_code,
            headers=response_headers,
            media_type=content_type,
        )

    @staticmethod
    def _unreachable(method: str, url: str, exc: Exception) -> JSONResponse:
        logger.error("Backend request failed: %s → %s: %s", method, url, exc)
        return JSONResponse(
            content={
                "jsonrpc": "2.0",
                "error": {
                    "code": -32603,
                    "message": f"Backend unreachable: {exc}",
                },
                "id": None,
            },
            status_code=502,
        )

    @staticmethod
    async def _relay(
        backend_resp: httpx.Response,
        on_end: Optional[StreamEnd],
    ) -> AsyncIterator[bytes]:
        """Yield an SSE body chunk by chunk, then close it and report it.

        Runs until the backend ends the stream or the client goes away (the
        generator is then cancelled or closed). The bytes are kept only when
        someone wants them at the end (a traced call).
        """
        collected = bytearray()
        error: Optional[str] = None
        try:
            async for chunk in backend_resp.aiter_bytes():
                if on_end is not None:
                    collected += chunk
                yield chunk
        except httpx.HTTPError as exc:
            # The backend dropped the stream: end ours cleanly rather than
            # failing the response half-way through.
            error = f"stream broke off: {exc!r}"
            logger.warning("Backend event stream ended early: %r", exc)
        except BaseException:
            # Cancelled or closed: the client went away mid-stream.
            error = "client disconnected before the stream ended"
            raise
        finally:
            # Also runs when the client disconnects, as a cancellation, so it
            # is shielded: the upstream connection must be released and the
            # span finished either way.
            with anyio.CancelScope(shield=True):
                await backend_resp.aclose()
                if on_end is not None:
                    try:
                        await on_end(bytes(collected), error)
                    except Exception:
                        logger.exception("Could not record a streamed response")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _ensure_trace(
        self,
        correlation: Correlation,
        parsed: ParsedMCPRequest,
    ) -> None:
        """Ensure a trace record exists (idempotent)."""
        await self.collector.create_trace(
            trace_id=correlation.trace_id,
            session_id=correlation.session_id,
            correlation_source=correlation.source,
            root_span_type=(
                parsed.span_type.value if parsed.span_type else None
            ),
            root_span_name=parsed.tool_name or parsed.method or "mcp_call",
            exist_ok=True,
        )
