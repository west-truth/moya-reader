import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from app.extractors.base import BaseExtractor
from app.models import NovelMetadata, SearchCandidate


class MunpiaExtractor(BaseExtractor):
    platform = "munpia"
    search_url = "https://mm.munpia.com/"
    detail_url = "https://www.munpia.com/novel/detail/{work_id}"
    _work_id_pattern = re.compile(r"view_novel\(\s*(\d+)")
    _headers = {
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "User-Agent": "Mozilla/5.0 (compatible; WebNovelMetadataCollector/0.1)",
    }

    async def search(self, query: str) -> list[SearchCandidate]:
        response = await self._get(
            self.search_url,
            headers=self._headers,
            params={
                "action": "search",
                "keyword": query,
                "menu": "detailSearchV2",
                "searchKey": "all",
            },
        )
        response.raise_for_status()

        return self.parse_search_html(response.text)

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        response = await self._get(candidate.source_url, headers=self._headers)
        response.raise_for_status()

        return self.parse_detail_html(response.text, candidate)

    def parse_search_html(self, html: str) -> list[SearchCandidate]:
        soup = BeautifulSoup(html, "lxml")
        candidates: list[SearchCandidate] = []
        seen_ids: set[str] = set()

        for item in soup.select("ul#list_ul > li[onclick*='view_novel']"):
            work_id = self._extract_work_id(item)
            title_element = item.select_one("p.title")
            if not work_id or work_id in seen_ids or title_element is None:
                continue

            title = self._direct_text(title_element)
            if not title:
                continue

            author_element = item.select_one("p.author")
            genre_element = item.select_one("p.genre")
            description_element = item.select_one(".webtoon_detail .detail p")
            image_element = item.select_one("img.pic")

            cover_url = None
            if image_element and image_element.get("src"):
                cover_url = urljoin(self.search_url, str(image_element["src"]))

            status = "completed" if title_element.select_one(".i_complete") else "ongoing"
            genres = self._split_genres(
                genre_element.get_text(" ", strip=True) if genre_element else ""
            )

            candidates.append(
                SearchCandidate(
                    title=title,
                    author=self._first_text(author_element),
                    platform=self.platform,
                    platform_work_id=work_id,
                    source_url=self.detail_url.format(work_id=work_id),
                    cover_url=cover_url,
                    description=self._text_or_none(description_element),
                    genres=genres,
                    status=status,
                )
            )
            seen_ids.add(work_id)

        return candidates

    def parse_detail_html(
        self,
        html: str,
        candidate: SearchCandidate,
    ) -> NovelMetadata:
        soup = BeautifulSoup(html, "lxml")
        book_data = self._find_book_json_ld(soup)

        title = self._clean_string(book_data.get("name")) or candidate.title
        author = self._extract_author(book_data.get("author")) or candidate.author
        description = self._clean_string(book_data.get("description")) or candidate.description
        source_url = self._clean_string(book_data.get("url")) or candidate.source_url
        cover_url = self._extract_image(book_data.get("image")) or candidate.cover_url
        genres = self._as_string_list(book_data.get("genre")) or candidate.genres
        tags = self._extract_tags(soup) or candidate.tags

        return NovelMetadata(
            title=title,
            author=author,
            platform=candidate.platform,
            platform_work_id=candidate.platform_work_id,
            source_url=source_url,
            cover_url=cover_url,
            description=description,
            genres=genres,
            tags=tags,
            status=candidate.status,
            match_score=candidate.match_score,
            fetched_at=datetime.now(timezone.utc),
        )

    def metadata_from_candidate(self, candidate: SearchCandidate) -> NovelMetadata:
        return NovelMetadata(
            **candidate.model_dump(),
            fetched_at=datetime.now(timezone.utc),
        )

    def _extract_work_id(self, item: Tag) -> str | None:
        onclick = item.get("onclick")
        if not onclick:
            return None
        match = self._work_id_pattern.search(str(onclick))
        return match.group(1) if match else None

    @staticmethod
    def _direct_text(element: Tag) -> str:
        return " ".join(
            text.strip()
            for text in element.find_all(string=True, recursive=False)
            if text.strip()
        )

    @staticmethod
    def _first_text(element: Tag | None) -> str | None:
        if element is None:
            return None
        for text in element.stripped_strings:
            cleaned = text.strip()
            if cleaned:
                return cleaned
        return None

    @staticmethod
    def _text_or_none(element: Tag | None) -> str | None:
        if element is None:
            return None
        value = element.get_text(" ", strip=True)
        return value or None

    @staticmethod
    def _split_genres(value: str) -> list[str]:
        return [genre.strip() for genre in value.split(",") if genre.strip()]

    @classmethod
    def _find_book_json_ld(cls, soup: BeautifulSoup) -> dict[str, Any]:
        for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
            try:
                payload = json.loads(script.get_text(strip=True))
            except (json.JSONDecodeError, TypeError):
                continue

            for item in cls._json_ld_items(payload):
                item_type = item.get("@type")
                if item_type == "Book" or (
                    isinstance(item_type, list) and "Book" in item_type
                ):
                    return item
        return {}

    @staticmethod
    def _json_ld_items(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, dict):
            graph = payload.get("@graph")
            if isinstance(graph, list):
                return [item for item in graph if isinstance(item, dict)]
            return [payload]
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        return []

    @classmethod
    def _extract_author(cls, value: Any) -> str | None:
        if isinstance(value, dict):
            return cls._clean_string(value.get("name"))
        if isinstance(value, list):
            names = [cls._extract_author(item) for item in value]
            return ", ".join(name for name in names if name) or None
        return cls._clean_string(value)

    @classmethod
    def _extract_image(cls, value: Any) -> str | None:
        if isinstance(value, dict):
            return cls._clean_string(value.get("url"))
        if isinstance(value, list) and value:
            return cls._extract_image(value[0])
        return cls._clean_string(value)

    @classmethod
    def _as_string_list(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        if isinstance(value, list):
            return [cleaned for item in value if (cleaned := cls._clean_string(item))]
        return []

    @staticmethod
    def _extract_tags(soup: BeautifulSoup) -> list[str]:
        for element in soup.select("h5"):
            value = element.get_text(" ", strip=True)
            if "#" in value:
                return [tag.strip() for tag in re.findall(r"#([^#]+)", value) if tag.strip()]
        return []

    @staticmethod
    def _clean_string(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        cleaned = " ".join(value.split())
        return cleaned or None
