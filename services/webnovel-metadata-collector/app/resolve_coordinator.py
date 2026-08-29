import asyncio
from datetime import datetime, timezone

from app.auth_session import AUTH_PLATFORMS, AuthSessionManager
from app.authenticated_extractor import AuthenticatedExtractor
from app.models import BatchResolveResponse, ResolveResponse
from app.normalizer import literal_titles_match, normalize_author, normalize_title
from app.search_service import SearchService


class ResolveCoordinator:
    def __init__(
        self,
        public_service: SearchService,
        sessions: AuthSessionManager,
        authenticated_extractors: list[AuthenticatedExtractor],
        *,
        batch_concurrency: int = 4,
    ) -> None:
        self.public_service = public_service
        self.sessions = sessions
        self.authenticated_extractors = {
            extractor.platform: extractor for extractor in authenticated_extractors
        }
        self.batch_concurrency = batch_concurrency

    async def resolve(
        self,
        query: str,
        author: str | None = None,
        *,
        include_adult: bool = False,
    ) -> ResolveResponse:
        if not include_adult or not self.sessions.available:
            return await self.public_service.resolve(query, author)

        enabled = [
            self.authenticated_extractors[platform]
            for platform in AUTH_PLATFORMS
            if platform in self.sessions.enabled_platforms
        ]
        if not enabled:
            return await self.public_service.resolve(query, author)

        authenticated_service = SearchService(
            enabled,
            resolve_timeout=20.0,
            max_concurrent_requests=4,
            batch_concurrency=self.batch_concurrency,
        )
        public_response, authenticated_response = await asyncio.gather(
            self.public_service.resolve(query, author),
            authenticated_service.resolve(query, author),
        )
        selected = self._select_response(query, public_response, authenticated_response)
        auth_failed = [
            f"{platform}_auth"
            for platform in authenticated_response.failed_platforms
        ]
        auth_errors = {
            f"{platform}_auth": message
            for platform, message in authenticated_response.platform_errors.items()
        }
        return selected.model_copy(
            update={
                "authenticated_search": authenticated_response.status != "failed",
                "searched_platforms": max(
                    public_response.searched_platforms,
                    authenticated_response.searched_platforms,
                ),
                "failed_platforms": list(
                    dict.fromkeys(
                        [
                            *public_response.failed_platforms,
                            *auth_failed,
                        ]
                    )
                ),
                "platform_errors": {
                    **public_response.platform_errors,
                    **auth_errors,
                },
                "skipped_platforms": list(
                    dict.fromkeys(
                        [
                            *public_response.skipped_platforms,
                            *authenticated_response.skipped_platforms,
                        ]
                    )
                ),
            }
        )

    async def resolve_batch(
        self,
        items: list[tuple[str, str | None, bool]],
    ) -> BatchResolveResponse:
        item_slots = asyncio.Semaphore(self.batch_concurrency)

        async def resolve_one(
            query: str,
            author: str | None,
            include_adult: bool,
        ) -> ResolveResponse:
            async with item_slots:
                return await self.resolve(
                    query,
                    author,
                    include_adult=include_adult,
                )

        results = await asyncio.gather(
            *(resolve_one(query, author, include_adult) for query, author, include_adult in items)
        )
        return BatchResolveResponse(
            results=results,
            fetched_at=datetime.now(timezone.utc),
        )

    @staticmethod
    def _select_response(
        query: str,
        public: ResolveResponse,
        authenticated: ResolveResponse,
    ) -> ResolveResponse:
        if authenticated.status == "found" and public.status == "found":
            public_literal = ResolveCoordinator._is_literal_title_match(query, public)
            authenticated_literal = ResolveCoordinator._is_literal_title_match(
                query,
                authenticated,
            )
            if public_literal != authenticated_literal:
                return authenticated if authenticated_literal else public

            public_metadata = public.metadata
            authenticated_metadata = authenticated.metadata
            if public_metadata is not None and authenticated_metadata is not None:
                same_normalized_title = normalize_title(
                    public_metadata.title
                ) == normalize_title(authenticated_metadata.title)
                public_author = normalize_author(public_metadata.author or "")
                authenticated_author = normalize_author(
                    authenticated_metadata.author or ""
                )
                if (
                    same_normalized_title
                    and public_author
                    and authenticated_author
                    and public_author != authenticated_author
                ):
                    return public.model_copy(
                        update={
                            "status": "ambiguous",
                            "confidence": max(
                                public.confidence,
                                authenticated.confidence,
                            ),
                            "match_type": "ambiguous",
                            "metadata_quality": None,
                            "metadata": None,
                        }
                    )

            match_priority = {
                "exact_title_and_author": 3,
                "exact_title": 2,
                "fuzzy_title": 1,
                "ambiguous": 0,
                None: 0,
            }
            public_rank = (
                match_priority[public.match_type],
                public.confidence,
                int(public.metadata_quality == "full"),
            )
            authenticated_rank = (
                match_priority[authenticated.match_type],
                authenticated.confidence,
                int(authenticated.metadata_quality == "full"),
            )
            return authenticated if authenticated_rank > public_rank else public

        if authenticated.status == "found":
            return authenticated
        if public.status == "found":
            return public
        if authenticated.status == "ambiguous":
            return authenticated
        if public.status == "ambiguous":
            return public
        if authenticated.status == "failed" and public.status == "not_found":
            return authenticated
        if public.status == "failed" and authenticated.status == "not_found":
            return authenticated
        return public

    @staticmethod
    def _is_literal_title_match(query: str, response: ResolveResponse) -> bool:
        return response.metadata is not None and literal_titles_match(
            query,
            response.metadata.title,
        )
