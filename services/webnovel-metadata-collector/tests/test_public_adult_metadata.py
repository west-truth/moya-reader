import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth_session, main
from app.authenticated_extractor import AuthenticatedExtractor
from app.extractors.kakao_page import KakaoPageExtractor
from app.extractors.ridi import RidiExtractor
from app.models import SearchCandidate
from app.resolve_coordinator import ResolveCoordinator
from app.search_service import SearchService
from test_core import StubExtractor


@pytest.mark.parametrize("platform", ["ridi", "kakao_page"])
def test_public_enable_without_browser_preserves_other_login(monkeypatch, tmp_path, platform):
    monkeypatch.setattr(auth_session, "async_playwright", None)
    sessions = auth_session.AuthSessionManager(tmp_path)
    sessions.remote_auth = True
    sessions._remote_login_active = True
    sessions._active_platform = "naver_series"

    async def forbidden(*args, **kwargs):
        raise AssertionError("Public opt-in must not finish or open a login")

    monkeypatch.setattr(sessions, "finish_login", forbidden)
    monkeypatch.setattr(sessions, "open_login", forbidden)
    monkeypatch.setattr(main, "auth_sessions", sessions)
    with TestClient(main.app) as client:
        health = client.get("/health").json()["capabilities"]["adult_auth"]
        assert health["available"] is True
        assert set(health["public_search_platforms"]) == {"ridi", "kakao_page"}
        result = client.put(f"/api/v1/auth/{platform}", json={"enabled": True})
        assert result.status_code == 200
        assert platform in result.json()["enabled_platforms"]
        assert sessions._active_platform == "naver_series"
        assert sessions._remote_login_active is True
        # Opt-in survives a collector restart without a browser profile.
        assert platform in auth_session.AuthSessionManager(tmp_path).enabled_platforms
        assert client.put(f"/api/v1/auth/{platform}", json={"enabled": False}).status_code == 200
        assert platform not in sessions.enabled_platforms


@pytest.mark.parametrize("platform", ["ridi", "kakao_page"])
def test_public_resolution_requires_both_opt_ins_and_keeps_failures_public(platform):
    class Sessions:
        available = True
        enabled_platforms = set()

    adult = StubExtractor(platform, [SearchCandidate(
        title="성인 테스트 작품", author="작가", platform=platform,
        platform_work_id="42", source_url="https://example.com/42",
        cover_url="https://example.com/42.jpg", description="소개", tags=["19금"],
    )])
    sessions = Sessions()
    coordinator = ResolveCoordinator(SearchService([]), sessions, [adult])

    async def run():
        await coordinator.resolve("성인 테스트 작품", include_adult=True)
        assert adult.search_queries == []
        sessions.enabled_platforms = {platform}
        await coordinator.resolve("성인 테스트 작품", include_adult=False)
        assert adult.search_queries == []
        result = await coordinator.resolve("성인 테스트 작품", include_adult=True)
        assert result.status == "found"
        assert result.public_adult_metadata is True
        assert result.authenticated_search is False
        adult.search_error = True
        failed = await coordinator.resolve("다른 테스트 작품", include_adult=True)
        assert failed.public_adult_metadata is False
        assert failed.authenticated_search is False
        assert platform in failed.failed_platforms
        assert f"{platform}_auth" not in failed.platform_errors

    asyncio.run(run())


def test_kakao_adult_metadata_uses_http_without_session_and_filters_general_edition():
    requests = []

    def handle(request):
        requests.append(request)
        assert "cookie" not in request.headers
        if request.url.path.endswith("/search/series"):
            return httpx.Response(200, json={"result": {"list": [
                {"type": "SERIES", "series_id": str(age), "title": "테스트 작품",
                 "authors": "작가", "category_uid": 11, "age_grade": age}
                for age in [15, 19]
            ]}})
        assert request.url.params["series_id"] == "19"
        if request.url.path.endswith("/overview"):
            return httpx.Response(200, json={"result": {"content": {
                "title": "테스트 작품 [완전판]", "authors": "작가", "thumbnail": "cover-id",
            }}})
        assert request.url.path.endswith("/about")
        return httpx.Response(200, json={"result": {"description": "작품 소개"}})

    async def run():
        extractor = KakaoPageExtractor()
        extractor._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        # No session methods exist: accidentally taking the browser path fails immediately.
        adult = AuthenticatedExtractor(object(), extractor)
        try:
            candidates = await adult.search("테스트 작품")
            assert [item.platform_work_id for item in candidates] == ["19"]
            detail = await adult.get_detail(candidates[0])
            assert detail.description == "작품 소개"
            assert detail.author == "작가"
            assert detail.cover_url.endswith("kid=cover-id")
            assert "19금" in detail.tags
            general = await extractor.search("테스트 작품")
            assert [item.platform_work_id for item in general] == ["15"]
        finally:
            await adult.aclose()
        assert extractor._client.is_closed

    asyncio.run(run())
    assert len(requests) == 4


def test_ridi_adult_search_does_not_use_login_session(monkeypatch):
    calls = []

    def search(query, *, exclude_adult):
        calls.append(exclude_adult)
        return {"books": [
            {"b_id": str(age), "title": "테스트 작품", "author": "작가",
             "is_serial": 1, "age_limit": age, "parent_category_name": "로맨스 웹소설"}
            for age in [0, 19]
        ]}

    extractor = RidiExtractor()
    monkeypatch.setattr(extractor, "_request_search", search)

    async def run():
        adult = AuthenticatedExtractor(object(), extractor)
        candidates = await adult.search("테스트 작품")
        assert [item.platform_work_id for item in candidates] == ["19"]
        assert "19금" in (await adult.get_detail(candidates[0])).tags
        await adult.aclose()

    asyncio.run(run())
    assert calls == [False]
