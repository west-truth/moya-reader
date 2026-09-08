"""Opt-in isolated Chromium check; no real accounts or external requests."""
import asyncio
import os

import pytest

from app.auth_session import AuthSessionManager


@pytest.mark.skipif(os.environ.get("MOYA_TEST_AUTH_BROWSER") != "1", reason="opt-in local Chromium")
def test_real_browser_input_popup_and_restart(tmp_path):
    async def run():
        manager = AuthSessionManager(tmp_path)
        manager.remote_auth = True
        manager.remote_auth_headless = True
        restored = None
        try:
            context = await manager._ensure_context(visible=False)
            await context.unroute("**/*")
            await context.route("**/*", lambda route: route.fulfill(content_type="text/html", body='<input type="password"><button onclick="window.open(\'about:blank\')">Social login</button>'))
            page = context.pages[0]
            await page.goto("https://login.example.test")
            manager._remote_login_active = True
            await page.locator("input").focus()
            frame = await manager.remote_frame(0)
            page_id = frame["metadata"]["pageId"]
            assert frame["metadata"]["inputType"] == "password"
            assert frame["metadata"]["fields"][0]["type"] == "password"
            await manager.remote_action("fill", text="한글 테스트", page_id=page_id)
            assert await page.locator("input").input_value() == "한글 테스트"
            await manager.remote_action("fill", text="교체", page_id=page_id)
            assert await page.locator("input").input_value() == "교체"
            assert "교체" not in str((await manager.remote_frame(0))["metadata"])
            async with page.expect_popup() as popup_event:
                await page.locator("button").click()
            popup = await popup_event.value
            assert manager._active_remote_page() is popup
            with pytest.raises(ValueError):
                await manager.remote_action("fill", text="stale", page_id=page_id)
            await manager.remote_action("close_tab", page_id=manager._remote_page_id(popup))
            assert manager._active_remote_page() is page
            await context.add_cookies([{"name": "session", "value": "synthetic-login", "domain": "login.example.test", "path": "/", "httpOnly": True, "secure": True}])
            await page.evaluate("localStorage.setItem('auth-marker', 'synthetic')")
            await manager.finish_login()
            manager.set_enabled("novelpia", True)
            await manager.aclose()
            restored = AuthSessionManager(tmp_path)
            restored.remote_auth = True
            restored.remote_auth_headless = True
            next_context = await restored._ensure_context(visible=False)
            assert any(c["name"] == "session" and c["value"] == "synthetic-login" for c in await next_context.cookies())
            assert restored.is_enabled("novelpia")
            await next_context.unroute("**/*")
            await next_context.route("**/*", lambda route: route.fulfill(content_type="text/html", body="Restored"))
            await next_context.pages[0].goto("https://login.example.test")
            assert await next_context.pages[0].evaluate("localStorage.getItem('auth-marker')") == "synthetic"
            await restored.clear_session()
            assert not restored.session_path.exists()
            assert not restored.profile_dir.exists()
        finally:
            await manager.aclose()
            if restored:
                await restored.aclose()
    asyncio.run(run())
