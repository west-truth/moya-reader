import asyncio
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.cover_delivery import (
    CoverFetcher,
    CoverReference,
    CoverReferenceStore,
    CoverTooLargeError,
    DownloadedCover,
    UnsafeCoverUrlError,
    UnsupportedCoverImageError,
    validated_cover_url,
)
from app.models import NovelMetadata, ResolveResponse


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"safe-cover"
WEBP_BYTES = b"RIFF\x10\x00\x00\x00WEBP" + b"safe-cover"


def resolved_ridi_book() -> ResolveResponse:
    now = datetime.now(timezone.utc)
    return ResolveResponse(
        query="테스트 작품",
        status="found",
        confidence=1.0,
        match_type="exact_title",
        metadata_quality="full",
        metadata=NovelMetadata(
            title="테스트 작품",
            author="테스트 작가",
            platform="ridi",
            platform_work_id="1234",
            source_url="https://ridibooks.com/books/1234",
            cover_url="https://img.ridicdn.net/cover/1234/xxlarge#1",
            status="completed",
            match_score=1.0,
            fetched_at=now,
        ),
        searched_platforms=5,
        fetched_at=now,
    )


def test_health_capabilities_and_loopback_cors() -> None:
    with TestClient(main.app) as client:
        response = client.get("/health")
        preflight = client.options(
            "/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        tauri_preflight = client.options(
            "/health",
            headers={
                "Origin": "http://tauri.localhost",
                "Access-Control-Request-Method": "GET",
            },
        )
        tauri_auth_status = client.get(
            "/api/v1/auth/status",
            headers={
                "Origin": "http://tauri.localhost",
                "Sec-Fetch-Site": "cross-site",
            },
        )
        rejected_origin = client.options(
            "/health",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["api_version"] == 1
    assert payload["capabilities"]["resolve"] == {"version": 1}
    assert payload["capabilities"]["cover_ref"] == {
        "version": 1,
        "path": "/api/v1/covers/{cover_ref}",
        "ttl_seconds": 900,
        "max_bytes": 10 * 1024 * 1024,
        "content_types": ["image/jpeg", "image/png", "image/webp"],
    }
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert tauri_preflight.status_code == 200
    assert tauri_preflight.headers["access-control-allow-origin"] == "http://tauri.localhost"
    assert tauri_auth_status.status_code == 200
    assert rejected_origin.status_code == 400
    assert "access-control-allow-origin" not in rejected_origin.headers


def test_managed_sidecar_requires_its_ephemeral_session_token(monkeypatch) -> None:
    monkeypatch.setenv("MOYA_COLLECTOR_SESSION_TOKEN", "managed-session-token-abcdefghijklmnopqrstuvwxyz")
    with TestClient(main.app) as client:
        rejected = client.get("/health")
        accepted = client.get(
            "/health",
            headers={"X-Moya-Collector-Token": "managed-session-token-abcdefghijklmnopqrstuvwxyz"},
        )
        preflight = client.options(
            "/health",
            headers={
                "Origin": "http://tauri.localhost",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "X-Moya-Collector-Token",
            },
        )

    assert rejected.status_code == 401
    assert accepted.status_code == 200
    assert preflight.status_code == 200
    assert "x-moya-collector-token" in preflight.headers["access-control-allow-headers"].lower()


def test_remote_auth_frame_and_action_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main.auth_sessions, "remote_auth", True)

    async def fake_frame(after_revision: int):
        if after_revision >= 4:
            return None
        return {
            "content": b"\xff\xd8\xff\xe0remote-frame",
            "revision": 4,
            "width": 1280,
            "height": 900,
        }

    actions: list[tuple[str, float | None, float | None]] = []

    async def fake_action(action: str, **values):
        actions.append((action, values.get("x"), values.get("y")))

    monkeypatch.setattr(main.auth_sessions, "remote_frame", fake_frame)
    monkeypatch.setattr(main.auth_sessions, "remote_action", fake_action)

    with TestClient(main.app) as client:
        frame = client.get("/api/v1/auth/browser/frame", params={"after_revision": 3})
        unchanged = client.get("/api/v1/auth/browser/frame", params={"after_revision": 4})
        action = client.post(
            "/api/v1/auth/browser/action",
            json={"action": "click", "x": 120, "y": 850},
        )

    assert frame.status_code == 200
    assert frame.headers["content-type"] == "image/jpeg"
    assert frame.headers["x-moya-frame-revision"] == "4"
    assert frame.headers["x-moya-frame-width"] == "1280"
    assert frame.headers["x-moya-frame-height"] == "900"
    assert unchanged.status_code == 204
    assert action.status_code == 204
    assert actions == [("click", 120.0, 850.0)]


