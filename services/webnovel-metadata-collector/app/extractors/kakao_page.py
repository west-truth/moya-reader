import asyncio
from datetime import datetime, timezone
from typing import Any

from app.extractors.base import BaseExtractor
from app.models import NovelMetadata, SearchCandidate


class KakaoPageExtractor(BaseExtractor):
    platform = "kakao_page"
    base_url = "https://page.kakao.com"
    api_base_url = "https://bff-page.kakao.com"
    image_base_url = "https://page-images.kakaoentcdn.com/download/resource?kid="
    _headers = {
        "Accept": "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "Origin": base_url,
        "Referer": f"{base_url}/",
        "User-Agent": "Mozilla/5.0 (compatible; WebNovelMetadataCollector/0.1)",
    }

    async def search(self, query: str) -> list[SearchCandidate]:
        response = await self._get(
            f"{self.api_base_url}/api/gateway/api/v2/search/series",
            headers=self._headers,
            params=self.search_params(query),
        )
        response.raise_for_status()

        return self.parse_search_payload(response.json())

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        params = {"series_id": candidate.platform_work_id}
        headers = {**self._headers, "Referer": candidate.source_url}

        overview_response, about_response = await asyncio.gather(
            self._get(
                f"{self.api_base_url}/api/gateway/api/v1/content/overview",
                headers=headers,
                params=params,
            ),
            self._get(
                f"{self.api_base_url}/api/gateway/api/v1/content/about",
                headers=headers,
                params=params,
            ),
        )
        overview_response.raise_for_status()
        about_response.raise_for_status()

        return self.parse_detail_payload(
            overview_response.json(),
            about_response.json(),
            candidate,
        )

    def parse_search_payload(
        self,
        payload: dict[str, Any],
        *,
        adult_only: bool = False,
    ) -> list[SearchCandidate]:
        result = payload.get("result") or {}
        candidates: list[SearchCandidate] = []

        for item in result.get("list") or []:
            if item.get("type") != "SERIES" or item.get("category_uid") != 11:
                continue
            is_adult = self._safe_int(item.get("age_grade")) >= 19
            if is_adult != adult_only:
                continue

            work_id = str(item.get("series_id") or "")
            title = self._clean_string(item.get("title"))
            if not work_id or not title:
                continue

            subcategory = self._clean_string(item.get("sub_category"))
            candidates.append(
                SearchCandidate(
                    title=title,
                    author=self._clean_string(item.get("authors")),
                    platform=self.platform,
                    platform_work_id=work_id,
                    source_url=f"{self.base_url}/content/{work_id}",
                    cover_url=self._image_url(item.get("thumbnail")),
                    genres=[subcategory] if subcategory else [],
                    status=self._status_from_state(item.get("state")),
                )
            )

        return candidates

    @staticmethod
    def search_params(query: str) -> dict[str, Any]:
        return {
            "keyword": query,
            "category_uid": 11,
            "is_complete": "false",
            "sort_type": "ACCURACY",
            "page": 0,
            "size": 10,
        }

    def parse_detail_payload(
        self,
        overview_payload: dict[str, Any],
        about_payload: dict[str, Any],
        candidate: SearchCandidate,
    ) -> NovelMetadata:
        content = ((overview_payload.get("result") or {}).get("content") or {})
        about = about_payload.get("result") or {}

        if not content:
            raise ValueError("카카오페이지 상세 정보가 없습니다.")

        title = self._clean_string(content.get("title")) or candidate.title
        author = self._clean_string(content.get("authors")) or candidate.author
        description = (
            self._clean_string(about.get("description"))
            or self._clean_string(content.get("description"))
            or candidate.description
        )
        subcategory = self._clean_string(content.get("sub_category"))
        tags: list[str] = []
        for item in about.get("theme_keyword_list") or []:
            tag_title = self._clean_string(item.get("title"))
            if tag_title:
                tags.append(tag_title)

        return NovelMetadata(
            title=title,
            author=author,
            platform=candidate.platform,
            platform_work_id=candidate.platform_work_id,
            source_url=candidate.source_url,
            cover_url=self._image_url(content.get("thumbnail")) or candidate.cover_url,
            description=description,
            genres=[subcategory] if subcategory else candidate.genres,
            tags=tags or candidate.tags,
            status=self._status_from_state(content.get("state")) or candidate.status,
            match_score=candidate.match_score,
            fetched_at=datetime.now(timezone.utc),
        )

    @classmethod
    def _image_url(cls, value: Any) -> str | None:
        image_id = cls._clean_string(value)
        if not image_id:
            return None
        if image_id.startswith(("http://", "https://")):
            return image_id
        return f"{cls.image_base_url}{image_id}"

    @staticmethod
    def _status_from_state(value: Any) -> str | None:
        if value in {"ST62", "ST64"}:
            return "hiatus"
        return None

    @staticmethod
    def _clean_string(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = " ".join(value.split())
        return cleaned or None
