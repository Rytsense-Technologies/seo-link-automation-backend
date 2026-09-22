"""HTTP fetching for the crawler: manual redirects, size limits, retries."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx

from app.crawler.ssrf import SSRFError, is_ssrf_block, validate_url

logger = logging.getLogger(__name__)

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


class FetchError(Exception):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class FetchResult:
    requested_url: str
    final_url: str
    status: int
    headers: httpx.Headers
    body: bytes
    # (url, status, location) for every redirect hop that was followed or stopped at.
    redirects: list[tuple[str, int, str]] = field(default_factory=list)
    # Set when a redirect pointed somewhere we must not follow (other host, robots, SSRF).
    blocked_redirect: str | None = None

    @property
    def content_type(self) -> str:
        value = str(self.headers.get("content-type", ""))
        return value.split(";")[0].strip().lower()

    @property
    def is_html(self) -> bool:
        return self.content_type in ("text/html", "application/xhtml+xml")

    def text(self) -> str:
        charset = None
        for part in self.headers.get("content-type", "").split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset":
                charset = value.strip("\"' ")
        try:
            return self.body.decode(charset or "utf-8", errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class FetcherConfig:
    user_agent: str
    max_retries: int = 2
    max_redirects: int = 5
    max_response_bytes: int = 5_000_000
    allowed_ports: tuple[int, ...] = (80, 443)
    max_retry_after_seconds: float = 10.0


class Fetcher:
    def __init__(
        self,
        client: httpx.Client,
        config: FetcherConfig,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = client
        self._config = config
        self._sleep = sleep

    def fetch(
        self,
        url: str,
        *,
        may_follow: Callable[[str], bool] = lambda _: True,
        accept: str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    ) -> FetchResult:
        """GET `url`, following redirects only to URLs accepted by `may_follow`."""
        redirects: list[tuple[str, int, str]] = []
        current = url
        for _ in range(self._config.max_redirects + 1):
            try:
                validate_url(current, allowed_ports=self._config.allowed_ports)
            except SSRFError as exc:
                raise FetchError(f"Blocked by SSRF protection: {exc}") from exc
            status, headers, body = self._get_with_retries(current, accept)
            location = headers.get("location")
            if status in REDIRECT_STATUSES and location:
                target = urljoin(current, location)
                redirects.append((current, status, target))
                blocked = False
                try:
                    validate_url(target, allowed_ports=self._config.allowed_ports)
                except SSRFError:
                    blocked = True
                if blocked or not may_follow(target):
                    return FetchResult(
                        url, current, status, headers, body, redirects, blocked_redirect=target
                    )
                current = target
                continue
            return FetchResult(url, current, status, headers, body, redirects)
        raise FetchError(f"Too many redirects (>{self._config.max_redirects})")

    def _get_with_retries(self, url: str, accept: str) -> tuple[int, httpx.Headers, bytes]:
        attempt = 0
        while True:
            retry_headers: httpx.Headers | None = None
            try:
                status, headers, body = self._get_once(url, accept)
            except httpx.TransportError as exc:
                if is_ssrf_block(exc):
                    raise FetchError(f"Blocked by SSRF protection: {exc}") from exc
                if attempt >= self._config.max_retries:
                    raise FetchError(f"{type(exc).__name__}: {exc}") from exc
                logger.info("Retrying %s after %s", url, type(exc).__name__)
            else:
                if status not in RETRY_STATUSES or attempt >= self._config.max_retries:
                    return status, headers, body
                retry_headers = headers
                logger.info("Retrying %s after HTTP %s", url, status)
            attempt += 1
            self._sleep(self._backoff(attempt, retry_headers))

    def _backoff(self, attempt: int, headers: httpx.Headers | None) -> float:
        retry_after = headers.get("retry-after") if headers is not None else None
        if retry_after and retry_after.strip().isdigit():
            return min(float(retry_after.strip()), self._config.max_retry_after_seconds)
        return min(2.0 ** (attempt - 1), self._config.max_retry_after_seconds)

    def _get_once(self, url: str, accept: str) -> tuple[int, httpx.Headers, bytes]:
        limit = self._config.max_response_bytes
        request_headers = {"User-Agent": self._config.user_agent, "Accept": accept}
        with self._client.stream(
            "GET", url, headers=request_headers, follow_redirects=False
        ) as response:
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise FetchError(
                    f"Response too large ({declared} bytes > {limit})", status=response.status_code
                )
            chunks: list[bytes] = []
            size = 0
            if response.status_code not in REDIRECT_STATUSES:
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > limit:
                        raise FetchError(
                            f"Response too large (> {limit} bytes)", status=response.status_code
                        )
                    chunks.append(chunk)
            return response.status_code, response.headers, b"".join(chunks)
