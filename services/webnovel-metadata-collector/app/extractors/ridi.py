import asyncio
import json
import re
from datetime import datetime, timezone
from html import unescape
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from app.extractors.base import BaseExtractor
from app.models import NovelMetadata, SearchCandidate


class RidiExtractor(BaseExtractor):
    platform = "ridi"
    base_url = "https://ridibooks.com"
    search_url = f"{base_url}/apps/search/search"
    _headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "Referer": f"{base_url}/search",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/151.0.0.0 Safari/537.36"
        ),
    }

    async def search(self, query: str) -> list[SearchCandidate]:
        payload = await asyncio.to_thread(self._request_search, query)
        return self.parse_search_payload(payload)

    async def search_adult(self, query: str) -> list[SearchCandidate]:
        # 리디 페이지를 headless 브라우저로 열면 Cloudflare challenge가
        # 검색 API까지 403으로 막는다. 공개 검색 API의 일반 HTTP 응답은
        # 성인 여부를 포함하므로 선택 기능 안에서 성인 후보만 분리한다.
        payload = await asyncio.to_thread(
            self._request_search,
            query,
            exclude_adult=False,
        )
        return self.parse_search_payload(payload, adult_only=True)

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        # 검색 응답 자체에 소개, 장르, 태그와 완결 여부가 모두 포함된다.
        return NovelMetadata(
            **candidate.model_dump(),
            fetched_at=datetime.now(timezone.utc),
        )

    def _request_search(
        self,
        query: str,
        *,
        exclude_adult: bool = True,
    ) -> dict[str, Any]:
        params = urlencode(
            {
                "keyword": query[:64],
                "site": "ridi-store",
                "size": 10,
                "isAdultExcluded": "true" if exclude_adult else "false",
            }
        )
        request = Request(f"{self.search_url}?{params}", headers=self._headers)
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def parse_search_payload(
        self,
        payload: dict[str, Any],
        *,
        adult_only: bool = False,
    ) -> list[SearchCandidate]:
        candidates: list[SearchCandidate] = []
        for item in payload.get("books") or []:
            parent_category = self._clean_string(item.get("parent_category_name")) or ""
            if item.get("is_serial") not in {1, True} or "웹소설" not in parent_category:
                continue
            is_adult = self._safe_int(item.get("age_limit")) >= 19
            if is_adult != adult_only:
                continue

            work_id = str(item.get("b_id") or "")
            title = self._clean_string(item.get("title"))
            if not work_id or not title:
                continue

            genre = self._clean_string(item.get("category_name"))
            candidates.append(
                SearchCandidate(
                    title=title,
                    author=self._clean_string(item.get("author")),
                    platform=self.platform,
                    platform_work_id=work_id,
                    source_url=f"{self.base_url}/books/{work_id}",
                    cover_url=f"https://img.ridicdn.net/cover/{work_id}/xxlarge#1",
                    description=self._book_description(item.get("desc")),
                    genres=[genre] if genre else [],
                    tags=self._tags(item.get("tags_info")),
                    status=(
                        "completed" if item.get("is_series_complete") else "ongoing"
                    ),
                )
            )

        return candidates

    @classmethod
    def _book_description(cls, value: Any) -> str | None:
        if not isinstance(value, str):
            return None

        text = BeautifulSoup(value, "lxml").get_text("\n", strip=True)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        start = next(
            (
                index + 1
                for index, line in enumerate(lines)
                if cls._heading_key(line) in {"책소개", "작품소개"}
            ),
            0,
        )
        selected: list[str] = []
        for line in lines[start:]:
            if cls._heading_key(line) in {
                "저자소개",
                "작가소개",
                "목차",
                "출판사서평",
            }:
                break
            selected.append(line)

        return cls._clean_string(" ".join(selected))

    @classmethod
    def _tags(cls, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []

        excluded = {"웹소설", "연재완결", "연재중", "완결", "e북", "대여", "소장"}
        tags: list[str] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            tag = cls._clean_string(item.get("tag_name"))
            if tag and cls._heading_key(tag) not in excluded:
                tags.append(tag)
        return tags

    @staticmethod
    def _heading_key(value: str) -> str:
        return re.sub(r"[\s<>\[\]【】]", "", value)

    @staticmethod
    def _clean_string(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = " ".join(unescape(value).split())
        return cleaned or None
