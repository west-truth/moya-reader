from abc import ABC, abstractmethod
from typing import Any, Mapping

import httpx

from app.models import NovelMetadata, SearchCandidate


class BaseExtractor(ABC):
    platform: str

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    async def _get(
        self,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                follow_redirects=True,
                timeout=10.0,
            )
        return await self._client.get(url, headers=headers, params=params)

    async def aclose(self) -> None:
        client = getattr(self, "_client", None)
        if client is not None and not client.is_closed:
            await client.aclose()

    @staticmethod
    def _safe_int(value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @abstractmethod
    async def search(self, query: str) -> list[SearchCandidate]:
        raise NotImplementedError

    @abstractmethod
    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        raise NotImplementedError
