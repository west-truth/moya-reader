import asyncio
import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import httpx


NOVELPIA_BASE_URL = "https://novelpia.com"
NOVELPIA_LOGIN_URL = f"{NOVELPIA_BASE_URL}/proc/login"
NOVELPIA_ADULT_MODE_URL = f"{NOVELPIA_BASE_URL}/proc/member_adt_mode"
LOGIN_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{40,256}$")
READY_TTL_SECONDS = 30.0
REQUEST_TIMEOUT_SECONDS = 15.0
NOVELPIA_HEADERS = {
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
    "User-Agent": (
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
    ),
}


class NovelpiaAuthError(RuntimeError):
    pass


class NovelpiaLoginRequired(NovelpiaAuthError):
    pass


class NovelpiaAdultVerificationRequired(NovelpiaAuthError):
    pass


class NovelpiaAuthManager:
    """Owns the Novelpia LOGINKEY and keeps account secrets out of browser storage."""

    def __init__(self, path: Path, client: httpx.AsyncClient | None = None) -> None:
        self.path = path
        self._state = self._load()
        self._client = client
        self._owns_client = client is None
        self._lock = asyncio.Lock()
        self._ready_until = 0.0

    @property
    def configured(self) -> bool:
        return bool(self._state.get("login_key"))

    @property
    def remembers_credentials(self) -> bool:
        return bool(self._state.get("email") and self._state.get("password"))

    @property
    def saved_at(self) -> str | None:
        value = self._state.get("saved_at")
        return value if isinstance(value, str) else None

    async def configure_credentials(self, email: str, password: str) -> None:
        cleaned_email = email.strip()
        if not cleaned_email or not password:
            raise ValueError("노벨피아 이메일과 비밀번호를 입력해 주세요.")

        async with self._lock:
            login_key = await self._login(cleaned_email, password)
            self._state = {
                "version": 1,
                "login_key": login_key,
                "email": cleaned_email,
                "password": password,
                "saved_at": self._now(),
                "verified_at": self._now(),
            }
            self._ready_until = time.monotonic() + READY_TTL_SECONDS
            self._save()

    async def configure_login_key(self, login_key: str) -> None:
        cleaned = self._validated_login_key(login_key)
        async with self._lock:
            await self._activate_adult_mode(cleaned)
            self._state = {
                "version": 1,
                "login_key": cleaned,
                "saved_at": self._now(),
                "verified_at": self._now(),
            }
            self._ready_until = time.monotonic() + READY_TTL_SECONDS
            self._save()

    async def ensure_ready(self, *, force: bool = False) -> None:
        async with self._lock:
            if not force and self._ready_until > time.monotonic():
                return
            login_key = self._state.get("login_key")
            if not isinstance(login_key, str):
                raise NovelpiaLoginRequired("노벨피아 로그인이 필요합니다.")
            try:
                await self._activate_adult_mode(login_key)
            except NovelpiaLoginRequired:
                email = self._state.get("email")
                password = self._state.get("password")
                if not isinstance(email, str) or not isinstance(password, str):
                    raise NovelpiaLoginRequired(
                        "노벨피아 LOGINKEY가 만료되었습니다. 새 LOGINKEY를 입력해 주세요."
                    )
                login_key = await self._login(email, password)
                self._state["login_key"] = login_key
                self._state["saved_at"] = self._now()
                self._save()
            self._state["verified_at"] = self._now()
            self._ready_until = time.monotonic() + READY_TTL_SECONDS

    async def fetch_text(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        referer: str | None = None,
    ) -> str:
        await self.ensure_ready()
        login_key = self._state.get("login_key")
        if not isinstance(login_key, str):
            raise NovelpiaLoginRequired("노벨피아 로그인이 필요합니다.")
        response = await self._request(
            "GET",
            url,
            login_key=login_key,
            params=params,
            headers=headers,
            referer=referer,
        )
        if response.status_code in {401, 403}:
            self._ready_until = 0.0
            raise NovelpiaLoginRequired(
                "노벨피아 로그인 또는 성인 인증이 만료되었습니다."
            )
        response.raise_for_status()
        return response.text

    async def fetch_json(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        referer: str | None = None,
    ) -> dict[str, Any]:
        # Novelpia returns a successful empty search to anonymous sessions. Verify
        # adult-mode access for every search so an expired key cannot look like
        # a legitimate zero-result response.
        await self.ensure_ready(force=True)
        text = await self.fetch_text(
            url,
            params=params,
            headers=headers,
            referer=referer,
        )
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            self._ready_until = 0.0
            raise NovelpiaLoginRequired(
                "노벨피아 인증 응답을 확인하지 못했습니다. 로그인을 다시 확인해 주세요."
            ) from exc
        if not isinstance(payload, dict):
            raise NovelpiaAuthError("노벨피아 검색 응답 형식이 올바르지 않습니다.")
        return payload

    def clear(self) -> None:
        self._state = {}
        self._ready_until = 0.0
        self.path.unlink(missing_ok=True)
        self.path.with_suffix(".tmp").unlink(missing_ok=True)

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    async def _login(self, email: str, password: str) -> str:
        # Match the site's established 32-hex + underscore + 32-hex session shape.
        proposed_key = f"{secrets.token_hex(16)}_{secrets.token_hex(16)}"
        response = await self._request(
            "POST",
            NOVELPIA_LOGIN_URL,
            login_key=proposed_key,
            data={"redirectrurl": "", "email": email, "wd": password},
            headers={
                "Accept": "text/html,application/xhtml+xml,application/json",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
            },
            referer=f"{NOVELPIA_BASE_URL}/",
        )
        response.raise_for_status()
        response_key = next(
            (
                cookie.value
                for cookie in response.cookies.jar
                if cookie.name == "LOGINKEY" and LOGIN_KEY_PATTERN.fullmatch(cookie.value)
            ),
            None,
        )
        login_key = response_key or proposed_key
        try:
            await self._activate_adult_mode(login_key)
        except NovelpiaLoginRequired as exc:
            raise NovelpiaLoginRequired(
                "노벨피아 이메일 또는 비밀번호를 확인해 주세요."
            ) from exc
        return login_key

    async def _activate_adult_mode(self, login_key: str) -> None:
        response = await self._request(
            "POST",
            NOVELPIA_ADULT_MODE_URL,
            login_key=login_key,
            data={"option": "on"},
            headers={
                "Accept": "text/plain,application/json,*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
            },
            referer=f"{NOVELPIA_BASE_URL}/",
        )
        response.raise_for_status()
        result = response.text.strip().casefold()
        if result == "ok":
            return
        if result == "login":
            raise NovelpiaLoginRequired("노벨피아 로그인이 필요합니다.")
        if result == "auth":
            raise NovelpiaAdultVerificationRequired(
                "노벨피아 계정의 본인 인증을 먼저 완료해 주세요."
            )
        raise NovelpiaAuthError(
            "노벨피아에서 성인 작품 사용 여부를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요."
        )

    async def _request(
        self,
        method: str,
        url: str,
        *,
        login_key: str,
        params: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        referer: str | None = None,
    ) -> httpx.Response:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                follow_redirects=True,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            self._owns_client = True
        request_headers = {
            **NOVELPIA_HEADERS,
            **(dict(headers) if headers else {}),
            "Cookie": f"LOGINKEY={login_key}",
        }
        if referer:
            request_headers["Referer"] = referer
        try:
            return await self._client.request(
                method,
                url,
                params=params,
                data=data,
                headers=request_headers,
            )
        except httpx.TimeoutException as exc:
            raise TimeoutError("노벨피아 인증 요청 시간이 초과되었습니다.") from exc
        except httpx.HTTPError as exc:
            raise NovelpiaAuthError("노벨피아 인증 서버에 연결하지 못했습니다.") from exc

    def _load(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        if not isinstance(payload, dict) or payload.get("version") != 1:
            return {}
        login_key = payload.get("login_key")
        if not isinstance(login_key, str) or not LOGIN_KEY_PATTERN.fullmatch(login_key):
            return {}
        state: dict[str, Any] = {
            "version": 1,
            "login_key": login_key,
        }
        for name in ("email", "password", "saved_at", "verified_at"):
            value = payload.get(name)
            if isinstance(value, str) and value:
                state[name] = value
        return state

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(self._state, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _validated_login_key(value: str) -> str:
        cleaned = value.strip()
        if not LOGIN_KEY_PATTERN.fullmatch(cleaned):
            raise ValueError("노벨피아 LOGINKEY 형식이 올바르지 않습니다.")
        return cleaned

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
