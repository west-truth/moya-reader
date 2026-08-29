from datetime import datetime, timezone

from app.auth_session import AuthSessionManager
from app.extractors.base import BaseExtractor
from app.extractors.kakao_page import KakaoPageExtractor
from app.extractors.naver_series import NaverSeriesExtractor
from app.extractors.novelpia import NovelpiaExtractor
from app.extractors.ridi import RidiExtractor
from app.models import NovelMetadata, SearchCandidate


class AuthenticatedExtractor(BaseExtractor):
    def __init__(self, sessions: AuthSessionManager, extractor: BaseExtractor) -> None:
        super().__init__()
        self.sessions = sessions
        self.extractor = extractor
        self.platform = extractor.platform

    async def search(self, query: str) -> list[SearchCandidate]:
        for attempt in range(2):
            try:
                candidates = await self._search_once(query)
                return [self._with_adult_tag(candidate) for candidate in candidates]
            except ValueError:
                if attempt == 1:
                    raise
        return []

    async def _search_once(self, query: str) -> list[SearchCandidate]:
        if isinstance(self.extractor, RidiExtractor):
            return await self.extractor.search_adult(query)

        if isinstance(self.extractor, NovelpiaExtractor):
            payload = await self.sessions.fetch_json(
                self.extractor.search_url,
                params=self.extractor.search_params(query, novel_age=19),
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "X-Requested-With": "XMLHttpRequest",
                },
                referer=f"{self.extractor.base_url}/search",
            )
            return self.extractor.parse_search_payload(payload, adult_only=True)

        if isinstance(self.extractor, KakaoPageExtractor):
            payload = await self.sessions.fetch_json(
                f"{self.extractor.api_base_url}/api/gateway/api/v2/search/series",
                params=self.extractor.search_params(query),
                headers={"Accept": "application/json"},
                referer=f"{self.extractor.base_url}/search/result",
            )
            return self.extractor.parse_search_payload(payload, adult_only=True)

        if isinstance(self.extractor, NaverSeriesExtractor):
            html = await self.sessions.fetch_text(
                self.extractor.search_url,
                params={"t": "novel", "q": query},
                headers={"Accept": "text/html,application/xhtml+xml"},
                referer=self.extractor.base_url,
            )
            return self.extractor.parse_search_html(html, adult_only=True)

        return []

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        if isinstance(self.extractor, RidiExtractor):
            return self._with_adult_tag(
                NovelMetadata(
                    **candidate.model_dump(),
                    fetched_at=datetime.now(timezone.utc),
                )
            )

        if isinstance(self.extractor, KakaoPageExtractor):
            requests = [
                {
                    "url": (
                        f"{self.extractor.api_base_url}"
                        "/api/gateway/api/v1/content/overview"
                    ),
                    "params": {"series_id": candidate.platform_work_id},
                    "headers": {"Accept": "application/json"},
                    "referer": candidate.source_url,
                },
                {
                    "url": (
                        f"{self.extractor.api_base_url}"
                        "/api/gateway/api/v1/content/about"
                    ),
                    "params": {"series_id": candidate.platform_work_id},
                    "headers": {"Accept": "application/json"},
                    "referer": candidate.source_url,
                },
            ]
            overview, about = await self.sessions.fetch_json_many(requests)
            return self._with_adult_tag(
                self.extractor.parse_detail_payload(overview, about, candidate)
            )

        html = await self.sessions.fetch_text(
            candidate.source_url,
            headers={"Accept": "text/html,application/xhtml+xml"},
            referer=candidate.source_url,
        )
        if isinstance(self.extractor, NaverSeriesExtractor):
            return self._with_adult_tag(
                self.extractor.parse_detail_html(html, candidate)
            )
        if isinstance(self.extractor, NovelpiaExtractor):
            return self._with_adult_tag(
                self.extractor.parse_detail_html(html, candidate)
            )
        raise ValueError("지원하지 않는 인증 플랫폼입니다.")

    @staticmethod
    def _with_adult_tag(
        item: SearchCandidate | NovelMetadata,
    ) -> SearchCandidate | NovelMetadata:
        if any(tag.casefold() == "19금" for tag in item.tags):
            return item
        return item.model_copy(update={"tags": [*item.tags, "19금"]})
