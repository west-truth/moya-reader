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
        if isinstance(self.extractor, (RidiExtractor, KakaoPageExtractor)):
            return await self.extractor.search_adult(query)

        if isinstance(self.extractor, NovelpiaExtractor):
            payload = await self.sessions.fetch_novelpia_json(
                self.extractor.search_url,
                params=self.extractor.search_params(query, novel_age=19),
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "X-Requested-With": "XMLHttpRequest",
                },
                referer=f"{self.extractor.base_url}/search",
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
            return self._with_adult_tag(await self.extractor.get_detail(candidate))

        if isinstance(self.extractor, NovelpiaExtractor):
            html = await self.sessions.fetch_novelpia_text(
                candidate.source_url,
                headers={"Accept": "text/html,application/xhtml+xml"},
                referer=candidate.source_url,
            )
        else:
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

    async def aclose(self) -> None:
        await self.extractor.aclose()
        await super().aclose()