def test_cover_reference_store_is_allowlisted_bounded_and_expiring() -> None:
    now = [100.0]
    store = CoverReferenceStore(
        ttl_seconds=10,
        max_entries=1,
        clock=lambda: now[0],
    )

    first = store.issue("ridi", "1", "https://img.ridicdn.net/cover/1/xxlarge#1")
    assert "ridi" not in first
    assert "cover" not in first
    assert store.get(first) is not None
    assert store.get(first).url == "https://img.ridicdn.net/cover/1/xxlarge"

    second = store.issue(
        "naver_series",
        "2",
        "https://comicthumb-phinf.pstatic.net/cover/2.jpg",
    )
    assert store.get(first) is None
    assert store.get(second) is not None

    now[0] = 111.0
    assert store.get(second) is None

    with pytest.raises(UnsafeCoverUrlError):
        store.issue("ridi", "1", "http://img.ridicdn.net/cover/1/xxlarge")
    with pytest.raises(UnsafeCoverUrlError):
        store.issue("ridi", "1", "https://example.com/cover/1/xxlarge")


@pytest.mark.parametrize(
    ("platform", "work_id", "url"),
    [
        ("munpia", "10", "https://cdn1.munpia.com/files/attach/cover/10.jpg"),
        (
            "naver_series",
            "20",
            "https://comicthumb-phinf.pstatic.net/20260827/cover.jpg?type=m260",
        ),
        (
            "kakao_page",
            "30",
            "https://page-images.kakaoentcdn.com/download/resource?kid=cover-30",
        ),
        (
            "novelpia",
            "40",
            "https://images.novelpia.com/imagebox/cover/40_ori.file",
        ),
        ("ridi", "50", "https://img.ridicdn.net/cover/50/xxlarge#1"),
    ],
)
def test_cover_url_policy_accepts_only_known_platform_shapes(
    platform: str,
    work_id: str,
    url: str,
) -> None:
    assert validated_cover_url(platform, work_id, url).startswith("https://")


@pytest.mark.parametrize(
    ("platform", "work_id", "url"),
    [
        ("munpia", "10", "https://cdn1.munpia.com/other/cover.jpg"),
        (
            "naver_series",
            "20",
            "https://comicthumb-phinf.pstatic.net.evil.test/cover.jpg",
        ),
        (
            "kakao_page",
            "30",
            "https://page-images.kakaoentcdn.com/download/resource?kid=one&kid=two",
        ),
        ("novelpia", "40", "https://images.novelpia.com/img/layout/readycover.png"),
        ("ridi", "50", "https://img.ridicdn.net/cover/51/xxlarge"),
        ("ridi", "50", "https://img.ridicdn.net:444/cover/50/xxlarge"),
    ],
)
def test_cover_url_policy_rejects_host_path_and_work_mismatch(
    platform: str,
    work_id: str,
    url: str,
) -> None:
    with pytest.raises(UnsafeCoverUrlError):
        validated_cover_url(platform, work_id, url)


def test_cover_fetcher_allows_safe_redirect_and_detects_magic() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.path == "/cover/123":
            return httpx.Response(
                302,
                headers={"Location": "/cover/final.png"},
            )
        return httpx.Response(200, headers={"Content-Type": "image/png"}, content=PNG_BYTES)

    async def run() -> DownloadedCover:
        fetcher = CoverFetcher(transport=httpx.MockTransport(handler))
        try:
            return await fetcher.fetch(
                CoverReference(
                    platform="naver_series",
                    platform_work_id="123",
                    url="https://comicthumb-phinf.pstatic.net/cover/123",
                    expires_at=999,
                )
            )
        finally:
            await fetcher.aclose()

    cover = asyncio.run(run())
    assert cover == DownloadedCover(content=PNG_BYTES, content_type="image/png")
    assert requests == [
        "https://comicthumb-phinf.pstatic.net/cover/123",
        "https://comicthumb-phinf.pstatic.net/cover/final.png",
    ]


def test_cover_fetcher_accepts_novelpia_octet_stream_as_magic_verified_webp() -> None:
    async def run() -> DownloadedCover:
        fetcher = CoverFetcher(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    headers={"Content-Type": "application/octet-stream"},
                    content=WEBP_BYTES,
                )
            )
        )
        try:
            return await fetcher.fetch(
                CoverReference(
                    platform="novelpia",
                    platform_work_id="40",
                    url="https://images.novelpia.com/imagebox/cover/40_ori.file",
                    expires_at=999,
                )
            )
        finally:
            await fetcher.aclose()

    assert asyncio.run(run()) == DownloadedCover(
        content=WEBP_BYTES,
        content_type="image/webp",
    )


