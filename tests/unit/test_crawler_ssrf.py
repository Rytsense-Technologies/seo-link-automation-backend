"""SSRF protection: static URL checks, DNS-resolution checks, connect-time enforcement."""

from __future__ import annotations

from typing import Any

import httpcore
import httpx
import pytest

from app.crawler.fetcher import Fetcher, FetcherConfig, FetchError
from app.crawler.ssrf import (
    GuardedHTTPTransport,
    GuardedNetworkBackend,
    SSRFError,
    check_ip,
    resolve_public,
    validate_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/",
        "http://LOCALHOST./admin",
        "http://app.localhost/",
        "http://printer.local/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://127.0.0.1/",
        "http://127.1.2.3/",
        "http://0.0.0.0/",
        "http://10.0.0.5/",
        "http://172.16.3.4/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://[fd00:ec2::254]/",
        "http://[::ffff:127.0.0.1]/",
        "http://224.0.0.1/",
        "ftp://example.com/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "https://user:pass@example.com/",
        "https://example.com:8080/",
        "https://example.com:22/",
    ],
)
def test_validate_url_blocks(url: str) -> None:
    with pytest.raises(SSRFError):
        validate_url(url)


@pytest.mark.parametrize(
    "url", ["https://rytsensetech.com/", "http://example.com/a?b=1", "https://93.184.216.34/"]
)
def test_validate_url_allows_public(url: str) -> None:
    validate_url(url)


def test_resolution_to_private_address_is_blocked() -> None:
    # DNS answers are checked, not just the hostname.
    with pytest.raises(SSRFError):
        resolve_public("innocent.example", 443, lambda h, p: ["10.1.2.3"])
    # A single private answer among public ones is enough to block.
    with pytest.raises(SSRFError):
        resolve_public("mixed.example", 443, lambda h, p: ["93.184.216.34", "127.0.0.1"])
    with pytest.raises(SSRFError):
        resolve_public("empty.example", 443, lambda h, p: [])
    assert resolve_public("ok.example", 443, lambda h, p: ["93.184.216.34"]) == ["93.184.216.34"]


def test_check_ip_rejects_invalid() -> None:
    with pytest.raises(SSRFError):
        check_ip("not-an-ip")


class _RecordingBackend(httpcore.NetworkBackend):
    def __init__(self) -> None:
        self.connected: list[tuple[str, int]] = []

    def connect_tcp(
        self, host: str, port: int, *args: Any, **kwargs: Any
    ) -> httpcore.NetworkStream:
        self.connected.append((host, port))
        raise httpcore.ConnectError("stop after recording")


def test_backend_connects_only_to_the_validated_ip() -> None:
    inner = _RecordingBackend()
    backend = GuardedNetworkBackend(lambda h, p: ["93.184.216.34"], inner=inner)
    with pytest.raises(httpcore.ConnectError):
        backend.connect_tcp("example.com", 443)
    # Connected to the resolved+validated IP, never re-resolving the name (no DNS rebinding).
    assert inner.connected == [("93.184.216.34", 443)]


def test_backend_blocks_private_resolution_before_connecting() -> None:
    inner = _RecordingBackend()
    backend = GuardedNetworkBackend(lambda h, p: ["192.168.0.10"], inner=inner)
    with pytest.raises(httpcore.ConnectError, match="SSRF protection"):
        backend.connect_tcp("rebind.example", 443)
    assert inner.connected == []
    with pytest.raises(httpcore.ConnectError, match="port"):
        backend.connect_tcp("example.com", 6379)
    with pytest.raises(httpcore.ConnectError):
        backend.connect_unix_socket("/var/run/docker.sock")


@pytest.mark.parametrize("url", ["http://127.0.0.1:80/", "http://localhost/", "http://[::1]/"])
def test_real_transport_refuses_internal_targets(url: str) -> None:
    """Guards against httpx internals changing: the production transport must enforce it."""
    with (
        httpx.Client(transport=GuardedHTTPTransport(), trust_env=False) as client,
        pytest.raises(httpx.ConnectError, match="SSRF protection"),
    ):
        client.get(url)


def test_fetcher_refuses_redirect_to_internal_address() -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/"})

    fetcher = Fetcher(
        httpx.Client(transport=httpx.MockTransport(handler)),
        FetcherConfig(user_agent="t"),
    )
    result = fetcher.fetch("https://example.com/go")
    assert result.blocked_redirect == "http://169.254.169.254/latest/"
    assert requested == ["https://example.com/go"]  # the metadata endpoint was never requested
    with pytest.raises(FetchError, match="SSRF"):
        fetcher.fetch("http://10.0.0.1/")
