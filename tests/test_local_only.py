"""Only this machine may use the proxy and the trace API, never another web page."""

import pytest
from httpx import ASGITransport, AsyncClient

from loopprism.api.app import create_app
from loopprism.proxy.server import ProxyServer
from loopprism.utils.local_only import foreign_request

EVIL = "https://evil.example"
LOCAL = "127.0.0.1:4317"


class TestForeignRequest:
    @pytest.mark.parametrize("host", [LOCAL, "localhost:4317", "[::1]:4317", "127.0.0.1"])
    def test_plain_local_process_passes(self, host):
        assert foreign_request({"host": host}) is None

    @pytest.mark.parametrize("host", ["", "evil.example:4317", "192.168.1.5:4317", "[bad"])
    def test_foreign_or_missing_host_is_refused(self, host):
        assert foreign_request({"host": host})

    def test_cross_site_fetch_without_origin_is_refused(self):
        assert foreign_request({"host": LOCAL, "sec-fetch-site": "cross-site"})

    @pytest.mark.parametrize("site", ["same-origin", "same-site", "none"])
    def test_own_and_local_fetches_pass(self, site):
        assert foreign_request({"host": LOCAL, "sec-fetch-site": site}) is None

    def test_same_origin_only_by_default(self):
        assert foreign_request({"host": LOCAL, "origin": f"http://{LOCAL}"}) is None
        assert foreign_request({"host": LOCAL, "origin": "http://localhost:5173"})
        assert foreign_request({"host": LOCAL, "origin": EVIL})

    def test_loopback_origins_when_allowed(self):
        h = {"host": LOCAL}
        assert foreign_request({**h, "origin": "http://localhost:5173"}, loopback_origins=True) is None
        assert foreign_request({**h, "origin": EVIL}, loopback_origins=True)
        assert foreign_request({**h, "origin": "null"}, loopback_origins=True)


@pytest.fixture
async def proxy(collector):
    async with ProxyServer(host="127.0.0.1", port=4317, collector=collector) as server:
        transport = ASGITransport(app=server._app)
        async with AsyncClient(transport=transport, base_url=f"http://{LOCAL}") as client:
            yield server, client


class TestProxy:
    async def test_web_page_cannot_relay_through_the_proxy(self, proxy):
        # A page on another site naming an arbitrary backend: refused before
        # anything is forwarded, and nothing is registered.
        server, client = proxy
        r = await client.get("/x/secret.txt?backend=http://10.0.0.1", headers={"origin": EVIL})
        assert r.status_code == 403
        assert "access-control-allow-origin" not in r.headers
        assert server.backend_map == {}

    async def test_no_cors_fetch_is_refused(self, proxy):
        server, client = proxy
        r = await client.get("/x?backend=http://10.0.0.1", headers={"sec-fetch-site": "cross-site"})
        assert r.status_code == 403
        assert server.backend_map == {}

    async def test_dns_rebinding_host_is_refused(self, proxy):
        _, client = proxy
        r = await client.get("/__backends", headers={"host": "rebind.evil.example:4317"})
        assert r.status_code == 403

    async def test_local_page_gets_its_own_origin_not_a_wildcard(self, proxy):
        _, client = proxy
        r = await client.get("/health", headers={"origin": "http://localhost:6274"})
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "http://localhost:6274"

    async def test_plain_client_unchanged(self, proxy):
        _, client = proxy
        r = await client.get("/health")
        assert r.status_code == 200
        assert "access-control-allow-origin" not in r.headers


@pytest.fixture
async def api(collector):
    app = create_app(collector=collector, dashboard_enabled=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8080") as client:
        yield client


TRACE_ROUTES = ["/api/traces", "/api/mcp-servers", "/api/mcp-tools", "/api/cost/summary"]


class TestTraceApi:
    @pytest.mark.parametrize("path", TRACE_ROUTES)
    async def test_dns_rebinding_host_is_refused(self, api, path):
        r = await api.get(path, headers={"host": "rebind.evil.example:8080"})
        assert r.status_code == 403

    @pytest.mark.parametrize("path", TRACE_ROUTES)
    async def test_dashboard_on_same_origin_is_served(self, api, path):
        r = await api.get(path, headers={"origin": "http://127.0.0.1:8080"})
        assert r.status_code == 200

    async def test_other_site_cannot_clear_traces(self, api):
        r = await api.delete("/api/traces", headers={"origin": EVIL})
        assert r.status_code == 403

    async def test_health_stays_open(self, api):
        # The desktop app and `lpa` probe it; it reveals nothing.
        r = await api.get("/api/health", headers={"host": "rebind.evil.example:8080"})
        assert r.status_code == 200
