"""Tell requests from this machine apart from requests a web page makes.

LoopPrism's servers listen on 127.0.0.1, but that alone does not keep web
pages out: any site the user visits can make the browser send requests to
localhost, and a DNS-rebinding domain can even read the answers. So every
request must also carry

- a loopback ``Host`` (a rebinding domain arrives with its own name), and
- no ``Sec-Fetch-Site: cross-site`` (sent by browsers even on requests that
  carry no ``Origin``, such as a cross-site ``<img>`` or ``no-cors`` GET), and
- when a browser sends an ``Origin``, an allowed one: the same origin by
  default, or any loopback origin where local browser tools must get through.

Hooks, MCP clients and the desktop app are plain processes: they send a
loopback ``Host`` and none of the browser headers, so they always pass.
"""

from __future__ import annotations

from typing import Mapping, Optional
from urllib.parse import urlparse

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _hostname(netloc: str) -> Optional[str]:
    try:
        return urlparse(f"//{netloc}").hostname
    except ValueError:
        return None


def foreign_request(
    headers: Mapping[str, str],
    *,
    loopback_origins: bool = False,
) -> Optional[str]:
    """Why a request must be refused, or ``None`` when it comes from this machine.

    ``loopback_origins`` also accepts browser pages served from another port on
    this machine (by default only the server's own origin is accepted).
    """
    host = headers.get("host") or ""
    if _hostname(host) not in LOOPBACK_HOSTS:
        return "Only available on this machine"
    if (headers.get("sec-fetch-site") or "").lower() == "cross-site":
        return "Cross-origin requests are not accepted"
    origin = headers.get("origin")
    if origin:
        try:
            parsed = urlparse(origin)
            allowed = parsed.hostname in LOOPBACK_HOSTS if loopback_origins else parsed.netloc == host
        except ValueError:
            allowed = False
        if not allowed:
            return "Cross-origin requests are not accepted"
    return None
