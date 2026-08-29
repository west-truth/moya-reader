import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from app.extractors.base import BaseExtractor
from app.models import NovelMetadata, SearchCandidate


class NovelpiaExtractor(BaseExtractor):
    platform = "novelpia"
    base_url = "https://novelpia.com"
    search_url = f"{base_url}/proc/novel"
    _headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "Referer": f"{base_url}/search",
        "User-Agent": "Mozilla/5.0 (compatible; WebNovelMetadataCollector/0.1)",
        "X-Requested-With": "XMLHttpRequest",
    }

    async def search(self, query: str) -> list[SearchCandidate]:
        response = await self._get(
            self.search_url,
            headers=self._headers,
            params=self.search_params(query, novel_age=15),
        )
        response.raise_for_status()

        return self.parse_search_payload(response.json())

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        headers = {
            **self._headers,
            "Accept": "text/html,application/xhtml+xml",
            "Referer": candidate.source_url,
        }
        response = await self._get(candidate.source_url, headers=headers)
        response.raise_for_status()

        return self.parse_detail_html(response.text, candidate)

    def parse_detail_html(
        self,
        html: str,
        candidate: SearchCandidate,
    ) -> NovelMetadata:
        soup = BeautifulSoup(html, "lxml")
        cover_image = soup.select_one("img.cover_img[src*='/imagebox/cover/']")
        cover_url = (
            self._cover_url(cover_image.get("src"))
            if cover_image and cover_image.get("src")
            else None
        )
        if not cover_url:
            cover = soup.select_one("meta[property='og:image']")
            og_cover = (
                self._cover_url(cover.get("content"))
                if cover and cover.get("content")
                else None
            )
            if og_cover and not self._is_placeholder_cover(og_cover):
                cover_url = og_cover
        cover_url = cover_url or candidate.cover_url
        return NovelMetadata(
            **candidate.model_dump(exclude={"cover_url"}),
            cover_url=cover_url,
            fetched_at=datetime.now(timezone.utc),
        )

    def parse_search_payload(
        self,
        payload: dict[str, Any],
        *,
        adult_only: bool = False,
    ) -> list[SearchCandidate]:
        if payload.get("status") != 200:
            raise ValueError("노벨피아 검색 결과를 가져오지 못했습니다.")

        candidates: list[SearchCandidate] = []
        for item in payload.get("list") or []:
            is_adult = self._safe_int(item.get("novel_age")) >= 19
            if is_adult != adult_only:
                continue

            work_id = str(item.get("novel_no") or "")
            title = self._clean_string(item.get("novel_name"))
            if not work_id or not title:
                continue

            keywords = self._keyword_list(item)
            candidates.append(
                SearchCandidate(
                    title=title,
                    author=self._clean_string(item.get("writer_nick")),
                    platform=self.platform,
                    platform_work_id=work_id,
                    source_url=f"{self.base_url}/novel/{work_id}",
                    cover_url=self._cover_url(item.get("cover_url")),
                    description=self._clean_string(item.get("novel_story")),
                    genres=keywords[:1],
                    tags=keywords[1:],
                    status=(
                        "completed"
                        if self._safe_int(item.get("is_complete")) == 1
                        else "ongoing"
                    ),
                )
            )

        return candidates

    @staticmethod
    def search_params(query: str, *, novel_age: int) -> dict[str, Any]:
        return {
            "cmd": "novel_search",
            "page": 1,
            "rows": 30,
            "search_type": "novel_name",
            "search_val": query,
            "novel_type": "",
            "start_count_book": "",
            "end_count_book": "",
            "novel_age": novel_age,
            "start_days": "",
            "sort_col": "count_view",
            "novel_genre": "",
            "block_out": 0,
            "block_stop": 0,
            "is_contest": "",
            "is_complete": "",
            "is_challenge": "",
            "list_display": "list",
        }

    @classmethod
    def _keyword_list(cls, item: dict[str, Any]) -> list[str]:
        values = item.get("novel_genre_arr")
        if not isinstance(values, list):
            try:
                values = json.loads(item.get("novel_genre") or "[]")
            except (json.JSONDecodeError, TypeError):
                values = []
        return [cleaned for value in values if (cleaned := cls._clean_string(value))]

    @classmethod
    def _cover_url(cls, value: Any) -> str | None:
        path = cls._clean_string(value)
        return urljoin(cls.base_url, path) if path else None

    @staticmethod
    def _is_placeholder_cover(url: str) -> bool:
        return "2025-novelpia2.jpg" in url.casefold()

    @staticmethod
    def _clean_string(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = " ".join(value.split())
        return cleaned or None
