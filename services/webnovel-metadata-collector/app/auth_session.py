import asyncio
import hashlib
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    from playwright.async_api import async_playwright
except ImportError:  # 선택 기능이므로 기본 실행은 Playwright 없이도 가능하다.
    PlaywrightError = RuntimeError
    PlaywrightTimeoutError = TimeoutError
    async_playwright = None


AUTH_PLATFORMS = ("naver_series", "kakao_page", "novelpia", "ridi")
LOGIN_URLS = {
    "naver_series": "https://series.naver.com/",
    "kakao_page": "https://page.kakao.com/",
    "novelpia": "https://novelpia.com/login",
    "ridi": (
        "https://ridibooks.com/account/login?"
        "return_url=https%3A%2F%2Fridibooks.com%2F"
    ),
}
REMOTE_VIEWPORT_WIDTH = 1280
REMOTE_VIEWPORT_HEIGHT = 800
REMOTE_FRAME_MAX_BYTES = 2 * 1024 * 1024
REMOTE_CONTROL_KEYS = {
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
}


def remote_auth_url_is_blocked(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme in {"about", "blob", "data"}:
        return False
    if parsed.scheme not in {"http", "https"}:
        return True
    hostname = (parsed.hostname or "").strip().rstrip(".").casefold()
    if not hostname or "." not in hostname:
        return True
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return not address.is_global


def remote_auth_hostname_resolves_to_blocked_address(hostname: str) -> bool:
    """Fail closed when a public-looking name resolves into a private network."""
    try:
        addresses = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except OSError:
        return True
    if not addresses:
        return True
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address[4][0])
        except ValueError:
            return True
        if not parsed.is_global:
            return True
    return False


class AuthFeatureUnavailable(RuntimeError):
    pass


