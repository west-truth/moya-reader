import asyncio
import json
import os
from pathlib import Path

import httpx
import pytest

from app.novelpia_auth import (
    LOGIN_KEY_PATTERN,
    NOVELPIA_ADULT_MODE_URL,
    NOVELPIA_LOGIN_URL,
    NovelpiaAdultVerificationRequired,
    NovelpiaAuthManager,
    NovelpiaLoginRequired,
)


LOGIN_KEY = "a" * 32 + "_" + "b" * 32
REFRESHED_LOGIN_KEY = "c" * 32 + "_" + "d" * 32
SEARCH_URL = "https://novelpia.com/proc/novel"


def test_credentials_are_saved_privately_and_authenticated_search_uses_loginkey(
    tmp_path: Path,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if str(request.url) == NOVELPIA_LOGIN_URL:
            form = request.content.decode()
            assert "email=reader%40example.com" in form
            assert "wd=secret-password" in form
            proposed_key = request.headers["cookie"].removeprefix("LOGINKEY=")
            assert len(proposed_key) == 65
            assert LOGIN_KEY_PATTERN.fullmatch(proposed_key)
            return httpx.Response(
                200,
                text="로그인해 주셔서 감사합니다",
                headers={"Set-Cookie": f"LOGINKEY={LOGIN_KEY}; Path=/"},
            )
        if str(request.url) == NOVELPIA_ADULT_MODE_URL:
            assert request.headers["cookie"] == f"LOGINKEY={LOGIN_KEY}"
            return httpx.Response(200, text="OK")
        assert str(request.url).startswith(SEARCH_URL)
        assert request.headers["cookie"] == f"LOGINKEY={LOGIN_KEY}"
        return httpx.Response(200, json={"status": 200, "list": [{"novel_age": 19}]})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        path = tmp_path / "novelpia-auth.json"
        manager = NovelpiaAuthManager(path, client)
        await manager.configure_credentials("reader@example.com", "secret-password")
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["email"] == "reader@example.com"
        assert payload["password"] == "secret-password"
        assert payload["login_key"] == LOGIN_KEY
        if os.name != "nt":
            assert path.stat().st_mode & 0o077 == 0

        result = await manager.fetch_json(SEARCH_URL, params={"novel_age": 19})
        assert result["list"][0]["novel_age"] == 19
        assert [request.url.path for request in requests] == [
            "/proc/login",
            "/proc/member_adt_mode",
            "/proc/member_adt_mode",
            "/proc/novel",
        ]
        await client.aclose()

    asyncio.run(run())


def test_expired_saved_session_automatically_logs_in_again(tmp_path: Path) -> None:
    path = tmp_path / "novelpia-auth.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "login_key": LOGIN_KEY,
                "email": "reader@example.com",
                "password": "secret-password",
                "saved_at": "2026-09-08T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    adult_checks = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal adult_checks
        if str(request.url) == NOVELPIA_ADULT_MODE_URL:
            adult_checks += 1
            return httpx.Response(200, text="login" if adult_checks == 1 else "OK")
        if str(request.url) == NOVELPIA_LOGIN_URL:
            return httpx.Response(
                200,
                text="로그인해 주셔서 감사합니다",
                headers={"Set-Cookie": f"LOGINKEY={REFRESHED_LOGIN_KEY}; Path=/"},
            )
        assert request.headers["cookie"] == f"LOGINKEY={REFRESHED_LOGIN_KEY}"
        return httpx.Response(200, json={"status": 200, "list": []})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        manager = NovelpiaAuthManager(path, client)
        await manager.fetch_json(SEARCH_URL)
        saved = json.loads(path.read_text(encoding="utf-8"))
        assert saved["login_key"] == REFRESHED_LOGIN_KEY
        assert saved["password"] == "secret-password"
        await client.aclose()

    asyncio.run(run())


def test_manual_loginkey_must_pass_real_adult_mode_check(tmp_path: Path) -> None:
    responses = iter(["login", "auth"])

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=next(responses))

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        path = tmp_path / "novelpia-auth.json"
        manager = NovelpiaAuthManager(path, client)
        with pytest.raises(NovelpiaLoginRequired, match="로그인"):
            await manager.configure_login_key(LOGIN_KEY)
        assert not path.exists()
        with pytest.raises(NovelpiaAdultVerificationRequired, match="본인 인증"):
            await manager.configure_login_key(LOGIN_KEY)
        assert not path.exists()
        await client.aclose()

    asyncio.run(run())


def test_expired_manual_loginkey_is_reported_instead_of_returning_empty_search(
    tmp_path: Path,
) -> None:
    path = tmp_path / "novelpia-auth.json"
    path.write_text(
        json.dumps({"version": 1, "login_key": LOGIN_KEY}),
        encoding="utf-8",
    )

    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, text="login")
            )
        )
        manager = NovelpiaAuthManager(path, client)
        with pytest.raises(NovelpiaLoginRequired, match="만료"):
            await manager.fetch_json(SEARCH_URL)
        await client.aclose()

    asyncio.run(run())
