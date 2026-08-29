from __future__ import annotations

import asyncio
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable
from urllib.parse import parse_qsl, unquote, urljoin, urlparse, urlunparse

import httpx


MAX_COVER_BYTES = 10 * 1024 * 1024
COVER_REF_TTL_SECONDS = 15 * 60
MAX_COVER_REFS = 512
MAX_COVER_REDIRECTS = 3
ALLOWED_COVER_CONTENT_TYPES = (
    "image/jpeg",
    "image/png",
    "image/webp",
)

_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_ALLOWED_COVER_HOSTS: dict[str, str] = {
    "munpia": "cdn1.munpia.com",
    "naver_series": "comicthumb-phinf.pstatic.net",
    "kakao_page": "page-images.kakaoentcdn.com",
    "novelpia": "images.novelpia.com",
    "ridi": "img.ridicdn.net",
}


class CoverDeliveryError(RuntimeError):
    pass


class UnsafeCoverUrlError(CoverDeliveryError):
    pass


class CoverTooLargeError(CoverDeliveryError):
    pass


class UnsupportedCoverImageError(CoverDeliveryError):
    pass


class CoverUpstreamError(CoverDeliveryError):
    pass


class CoverUpstreamTimeoutError(CoverUpstreamError):
    pass


@dataclass(frozen=True)
class CoverReference:
    platform: str
    platform_work_id: str
    url: str
    expires_at: float


@dataclass(frozen=True)
class DownloadedCover:
    content: bytes
    content_type: str


def validated_cover_url(platform: str, platform_work_id: str, value: str) -> str:
    allowed_host = _ALLOWED_COVER_HOSTS.get(platform)
    if not allowed_host or not platform_work_id:
        raise UnsafeCoverUrlError("지원하지 않는 표지 출처입니다.")
    if any(ord(character) < 32 or ord(character) == 127 for character in value) or "\\" in value:
        raise UnsafeCoverUrlError("표지 URL에 허용되지 않는 문자가 있습니다.")

    parsed = urlparse(value)
    host = (parsed.hostname or "").casefold().rstrip(".")
    try:
        port = parsed.port
    except ValueError as exc:
        raise UnsafeCoverUrlError("표지 URL의 포트가 올바르지 않습니다.") from exc

    if (
        parsed.scheme.casefold() != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
        or host != allowed_host
    ):
        raise UnsafeCoverUrlError("허용되지 않은 표지 URL입니다.")

    decoded_path = unquote(parsed.path)
    if any(segment in {".", ".."} for segment in decoded_path.split("/")):
        raise UnsafeCoverUrlError("표지 URL 경로가 올바르지 않습니다.")
    if len(parsed.query) > 2_048:
        raise UnsafeCoverUrlError("표지 URL query가 너무 깁니다.")

    if platform == "munpia" and not decoded_path.startswith("/files/attach/"):
        raise UnsafeCoverUrlError("문피아 표지 경로가 올바르지 않습니다.")
    if platform == "kakao_page":
        query = parse_qsl(parsed.query, keep_blank_values=True)
        if decoded_path != "/download/resource" or len(query) != 1 or query[0][0] != "kid" or not query[0][1]:
            raise UnsafeCoverUrlError("카카오페이지 표지 경로가 올바르지 않습니다.")
    if platform == "novelpia" and not decoded_path.startswith("/imagebox/cover/"):
        raise UnsafeCoverUrlError("노벨피아 표지 경로가 올바르지 않습니다.")
    if platform == "ridi":
        expected_path = rf"/cover/{re.escape(platform_work_id)}/xxlarge"
        if not re.fullmatch(expected_path, decoded_path) or parsed.query:
            raise UnsafeCoverUrlError("리디 표지 경로가 작품과 일치하지 않습니다.")

    # URL fragments are client-side only and must never influence the upstream request.
    return urlunparse(parsed._replace(fragment=""))


