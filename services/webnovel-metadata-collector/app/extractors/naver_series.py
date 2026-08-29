import re
from datetime import datetime, timezone
from urllib.parse import parse_qs, parse_qsl, urlencode, urljoin, urlparse

from bs4 import BeautifulSoup, Tag

from app.extractors.base import BaseExtractor
from app.models import NovelMetadata, SearchCandidate


class NaverSeriesExtractor(BaseExtractor):
    platform = "naver_series"
    base_url = "https://series.naver.com"
    search_url = f"{base_url}/search/search.series"
    _episode_suffix = re.compile(
        r"\s*\(총\s*[\d,]+(?:화|권)/(?:미완결|완결)\)\s*$"
    )
    _headers = {
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
        "User-Agent": "Mozilla/5.0 (compatible; WebNovelMetadataCollector/0.1)",
    }

    async def search(self, query: str) -> list[SearchCandidate]:
        response = await self._get(
            self.search_url,
            headers=self._headers,
            params={"t": "novel", "q": query},
        )
        response.raise_for_status()

        return self.parse_search_html(response.text)

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        response = await self._get(candidate.source_url, headers=self._headers)
        response.raise_for_status()

        return self.parse_detail_html(response.text, candidate)

    def parse_search_html(
        self,
        html: str,
        *,
        adult_only: bool = False,
    ) -> list[SearchCandidate]:
        soup = BeautifulSoup(html, "lxml")
        candidates: list[SearchCandidate] = []
        seen_ids: set[str] = set()

        for item in soup.select("ul.lst_list > li"):
            title_link = item.select_one("h3 a[href*='/novel/detail.series?productNo=']")
            if title_link is None:
                continue

            work_id = self._extract_work_id(str(title_link.get("href", "")))
            if not work_id or work_id in seen_ids:
                continue

            raw_title = title_link.get_text(" ", strip=True)
            title = self._episode_suffix.sub("", raw_title).strip()
            if not title:
                continue

            image = item.select_one("a.pic img")
            image_source = str(image["src"]) if image and image.get("src") else ""
            adult_marker_source = str(item).casefold()
            is_adult = any(
                marker in adult_marker_source
                for marker in ("19over_book", "19금", "age19", "age_19", "ico19")
            )
            if is_adult != adult_only:
                continue
            author = item.select_one(".author")
            description = item.select_one(".dsc")
            source_url = urljoin(self.base_url, str(title_link["href"]))

            candidates.append(
                SearchCandidate(
                    title=title,
                    author=self._text_or_none(author),
                    platform=self.platform,
                    platform_work_id=work_id,
                    source_url=source_url,
                    cover_url=(
                        self._original_cover_url(image_source)
                        if image_source
                        else None
                    ),
                    description=self._text_or_none(description),
                    status=self._status_from_text(raw_title),
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
        title = self._meta_content(soup, "property", "og:title") or candidate.title
        source_url = self._meta_content(soup, "property", "og:url") or candidate.source_url

        cover = soup.select_one(".aside .pic_area img")
        cover_url = (
            self._original_cover_url(str(cover["src"]))
            if cover and cover.get("src")
            else candidate.cover_url
        )
        descriptions = [
            re.sub(r"\s*(?:더보기|접기)\s*$", "", node.get_text(" ", strip=True)).strip()
            for node in soup.select(".end_dsc ._synopsis")
        ]
        description = max(descriptions, key=len, default=candidate.description)

        genres: list[str] = []
        author = candidate.author
        status = candidate.status
        for item in soup.select("ul.end_info li.info_lst > ul > li"):
            text = item.get_text(" ", strip=True)
            genre_link = item.select_one("a[href*='genreCode=']")
            if genre_link:
                genre = genre_link.get_text(" ", strip=True)
                if genre and genre not in genres:
                    genres.append(genre)
            if text in {"완결", "미완결"}:
                status = "completed" if text == "완결" else "ongoing"
            if text.startswith("글"):
                author_link = item.select_one("a")
                if author_link:
                    author = author_link.get_text(" ", strip=True) or author

        return NovelMetadata(
            title=title,
            author=author,
            platform=candidate.platform,
            platform_work_id=candidate.platform_work_id,
            source_url=source_url,
            cover_url=cover_url,
            description=description,
            genres=genres or candidate.genres,
            tags=candidate.tags,
            status=status,
            match_score=candidate.match_score,
            fetched_at=datetime.now(timezone.utc),
        )

    @staticmethod
    def _extract_work_id(href: str) -> str | None:
        values = parse_qs(urlparse(href).query).get("productNo")
        return values[0] if values else None

    @staticmethod
    def _status_from_text(value: str) -> str | None:
        if "/미완결" in value:
            return "ongoing"
        if "/완결" in value:
            return "completed"
        return None

    @classmethod
    def _original_cover_url(cls, value: str) -> str | None:
        absolute_url = urljoin(cls.base_url, value)
        if "19over_book" in absolute_url:
            return None
        parsed = urlparse(absolute_url)
        if parsed.hostname and parsed.hostname.endswith("pstatic.net"):
            query = urlencode(
                [
                    (key, item)
                    for key, item in parse_qsl(parsed.query, keep_blank_values=True)
                    if key.casefold() != "type"
                ]
            )
            return parsed._replace(query=query).geturl()
        return absolute_url

    @staticmethod
    def _text_or_none(element: Tag | None) -> str | None:
        if element is None:
            return None
        value = element.get_text(" ", strip=True)
        return value or None

    @staticmethod
    def _meta_content(soup: BeautifulSoup, attribute: str, value: str) -> str | None:
        element = soup.find("meta", attrs={attribute: value})
        if not element or not element.get("content"):
            return None
        return str(element["content"]).strip() or None