class AuthSessionManager:
    def __init__(self, data_dir: Path | None = None) -> None:
        if data_dir is None:
            managed_data = os.environ.get("MOYA_COLLECTOR_DATA_DIR")
            if managed_data:
                data_dir = Path(managed_data) / "auth"
            else:
                local_data = os.environ.get("LOCALAPPDATA")
                data_dir = (
                    Path(local_data) / "WebNovelMetadataCollector" / "auth"
                    if local_data
                    else Path.home() / ".webnovel-metadata-collector" / "auth"
                )
        self.data_dir = data_dir
        self.profile_dir = data_dir / "browser-profile"
        self.settings_path = data_dir / "settings.json"
        self.enabled_platforms = self._load_enabled_platforms()
        self._playwright: Any = None
        self._context: Any = None
        self._context_headless: bool | None = None
        self._login_processes: list[subprocess.Popen[Any]] = []
        self.remote_auth = os.environ.get("MOYA_COLLECTOR_REMOTE_AUTH", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self.remote_auth_headless = os.environ.get(
            "MOYA_COLLECTOR_REMOTE_AUTH_HEADLESS",
            "1",
        ).strip().lower() not in {"0", "false", "no", "off"}
        self._remote_login_active = False
        self._remote_viewport_width = REMOTE_VIEWPORT_WIDTH
        self._remote_viewport_height = REMOTE_VIEWPORT_HEIGHT
        self._remote_frame_digest: str | None = None
        self._remote_frame_revision = 0
        self._remote_io_lock = asyncio.Lock()
        self._context_lock = asyncio.Lock()
        self._remote_blocked_host_cache: dict[str, float] = {}
        # 하나의 영구 프로필을 공유하므로 인증 요청은 직렬화한다. 한 요청의
        # 컨텍스트 복구가 다른 플랫폼의 진행 중인 페이지를 닫는 일을 막는다.
        self._request_slots = asyncio.Semaphore(1)
        self.last_error: str | None = None

    @property
    def available(self) -> bool:
        return async_playwright is not None

    @property
    def browser_presentation(self) -> str:
        return "remote_frame" if self.remote_auth else "local_window"

    @property
    def browser_running(self) -> bool:
        # UI에는 사용자가 닫아야 하는 로그인 창만 노출한다.
        if self.remote_auth:
            return self._remote_login_active and self._active_remote_page() is not None
        return bool(self._live_login_processes())

    def is_enabled(self, platform: str) -> bool:
        return platform in self.enabled_platforms

    def set_enabled(self, platform: str, enabled: bool) -> None:
        self._validate_platform(platform)
        if enabled:
            self.enabled_platforms.add(platform)
        else:
            self.enabled_platforms.discard(platform)
        self._save_settings()

    def status(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "browser_running": self.browser_running,
            "browser_presentation": self.browser_presentation,
            "enabled_platforms": sorted(self.enabled_platforms),
            "last_error": self.last_error,
        }

    async def open_login(
        self,
        platform: str,
        *,
        viewport_width: int | None = None,
        viewport_height: int | None = None,
    ) -> None:
        self._validate_platform(platform)
        if not self.available:
            raise AuthFeatureUnavailable(
                "인증 검색을 사용하려면 `pip install -e .[auth]`가 필요합니다."
            )

        if self.remote_auth:
            await self.close_browser()
            self._remote_viewport_width = viewport_width or REMOTE_VIEWPORT_WIDTH
            self._remote_viewport_height = viewport_height or REMOTE_VIEWPORT_HEIGHT
            context = await self._ensure_context(visible=False)
            page = context.pages[-1] if context.pages else await context.new_page()
            try:
                await page.goto(
                    LOGIN_URLS[platform],
                    wait_until="domcontentloaded",
                    timeout=30_000,
                )
            except Exception as exc:
                await self.close_browser()
                self.last_error = "원격 로그인 페이지를 열지 못했습니다."
                raise AuthFeatureUnavailable(self.last_error) from exc
            self._remote_login_active = True
            self._remote_frame_digest = None
            self._remote_frame_revision = 0
            self.last_error = None
            return

        browser_path = self._find_system_browser()
        if browser_path is None:
            self.last_error = "설치된 Chrome 또는 Edge를 찾지 못했습니다."
            raise AuthFeatureUnavailable(self.last_error)

        async with self._context_lock:
            await self._close_context_locked()
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            command = [
                str(browser_path),
                f"--user-data-dir={self.profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-mode",
                "--new-window",
                LOGIN_URLS[platform],
            ]
            try:
                process = subprocess.Popen(command)
            except OSError as exc:
                self.last_error = f"로그인 브라우저를 시작하지 못했습니다: {exc}"
                raise AuthFeatureUnavailable(self.last_error) from exc
            self._login_processes = [*self._live_login_processes(), process]
            self.last_error = None

    async def finish_login(self) -> None:
        """로그인 창을 닫고 같은 프로필로 검색 컨텍스트를 열 수 있는지 확인한다."""
        if self.remote_auth:
            context = await self._ensure_context(visible=False)
            if not self._remote_login_active:
                raise AuthFeatureUnavailable("먼저 로그인 화면을 열어 주세요.")
            self._remote_login_active = False
            for page in list(context.pages):
                try:
                    await page.close()
                except PlaywrightError:
                    pass
            self._remote_frame_digest = None
            self.last_error = None
            return

        await self._stop_login_processes()
        last_error: Exception | None = None
        for attempt in range(5):
            try:
                await self._ensure_context(visible=False)
                self.last_error = None
                return
            except AuthFeatureUnavailable as exc:
                last_error = exc
                if attempt < 4:
                    await asyncio.sleep(0.4)

        message = (
            "로그인 브라우저의 프로필이 아직 사용 중입니다. "
            "전용 Chrome/Edge 창을 완전히 닫고 다시 체크해 주세요."
        )
        self.last_error = message
        raise AuthFeatureUnavailable(message) from last_error

    async def close_browser(self) -> None:
        async with self._context_lock:
            await self._close_context_locked()
        await self._stop_login_processes()

    async def remote_frame(self, after_revision: int) -> dict[str, Any] | None:
        if not self.remote_auth:
            raise AuthFeatureUnavailable("원격 로그인 화면을 사용할 수 없습니다.")
        page = self._active_remote_page()
        if not self._remote_login_active or page is None:
            raise AuthFeatureUnavailable("열려 있는 원격 로그인 화면이 없습니다.")

        async with self._remote_io_lock:
            page = self._active_remote_page()
            if page is None:
                raise AuthFeatureUnavailable("원격 로그인 화면이 닫혔습니다.")
            try:
                content = await page.screenshot(type="jpeg", quality=72)
            except PlaywrightError as exc:
                raise AuthFeatureUnavailable("원격 로그인 화면을 읽지 못했습니다.") from exc
            if len(content) > REMOTE_FRAME_MAX_BYTES:
                raise AuthFeatureUnavailable("원격 로그인 화면이 허용 크기를 초과했습니다.")
            digest = hashlib.sha256(content).hexdigest()
            if digest != self._remote_frame_digest:
                self._remote_frame_digest = digest
                self._remote_frame_revision += 1
            if after_revision >= self._remote_frame_revision:
                return None
            return {
                "content": content,
                "revision": self._remote_frame_revision,
                "width": self._remote_viewport_width,
                "height": self._remote_viewport_height,
            }

    async def remote_action(
        self,
        action: str,
        *,
        x: float | None = None,
        y: float | None = None,
        text: str | None = None,
        key: str | None = None,
        delta_y: float | None = None,
    ) -> None:
        if not self.remote_auth or not self._remote_login_active:
            raise AuthFeatureUnavailable("열려 있는 원격 로그인 화면이 없습니다.")
        async with self._remote_io_lock:
            page = self._active_remote_page()
            if page is None:
                raise AuthFeatureUnavailable("원격 로그인 화면이 닫혔습니다.")
            if action == "click" and x is not None and y is not None:
                await page.mouse.click(x, y)
            elif action == "text" and text is not None:
                await page.keyboard.insert_text(text)
            elif action == "key" and key in REMOTE_CONTROL_KEYS:
                await page.keyboard.press(key)
            elif action == "scroll" and delta_y is not None:
                await page.mouse.wheel(0, delta_y)
            elif action == "back":
                await page.go_back(wait_until="domcontentloaded", timeout=15_000)
            elif action == "forward":
                await page.go_forward(wait_until="domcontentloaded", timeout=15_000)
            elif action == "reload":
                await page.reload(wait_until="domcontentloaded", timeout=15_000)
            else:
                raise ValueError("지원하지 않거나 값이 부족한 원격 브라우저 작업입니다.")
            self._remote_frame_digest = None

    async def _guard_remote_request(self, route: Any) -> None:
        url = route.request.url
        if remote_auth_url_is_blocked(url):
            await route.abort("blockedbyclient")
            return
        hostname = (urlparse(url).hostname or "").strip().rstrip(".").casefold()
        now = time.monotonic()
        blocked_until = self._remote_blocked_host_cache.get(hostname, 0)
        blocked = blocked_until > now
        if not blocked:
            # Never cache an allow decision: a public answer must not create a
            # DNS-rebinding window for subsequent browser requests.
            blocked = await asyncio.to_thread(remote_auth_hostname_resolves_to_blocked_address, hostname)
            if blocked:
                if len(self._remote_blocked_host_cache) >= 256:
                    self._remote_blocked_host_cache.clear()
                self._remote_blocked_host_cache[hostname] = now + 60
        if blocked:
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    async def _block_remote_web_socket(self, web_socket: Any) -> None:
        await web_socket.close(code=1008, reason="Remote authentication WebSocket blocked")

    async def clear_session(self) -> None:
        await self.close_browser()
        if self.browser_running:
            raise AuthFeatureUnavailable(
                "로그인 브라우저가 열려 있어 인증 세션을 삭제할 수 없습니다."
            )
        profile = self.profile_dir.resolve()
        root = self.data_dir.resolve()
        if profile.name != "browser-profile" or not profile.is_relative_to(root):
            raise RuntimeError("인증 프로필 경로를 안전하게 확인하지 못했습니다.")
        if profile.exists():
            shutil.rmtree(profile)
        self.enabled_platforms.clear()
        self._save_settings()

    async def aclose(self) -> None:
        await self.close_browser()
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    async def fetch_text(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        referer: str | None = None,
    ) -> str:
        responses = await self.fetch_many(
            [{"url": url, "params": params, "headers": headers, "referer": referer}]
        )
        return responses[0]

    async def fetch_json(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        referer: str | None = None,
    ) -> dict[str, Any]:
        for attempt in range(2):
            text = await self.fetch_text(
                url,
                params=params,
                headers=headers,
                referer=referer,
            )
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                if attempt == 1:
                    raise RuntimeError(
                        "인증 응답이 JSON 형식이 아닙니다. 로그인 세션을 확인해 주세요."
                    ) from exc
        raise RuntimeError("인증 JSON 응답을 읽지 못했습니다.")

    async def fetch_json_many(
        self,
        requests: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        for attempt in range(2):
            try:
                return [json.loads(text) for text in await self.fetch_many(requests)]
            except json.JSONDecodeError as exc:
                if attempt == 1:
                    raise RuntimeError(
                        "인증 응답이 JSON 형식이 아닙니다. 로그인 세션을 확인해 주세요."
                    ) from exc
        raise RuntimeError("인증 JSON 응답을 읽지 못했습니다.")

    async def fetch_many(self, requests: list[dict[str, Any]]) -> list[str]:
        async with self._request_slots:
            for attempt in range(2):
                context: Any = None
                try:
                    context = await self._ensure_context(visible=False)
                    return await self._fetch_many_once(context, requests)
                except AuthFeatureUnavailable:
                    if attempt == 1:
                        raise
                    await asyncio.sleep(0.4)
                except PlaywrightTimeoutError as exc:
                    if attempt == 1:
                        raise TimeoutError(
                            "인증 페이지 응답 시간이 초과되었습니다."
                        ) from exc
                    await self._reset_context(context)
                except PlaywrightError:
                    if attempt == 1:
                        raise
                    await self._reset_context(context)
                except RuntimeError:
                    if attempt == 1:
                        raise
                    await asyncio.sleep(0.25)

        raise RuntimeError("인증 페이지 요청을 완료하지 못했습니다.")

    async def _fetch_many_once(
        self,
        context: Any,
        requests: list[dict[str, Any]],
    ) -> list[str]:
        page = await context.new_page()
        results: list[str] = []
        try:
            for request in requests:
                await page.set_extra_http_headers(request.get("headers") or {})
                response = await page.goto(
                    self._with_params(request["url"], request.get("params")),
                    referer=request.get("referer"),
                    wait_until="domcontentloaded",
                    timeout=15_000,
                )
                if response is None or response.status >= 400:
                    status = response.status if response is not None else "응답 없음"
                    if status in {401, 403}:
                        raise AuthFeatureUnavailable(
                            "로그인 또는 성인 인증이 필요합니다. 로그인 창을 다시 열어 주세요."
                        )
                    raise RuntimeError(f"인증 페이지 요청 실패: {status}")
                final_url = page.url.casefold()
                if any(marker in final_url for marker in ("/login", "/signin")):
                    raise AuthFeatureUnavailable(
                        "로그인 세션이 만료되었습니다. 로그인 창을 다시 열어 주세요."
                    )
                results.append(await response.text())
        finally:
            try:
                await page.close()
            except PlaywrightError:
                pass
        return results

    async def _reset_context(self, expected_context: Any) -> None:
        async with self._context_lock:
            if self._context is expected_context:
                await self._close_context_locked()

    async def _ensure_context(self, *, visible: bool) -> Any:
        if not self.available:
            raise AuthFeatureUnavailable(
                "인증 검색을 사용하려면 `pip install -e .[auth]`가 필요합니다."
            )

        async with self._context_lock:
            if self._live_login_processes():
                raise AuthFeatureUnavailable(
                    "로그인 브라우저를 먼저 닫은 뒤 다시 검색해 주세요."
                )

            if self._context is not None:
                if not visible or self._context_headless is False:
                    return self._context
                await self._close_context_locked()

            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            if self._playwright is None:
                self._playwright = await async_playwright().start()

            browser_path = None if self.remote_auth else self._find_system_browser()
            if browser_path is None and not self.remote_auth:
                self.last_error = "설치된 Chrome 또는 Edge를 찾지 못했습니다."
                raise AuthFeatureUnavailable(self.last_error)

            try:
                launch_options: dict[str, Any] = {
                    "headless": self.remote_auth_headless if self.remote_auth else not visible,
                    "locale": "ko-KR",
                    "viewport": {
                        "width": self._remote_viewport_width,
                        "height": self._remote_viewport_height,
                    },
                    "args": ["--disable-dev-shm-usage"] if self.remote_auth else [],
                }
                if self.remote_auth:
                    launch_options["service_workers"] = "block"
                if browser_path is not None:
                    launch_options["executable_path"] = str(browser_path)
                context = await self._playwright.chromium.launch_persistent_context(
                    user_data_dir=str(self.profile_dir),
                    **launch_options,
                )
                if self.remote_auth:
                    await context.route("**/*", self._guard_remote_request)
                    await context.route_web_socket("**/*", self._block_remote_web_socket)
            except Exception as exc:
                self.last_error = (
                    "인증 브라우저 프로필을 열지 못했습니다. "
                    "로그인 전용 창을 완전히 닫고 다시 시도해 주세요."
                )
                raise AuthFeatureUnavailable(self.last_error) from exc

            self._context = context
            self._context_headless = not visible
            self.last_error = None
            context.on("close", lambda *_: self._mark_context_closed(context))
            return context

    async def _close_context_locked(self) -> None:
        context = self._context
        self._context = None
        self._context_headless = None
        self._remote_login_active = False
        self._remote_frame_digest = None
        if context is not None:
            try:
                await context.close()
            except PlaywrightError:
                pass

    def _active_remote_page(self) -> Any | None:
        context = self._context
        if context is None:
            return None
        pages = [page for page in context.pages if not page.is_closed()]
        return pages[-1] if pages else None

    def _live_login_processes(self) -> list[subprocess.Popen[Any]]:
        live = [process for process in self._login_processes if process.poll() is None]
        self._login_processes = live
        return live

    async def _stop_login_processes(self) -> None:
        processes = self._live_login_processes()
        self.last_error = None
        if not processes:
            return

        for process in processes:
            try:
                if os.name == "nt":
                    await asyncio.to_thread(
                        subprocess.run,
                        ["taskkill", "/PID", str(process.pid), "/T"],
                        capture_output=True,
                        timeout=4,
                        check=False,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                else:
                    process.terminate()
            except (OSError, subprocess.SubprocessError):
                pass

        remaining: list[subprocess.Popen[Any]] = []
        for process in processes:
            try:
                await asyncio.to_thread(process.wait, 4)
            except subprocess.TimeoutExpired:
                remaining.append(process)

        for process in remaining:
            try:
                if os.name == "nt":
                    await asyncio.to_thread(
                        subprocess.run,
                        ["taskkill", "/F", "/PID", str(process.pid), "/T"],
                        capture_output=True,
                        timeout=4,
                        check=False,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                else:
                    process.kill()
                await asyncio.to_thread(process.wait, 3)
            except (OSError, subprocess.SubprocessError):
                pass

        self._login_processes = [
            process for process in processes if process.poll() is None
        ]
        if self._login_processes:
            self.last_error = (
                "로그인 브라우저를 종료하지 못했습니다. 전용 창을 직접 닫아 주세요."
            )
            raise AuthFeatureUnavailable(self.last_error)

        # Chrome 자식 프로세스가 프로필 잠금을 해제할 짧은 시간을 준다.
        await asyncio.sleep(0.35)

    @staticmethod
    def _find_system_browser() -> Path | None:
        candidates: list[Path] = []
        for command in ("chrome.exe", "chrome", "msedge.exe", "msedge"):
            resolved = shutil.which(command)
            if resolved:
                candidates.append(Path(resolved))

        program_files = [
            os.environ.get("PROGRAMFILES"),
            os.environ.get("PROGRAMFILES(X86)"),
            os.environ.get("LOCALAPPDATA"),
        ]
        for root in filter(None, program_files):
            candidates.extend(
                [
                    Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe",
                    Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                ]
            )

        return next((path for path in candidates if path.is_file()), None)

    def _mark_context_closed(self, context: Any) -> None:
        if self._context is context:
            self._context = None
            self._context_headless = None

    def _load_enabled_platforms(self) -> set[str]:
        try:
            payload = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return set()
        return {
            platform
            for platform in payload.get("enabled_platforms") or []
            if platform in AUTH_PLATFORMS
        }

    def _save_settings(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(
            json.dumps(
                {"enabled_platforms": sorted(self.enabled_platforms)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _validate_platform(platform: str) -> None:
        if platform not in AUTH_PLATFORMS:
            raise ValueError("지원하지 않는 인증 플랫폼입니다.")

    @staticmethod
    def _with_params(url: str, params: dict[str, Any] | None) -> str:
        if not params:
            return url
        parsed = urlparse(url)
        query = [*parse_qsl(parsed.query, keep_blank_values=True)]
        query.extend(params.items())
        return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))
