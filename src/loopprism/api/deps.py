"""Shared route dependencies."""

from __future__ import annotations

from fastapi import HTTPException, Request

from ..utils.local_only import foreign_request


def local_only(request: Request) -> None:
    """Refuse requests that do not come from this machine's own dashboard.

    Traces, tool calls, costs and sessions hold prompts, code and tool output,
    so other web pages must neither read them nor change them.
    """
    reason = foreign_request(request.headers)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