class CoverReferenceStore:
    def __init__(
        self,
        *,
        ttl_seconds: int = COVER_REF_TTL_SECONDS,
        max_entries: int = MAX_COVER_REFS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds <= 0 or max_entries <= 0:
            raise ValueError("Cover reference limits must be positive.")
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[str, CoverReference] = OrderedDict()

    def issue(self, platform: str, platform_work_id: str, cover_url: str) -> str:
        url = validated_cover_url(platform, platform_work_id, cover_url)
        now = self._clock()
        self._purge_expired(now)
        while len(self._entries) >= self.max_entries:
            self._entries.popitem(last=False)

        reference = secrets.token_urlsafe(32)
        self._entries[reference] = CoverReference(
            platform=platform,
            platform_work_id=platform_work_id,
            url=url,
            expires_at=now + self.ttl_seconds,
        )
        return reference

    def get(self, reference: str) -> CoverReference | None:
        if len(reference) > 80:
            return None
        now = self._clock()
        self._purge_expired(now)
        entry = self._entries.get(reference)
        if entry is None:
            return None
        self._entries.move_to_end(reference)
        return entry

    def clear(self) -> None:
        self._entries.clear()

    def _purge_expired(self, now: float) -> None:
        expired = [
            reference
            for reference, entry in self._entries.items()
            if entry.expires_at <= now
        ]
        for reference in expired:
            self._entries.pop(reference, None)


class CoverFetcher:
    def __init__(
        self,
        *,
        max_bytes: int = MAX_COVER_BYTES,
        max_redirects: int = MAX_COVER_REDIRECTS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._request_slots = asyncio.Semaphore(4)

    async def fetch(self, reference: CoverReference) -> DownloadedCover:
        async with self._request_slots:
            return await self._fetch(reference)

    async def _fetch(self, reference: CoverReference) -> DownloadedCover:
        current_url = validated_cover_url(
            reference.platform,
            reference.platform_work_id,
            reference.url,
        )
        client = self._client_instance()

        for redirect_count in range(self.max_redirects + 1):
            try:
                async with client.stream(
                    "GET",
                    current_url,
                    headers={
                        "Accept": "image/webp,image/png,image/jpeg,application/octet-stream;q=0.1",
                        "Accept-Encoding": "identity",
                        "Cookie": "",
                        "User-Agent": "MoyaWebNovelMetadataCollector/0.1",
                    },
                ) as response:
                    if response.status_code in _REDIRECT_STATUSES:
                        if redirect_count >= self.max_redirects:
                            raise CoverUpstreamError("표지 리디렉션이 너무 많습니다.")
                        location = response.headers.get("location")
                        if not location:
                            raise CoverUpstreamError("표지 리디렉션 위치가 없습니다.")
                        current_url = validated_cover_url(
                            reference.platform,
                            reference.platform_work_id,
                            urljoin(current_url, location),
                        )
                        continue

                    if response.status_code < 200 or response.status_code >= 300:
                        raise CoverUpstreamError(
                            f"표지 서버가 HTTP {response.status_code}로 응답했습니다."
                        )

                    content_encoding = response.headers.get("content-encoding", "identity").casefold()
                    if content_encoding not in {"", "identity"}:
                        raise CoverUpstreamError("압축된 표지 응답은 허용하지 않습니다.")

                    declared_type = response.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
                    if declared_type == "image/jpg":
                        declared_type = "image/jpeg"
                    if declared_type == "application/octet-stream" and reference.platform == "novelpia":
                        declared_type = ""
                    elif declared_type not in ALLOWED_COVER_CONTENT_TYPES:
                        raise UnsupportedCoverImageError(
                            "JPEG, PNG 또는 WebP 표지만 사용할 수 있습니다."
                        )

                    declared_length = response.headers.get("content-length")
                    if declared_length:
                        try:
                            if int(declared_length) > self.max_bytes:
                                raise CoverTooLargeError("표지 이미지가 10MiB 제한을 초과합니다.")
                        except ValueError:
                            pass

                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > self.max_bytes:
                            raise CoverTooLargeError("표지 이미지가 10MiB 제한을 초과합니다.")
            except httpx.TimeoutException as exc:
                raise CoverUpstreamTimeoutError("표지 서버 응답 시간이 초과되었습니다.") from exc
            except httpx.HTTPError as exc:
                raise CoverUpstreamError("표지 서버 요청에 실패했습니다.") from exc

            content_type = detect_cover_content_type(bytes(content[:16]))
            if content_type is None:
                raise UnsupportedCoverImageError(
                    "JPEG, PNG 또는 WebP 표지만 사용할 수 있습니다."
                )
            if declared_type and declared_type != content_type:
                raise UnsupportedCoverImageError("표지 MIME과 binary 형식이 일치하지 않습니다.")
            return DownloadedCover(content=bytes(content), content_type=content_type)

        raise CoverUpstreamError("표지 리디렉션을 처리하지 못했습니다.")

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    def _client_instance(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                follow_redirects=False,
                timeout=httpx.Timeout(10.0, connect=5.0),
                transport=self._transport,
                trust_env=False,
            )
        return self._client


def detect_cover_content_type(prefix: bytes) -> str | None:
    if prefix.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(prefix) >= 12 and prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP":
        return "image/webp"
    return None
