"""SSRF protection for outbound crawler requests.

Two layers:

1. `validate_url` - cheap pre-check of scheme/port/host before a URL is queued or requested.
2. `GuardedNetworkBackend` - enforced at TCP connect time: the hostname is resolved once,
   every resolved address must be public, and the socket connects to that exact validated
   IP. This defeats DNS rebinding (a check-then-connect race) and applies to every request
   the client makes, including each redirect hop. TLS still uses the original hostname for
   SNI and certificate verification.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

import httpcore
import httpx

Resolver = Callable[[str, int], list[str]]

ALLOWED_SCHEMES = frozenset({"http", "https"})
_BLOCKED_HOSTNAMES = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
    }
)
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa")


class SSRFError(ValueError):
    """Raised when a URL or resolved address is not allowed to be requested."""


def default_resolver(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFError(f"Cannot resolve host {host!r}") from exc
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def check_ip(address: str) -> None:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError as exc:
        raise SSRFError(f"Invalid IP address {address!r}") from exc
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    # is_global is False for private, loopback, link-local (incl. 169.254.169.254 metadata),
    # CGNAT, documentation, benchmarking and other special-purpose ranges.
    if (
        not ip.is_global
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_private
        or ip.is_unspecified
    ):
        raise SSRFError(f"Address {ip} is not a public address")


def check_hostname(host: str) -> None:
    name = host.strip().rstrip(".").lower()
    if not name:
        raise SSRFError("Empty host")
    if name in _BLOCKED_HOSTNAMES or name.endswith(_BLOCKED_SUFFIXES):
        raise SSRFError(f"Host {host!r} is not allowed")
    try:
        ipaddress.ip_address(name.strip("[]"))
    except ValueError:
        return
    check_ip(name.strip("[]"))  # literal IP in the URL


def validate_url(url: str, *, allowed_ports: Iterable[int] = (80, 443)) -> None:
    """Static checks (no DNS). Raises SSRFError."""
    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise SSRFError(f"Unsupported scheme {parts.scheme!r}")
    if parts.username or parts.password:
        raise SSRFError("Credentials in URLs are not allowed")
    if not parts.hostname:
        raise SSRFError("URL has no host")
    try:
        port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise SSRFError("Invalid port") from exc
    if port not in set(allowed_ports):
        raise SSRFError(f"Port {port} is not allowed")
    check_hostname(parts.hostname)


def resolve_public(host: str, port: int, resolver: Resolver = default_resolver) -> list[str]:
    """Resolve and require *every* address to be public (a single private answer blocks)."""
    check_hostname(host)
    addresses = resolver(host, port)
    if not addresses:
        raise SSRFError(f"Host {host!r} did not resolve")
    for address in addresses:
        check_ip(address)
    return addresses


class GuardedNetworkBackend(httpcore.NetworkBackend):
    def __init__(
        self,
        resolver: Resolver = default_resolver,
        inner: httpcore.NetworkBackend | None = None,
        allowed_ports: Iterable[int] = (80, 443),
    ) -> None:
        self._resolver = resolver
        self._inner = inner or httpcore.SyncBackend()
        self._allowed_ports = frozenset(allowed_ports)

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.NetworkStream:
        if port not in self._allowed_ports:
            raise httpcore.ConnectError(f"SSRF protection: port {port} is not allowed")
        try:
            addresses = resolve_public(host, port, self._resolver)
        except SSRFError as exc:
            raise httpcore.ConnectError(f"SSRF protection: {exc}") from exc
        last_error: Exception | None = None
        for address in addresses:
            try:
                return self._inner.connect_tcp(
                    address,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except httpcore.ConnectError as exc:
                last_error = exc
        raise httpcore.ConnectError(str(last_error or "connection failed"))

    def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        raise httpcore.ConnectError("SSRF protection: unix sockets are not allowed")

    def sleep(self, seconds: float) -> None:
        self._inner.sleep(seconds)


class GuardedHTTPTransport(httpx.HTTPTransport):
    """httpx transport whose connection pool uses `GuardedNetworkBackend`. Never proxied."""

    def __init__(
        self,
        *,
        resolver: Resolver = default_resolver,
        allowed_ports: Iterable[int] = (80, 443),
    ) -> None:
        super().__init__(trust_env=False)
        # httpx does not expose `network_backend`; build the (public) httpcore pool ourselves.
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(trust_env=False),
            max_connections=10,
            max_keepalive_connections=5,
            network_backend=GuardedNetworkBackend(resolver, allowed_ports=allowed_ports),
        )


def is_ssrf_block(exc: BaseException) -> bool:
    return "SSRF protection" in str(exc)
