import asyncio
import json
import pytest

from app.auth_session import (
    AuthSessionManager,
    remote_auth_hostname_resolves_to_blocked_address,
    remote_auth_url_is_blocked,
)


class FakeMouse:
    def __init__(self) -> None:
        self.clicks: list[tuple[float, float]] = []
        self.scrolls: list[tuple[float, float]] = []

    async def click(self, x: float, y: float) -> None:
        self.clicks.append((x, y))

    async def wheel(self, x: float, y: float) -> None:
        self.scrolls.append((x, y))


class FakeKeyboard:
    def __init__(self) -> None:
        self.texts: list[str] = []
        self.keys: list[str] = []

    async def insert_text(self, text: str) -> None:
        self.texts.append(text)

    async def press(self, key: str) -> None:
        self.keys.append(key)


class FakePage:
    def __init__(self) -> None:
        self.mouse = FakeMouse()
        self.keyboard = FakeKeyboard()
        self.frame = b"\xff\xd8\xff\xe0remote-browser-frame"
        self.closed = False
        self.navigation: list[str] = []
        self.frames = [self]
        self.main_frame = self
        self.url = "https://example.com/login"
        self.input_type = "password"

    async def evaluate(self, _script):
        if "querySelectorAll" in _script:
            return []
        return self.input_type

    async def bring_to_front(self):
        pass

    async def close(self):
        self.closed = True

    def is_closed(self) -> bool:
        return self.closed

    async def screenshot(self, **_: object) -> bytes:
        return self.frame

    async def go_back(self, **_: object) -> None:
        self.navigation.append("back")

    async def go_forward(self, **_: object) -> None:
        self.navigation.append("forward")

    async def reload(self, **_: object) -> None:
        self.navigation.append("reload")


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.pages = [page]
        self.cookie_data = [{"name": "session", "value": "synthetic", "domain": "example.com", "path": "/", "expires": -1}]

    async def cookies(self):
        return self.cookie_data

    async def close(self):
        for page in self.pages:
            await page.close()


def test_remote_browser_frame_revision_and_bounded_actions(tmp_path) -> None:
    manager = AuthSessionManager(tmp_path)
    manager.remote_auth = True
    page = FakePage()
    manager._context = FakeContext(page)
    manager._remote_login_active = True

    async def run() -> None:
        first = await manager.remote_frame(0)
        assert first is not None
        assert first["revision"] == 1
        assert first["width"] == 1280
        assert first["height"] == 800
        assert await manager.remote_frame(1) is None

        await manager.remote_action("click", x=120, y=240)
        await manager.remote_action("text", text="사용자 입력")
        await manager.remote_action("key", key="Enter")
        await manager.remote_action("scroll", delta_y=320)
        await manager.remote_action("back")

    asyncio.run(run())

    assert page.mouse.clicks == [(120, 240)]
    assert page.mouse.scrolls == [(0, 320)]
    assert page.keyboard.texts == ["사용자 입력"]
    assert page.keyboard.keys == ["Enter"]
    assert page.navigation == ["back"]


def test_remote_auth_browser_blocks_internal_and_non_web_destinations() -> None:
    assert remote_auth_url_is_blocked("http://metadata-collector:8000/health")
    assert remote_auth_url_is_blocked("http://127.0.0.1:8787/api")
    assert remote_auth_url_is_blocked("http://10.0.0.8/private")
    assert remote_auth_url_is_blocked("http://100.64.0.1/shared")
    assert remote_auth_url_is_blocked("file:///etc/passwd")
    assert not remote_auth_url_is_blocked("https://series.naver.com/novel/home.series")
    assert not remote_auth_url_is_blocked("https://accounts.kakao.com/login")


def test_remote_auth_browser_blocks_public_names_that_resolve_privately(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.auth_session.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("192.168.0.10", 0))],
    )
    assert remote_auth_hostname_resolves_to_blocked_address("login.example.com")

    monkeypatch.setattr(
        "app.auth_session.socket.getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("8.8.8.8", 0))],
    )
    assert not remote_auth_hostname_resolves_to_blocked_address("login.example.com")


def test_popup_selection_rejects_stale_input_and_returns_to_parent(tmp_path):
    manager = AuthSessionManager(tmp_path)
    manager.remote_auth = True
    parent, popup = FakePage(), FakePage()
    manager._context = FakeContext(parent)
    manager._remote_login_active = True

    async def run():
        original = await manager.remote_frame(0)
        parent_id = original["metadata"]["pageId"]
        manager._context.pages.append(popup)
        manager._remote_page_opened(popup)
        next_frame = await manager.remote_frame(original["revision"])
        assert next_frame is not None  # Identical screenshot but different active tab.
        popup_id = next_frame["metadata"]["pageId"]
        with pytest.raises(ValueError):
            await manager.remote_action("fill", text="must not send", page_id=parent_id)
        assert not popup.keyboard.texts
        await manager.remote_action("select_tab", page_id=parent_id)
        await manager.remote_action("fill", text="수정된 입력", page_id=parent_id)
        assert parent.keyboard.keys == ["ControlOrMeta+A"]
        assert parent.keyboard.texts == ["수정된 입력"]
        await manager.remote_action("fill", text="", page_id=parent_id)
        assert parent.keyboard.keys[-1] == "Backspace"
        await manager.remote_action("select_tab", page_id=popup_id)
        await manager.remote_action("close_tab", page_id=popup_id)
        assert manager._active_remote_page() is parent
        parent.input_type = None
        with pytest.raises(ValueError):
            await manager.remote_action("fill", text="wrong focus", page_id=parent_id)
    asyncio.run(run())


def test_completed_login_checkpoints_session_cookies_and_clear_removes_them(tmp_path):
    manager = AuthSessionManager(tmp_path)
    manager.remote_auth = True
    context = FakeContext(FakePage())
    context.cookie_data.append({"name": "persistent", "value": "persisted-in-profile", "expires": 9999999999})
    manager._context = context
    manager._context_headless = False
    manager._remote_login_active = True

    async def run():
        await manager.finish_login()
        manager.set_enabled("ridi", True)
        restarted = AuthSessionManager(tmp_path)
        assert restarted.is_enabled("ridi")
        assert restarted.status()["session_saved_at"]
        payload = restarted._load_session()
        assert [cookie["name"] for cookie in payload["cookies"]] == ["session"]
        assert "synthetic" not in json.dumps(restarted.status())
        assert context.pages[0].closed
        await restarted.clear_session()
        assert not restarted.session_path.exists()
        assert not restarted.status()["session_saved_at"]
        assert not restarted.enabled_platforms
    asyncio.run(run())