def test_cover_fetcher_rejects_unsafe_redirect_oversize_and_unknown_magic() -> None:
    async def unsafe_redirect() -> None:
        fetcher = CoverFetcher(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(302, headers={"Location": "https://example.com/cover.jpg"})
            )
        )
        try:
            with pytest.raises(UnsafeCoverUrlError):
                await fetcher.fetch(
                    CoverReference(
                        platform="ridi",
                        platform_work_id="1",
                        url="https://img.ridicdn.net/cover/1/xxlarge",
                        expires_at=999,
                    )
                )
        finally:
            await fetcher.aclose()

    async def oversized() -> None:
        fetcher = CoverFetcher(
            max_bytes=8,
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    headers={"Content-Type": "image/jpeg"},
                    content=b"\xff\xd8\xff" + b"x" * 20,
                )
            ),
        )
        try:
            with pytest.raises(CoverTooLargeError):
                await fetcher.fetch(
                    CoverReference(
                        platform="ridi",
                        platform_work_id="1",
                        url="https://img.ridicdn.net/cover/1/xxlarge",
                        expires_at=999,
                    )
                )
        finally:
            await fetcher.aclose()

    async def unknown_magic() -> None:
        fetcher = CoverFetcher(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    headers={"Content-Type": "image/gif"},
                    content=b"GIF89a-not-allowed",
                )
            )
        )
        try:
            with pytest.raises(UnsupportedCoverImageError):
                await fetcher.fetch(
                    CoverReference(
                        platform="ridi",
                        platform_work_id="1",
                        url="https://img.ridicdn.net/cover/1/xxlarge",
                        expires_at=999,
                    )
                )
        finally:
            await fetcher.aclose()

    async def mismatched_mime() -> None:
        fetcher = CoverFetcher(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    headers={"Content-Type": "image/jpeg"},
                    content=PNG_BYTES,
                )
            )
        )
        try:
            with pytest.raises(UnsupportedCoverImageError):
                await fetcher.fetch(
                    CoverReference(
                        platform="ridi",
                        platform_work_id="1",
                        url="https://img.ridicdn.net/cover/1/xxlarge",
                        expires_at=999,
                    )
                )
        finally:
            await fetcher.aclose()

    asyncio.run(unsafe_redirect())
    asyncio.run(oversized())
    asyncio.run(unknown_magic())
    asyncio.run(mismatched_mime())


def test_resolve_issues_opaque_cover_ref_and_endpoint_returns_verified_binary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main.cover_refs.clear()

    async def fake_resolve(
        query: str,
        author: str | None = None,
        *,
        include_adult: bool = False,
    ) -> ResolveResponse:
        assert query == "테스트 작품"
        assert author is None
        assert include_adult is False
        return resolved_ridi_book()

    async def fake_fetch(reference: CoverReference) -> DownloadedCover:
        assert reference.platform == "ridi"
        assert reference.platform_work_id == "1234"
        assert reference.url == "https://img.ridicdn.net/cover/1234/xxlarge"
        return DownloadedCover(content=PNG_BYTES, content_type="image/png")

    monkeypatch.setattr(main.resolve_coordinator, "resolve", fake_resolve)
    monkeypatch.setattr(main.cover_fetcher, "fetch", fake_fetch)

    with TestClient(main.app) as client:
        resolve_response = client.get("/api/v1/resolve", params={"q": "테스트 작품"})
        assert resolve_response.status_code == 200
        cover_ref = resolve_response.json()["cover_ref"]
        assert isinstance(cover_ref, str)
        assert "ridicdn" not in cover_ref

        cover_response = client.get(f"/api/v1/covers/{cover_ref}")
        missing_response = client.get("/api/v1/covers/not-issued")

    assert cover_response.status_code == 200
    assert cover_response.content == PNG_BYTES
    assert cover_response.headers["content-type"] == "image/png"
    assert cover_response.headers["cache-control"] == "private, no-store"
    assert cover_response.headers["x-content-type-options"] == "nosniff"
    assert missing_response.status_code == 404


def test_unsafe_cover_url_does_not_fail_resolved_metadata() -> None:
    response = resolved_ridi_book()
    assert response.metadata is not None
    unsafe = response.model_copy(
        update={
            "metadata": response.metadata.model_copy(
                update={"cover_url": "https://example.com/not-a-platform-cover.jpg"}
            )
        }
    )

    result = main._with_cover_ref(unsafe)

    assert result.status == "found"
    assert result.metadata is not None
    assert result.metadata.title == "테스트 작품"
    assert result.cover_ref is None
