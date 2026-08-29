import asyncio

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
