import asyncio
import logging
from datetime import datetime, timezone

import httpx

from app.extractors.base import BaseExtractor
from app.models import (
    BatchResolveResponse,
    NovelMetadata,
    PlatformStatus,
    ResolveResponse,
    SearchCandidate,
    SearchResponse,
)
from app.normalizer import (
    author_names,
    authors_match,
    literal_titles_match,
    normalize_author,
    normalize_title,
    search_title,
    title_match_score,
    title_variant_tokens,
)
from app.postprocessor import normalize_metadata


logger = logging.getLogger(__name__)


class SearchService:
    resolve_threshold = 0.9
    ambiguity_margin = 0.03

    def __init__(
        self,
        extractors: list[BaseExtractor],
        *,
        resolve_timeout: float = 15.0,
        max_concurrent_requests: int = 8,
        batch_concurrency: int = 4,
    ):
        self.extractors = extractors
        self.resolve_timeout = resolve_timeout
        self.batch_concurrency = batch_concurrency
        self._external_request_slots = asyncio.Semaphore(max_concurrent_requests)
        self._platform_order = {
            extractor.platform: index for index, extractor in enumerate(extractors)
        }

    async def search(self, query: str, limit: int = 3) -> SearchResponse:
        original_query = query
        query = search_title(query) or query.strip()
        fetched_at = datetime.now(timezone.utc)
        results: list[NovelMetadata] = []
        platform_status: dict[str, PlatformStatus] = {}

        platform_results = await asyncio.gather(
            *(self._search_platform(extractor, query, limit) for extractor in self.extractors)
        )
        for platform, platform_items, status in platform_results:
            results.extend(platform_items)
            platform_status[platform] = status

        results.sort(key=lambda item: item.match_score, reverse=True)
        return SearchResponse(
            query=original_query,
            results=results,
            platform_status=platform_status,
            fetched_at=fetched_at,
        )

    async def resolve(self, query: str, author: str | None = None) -> ResolveResponse:
        query = query.strip()
        author = author.strip() if author else None
        try:
            return await asyncio.wait_for(
                self._resolve(query, author),
                timeout=self.resolve_timeout,
            )
        except TimeoutError:
            logger.warning("전체 작품 검색 제한시간을 초과했습니다.")
            return ResolveResponse(
                query=query,
                author=author,
                status="failed",
                searched_platforms=0,
                failed_platforms=[extractor.platform for extractor in self.extractors],
                platform_errors={
                    extractor.platform: "전체 검색 제한시간이 초과되었습니다."
                    for extractor in self.extractors
                },
                fetched_at=datetime.now(timezone.utc),
            )

    async def resolve_batch(
        self,
        items: list[tuple[str, str | None]],
    ) -> BatchResolveResponse:
        item_slots = asyncio.Semaphore(self.batch_concurrency)

        async def resolve_one(query: str, author: str | None) -> ResolveResponse:
            async with item_slots:
                return await self.resolve(query, author)

        results = await asyncio.gather(
            *(resolve_one(query, author) for query, author in items)
        )
        return BatchResolveResponse(
            results=results,
            fetched_at=datetime.now(timezone.utc),
        )

    async def aclose(self) -> None:
        await asyncio.gather(*(extractor.aclose() for extractor in self.extractors))

    async def _resolve(self, query: str, author: str | None) -> ResolveResponse:
        fetched_at = datetime.now(timezone.utc)
        lookup_query = search_title(query) or query
        platform_results, skipped_platforms = await self._collect_resolution_searches(
            lookup_query,
            author,
        )
        failed_platforms = [
            extractor.platform
            for extractor, _, status in platform_results
            if status.status == "failed"
        ]
        diagnostics = {
            "searched_platforms": len(platform_results) - len(failed_platforms),
            "failed_platforms": failed_platforms,
            "platform_errors": {
                extractor.platform: status.error
                for extractor, _, status in platform_results
                if status.error
            },
            "skipped_platforms": skipped_platforms,
        }
        entries = [
            (extractor, candidate)
            for extractor, candidates, _ in platform_results
            for candidate in candidates
        ]

        if not entries:
            all_failed = all(status.status == "failed" for _, _, status in platform_results)
            return ResolveResponse(
                query=query,
                author=author,
                status="failed" if all_failed else "not_found",
                **diagnostics,
                fetched_at=fetched_at,
            )

        normalized_author = normalize_author(author) if author else ""
        if normalized_author:
            entries = [
                entry
                for entry in entries
                if authors_match(author or "", entry[1].author or "")
            ]
            if not entries:
                return ResolveResponse(
                    query=query,
                    author=author,
                    status="not_found",
                    **diagnostics,
                    fetched_at=fetched_at,
                )

        normalized_query = normalize_title(query)
        exact_entries = [
            entry for entry in entries if normalize_title(entry[1].title) == normalized_query
        ]
        literal_exact_entries = [
            entry for entry in exact_entries if literal_titles_match(query, entry[1].title)
        ]
        preferred_exact_entries = self._preferred_exact_entries(query, exact_entries)
        candidates = literal_exact_entries or preferred_exact_entries or exact_entries or entries
        ranked = sorted(
            candidates,
            key=lambda entry: self._resolution_rank(entry, query, author),
            reverse=True,
        )
        best_score = ranked[0][1].match_score

        if not exact_entries and best_score < self.resolve_threshold:
            return ResolveResponse(
                query=query,
                author=author,
                status="not_found",
                **diagnostics,
                fetched_at=fetched_at,
            )

        if self._is_ambiguous(
            ranked,
            exact=bool(exact_entries),
            author_supplied=bool(normalized_author),
        ):
            return ResolveResponse(
                query=query,
                author=author,
                status="ambiguous",
                confidence=best_score,
                match_type="ambiguous",
                **diagnostics,
                fetched_at=fetched_at,
            )

        extractor, winner = ranked[0]
        metadata_quality = "full"
        try:
            metadata = await self._get_detail(extractor, winner)
        except Exception as exc:
            logger.warning("%s 상세 조회 실패: %s", extractor.platform, exc)
            if not winner.cover_url:
                return ResolveResponse(
                    query=query,
                    author=author,
                    status="failed",
                    confidence=winner.match_score,
                    **diagnostics,
                    fetched_at=fetched_at,
                )
            metadata = NovelMetadata(
                **winner.model_dump(),
                fetched_at=datetime.now(timezone.utc),
            )
            metadata_quality = "partial"

        metadata = normalize_metadata(metadata)

        if not metadata.cover_url:
            return ResolveResponse(
                query=query,
                author=author,
                status="not_found",
                confidence=winner.match_score,
                **diagnostics,
                fetched_at=fetched_at,
            )

        match_type = (
            "exact_title_and_author"
            if exact_entries and normalized_author
            else "exact_title"
            if exact_entries
            else "fuzzy_title"
        )
        return ResolveResponse(
            query=query,
            author=author,
            status="found",
            confidence=winner.match_score,
            match_type=match_type,
            metadata_quality=metadata_quality,
            metadata=metadata,
            **diagnostics,
            fetched_at=fetched_at,
        )

    async def _search_platform(
        self,
        extractor: BaseExtractor,
        query: str,
        limit: int,
    ) -> tuple[str, list[NovelMetadata], PlatformStatus]:
        _, candidates, search_status = await self._search_candidates(extractor, query)
        if search_status.status != "success":
            return extractor.platform, [], search_status

        selected = sorted(
            candidates,
            key=lambda candidate: candidate.match_score,
            reverse=True,
        )[:limit]
        detail_results = await asyncio.gather(
            *(self._get_detail(extractor, candidate) for candidate in selected),
            return_exceptions=True,
        )

        results: list[NovelMetadata] = []
        detail_failures = 0
        for candidate, detail_result in zip(selected, detail_results, strict=True):
            if isinstance(detail_result, BaseException):
                detail_failures += 1
                results.append(
                    normalize_metadata(NovelMetadata(
                        **candidate.model_dump(),
                        fetched_at=datetime.now(timezone.utc),
                    ))
                )
            else:
                results.append(normalize_metadata(detail_result))

        return (
            extractor.platform,
            results,
            PlatformStatus(
                status="partial" if detail_failures else "success",
                result_count=len(results),
                error=(
                    f"상세 정보 {detail_failures}건을 가져오지 못해 검색 결과로 대체했습니다."
                    if detail_failures
                    else None
                ),
            ),
        )

    async def _collect_resolution_searches(
        self,
        query: str,
        author: str | None,
    ) -> tuple[
        list[tuple[BaseExtractor, list[SearchCandidate], PlatformStatus]],
        list[str],
    ]:
        task_extractors = {
            asyncio.create_task(self._search_candidates(extractor, query)): extractor
            for extractor in self.extractors
        }
        pending = set(task_extractors)
        results: list[tuple[BaseExtractor, list[SearchCandidate], PlatformStatus]] = []

        while pending:
            done, pending = await asyncio.wait(
                pending,
                return_when=asyncio.FIRST_COMPLETED,
            )
            results.extend(task.result() for task in done)
            if self._has_early_confirmation(results, query, author):
                skipped = {
                    task_extractors[task].platform
                    for task in pending
                }
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                skipped_platforms = [
                    extractor.platform
                    for extractor in self.extractors
                    if extractor.platform in skipped
                ]
                return results, skipped_platforms

        return results, []

    @staticmethod
    def _has_early_confirmation(
        platform_results: list[
            tuple[BaseExtractor, list[SearchCandidate], PlatformStatus]
        ],
        query: str,
        author: str | None,
    ) -> bool:
        normalized_query = normalize_title(query)
        exact_entries = [
            (extractor, candidate)
            for extractor, candidates, _ in platform_results
            for candidate in candidates
            if normalize_title(candidate.title) == normalized_query
        ]
        literal_exact_entries = [
            entry for entry in exact_entries if literal_titles_match(query, entry[1].title)
        ]
        if literal_exact_entries:
            exact_entries = literal_exact_entries

        if author:
            return any(
                candidate.cover_url
                and literal_titles_match(query, candidate.title)
                and authors_match(author, candidate.author or "")
                for _, candidate in exact_entries
            )

        known_entries = [
            (extractor, candidate, author_names(candidate.author or ""))
            for extractor, candidate in exact_entries
            if author_names(candidate.author or "")
        ]
        for index, (extractor, candidate, names) in enumerate(known_entries):
            for other_extractor, other_candidate, other_names in known_entries[index + 1 :]:
                shared_names = names & other_names
                if extractor.platform == other_extractor.platform or not shared_names:
                    continue
                if not (candidate.cover_url or other_candidate.cover_url):
                    continue
                if all(entry_names & shared_names for _, _, entry_names in known_entries):
                    return True
        return False

    async def _search_candidates(
        self,
        extractor: BaseExtractor,
        query: str,
    ) -> tuple[BaseExtractor, list[SearchCandidate], PlatformStatus]:
        try:
            async with self._external_request_slots:
                candidates = await extractor.search(query)
        except Exception as exc:
            logger.warning("%s 검색 실패: %s", extractor.platform, exc)
            return (
                extractor,
                [],
                PlatformStatus(status="failed", error=self._public_error(exc)),
            )

        if not candidates:
            return extractor, [], PlatformStatus(status="no_results")

        for candidate in candidates:
            candidate.match_score = title_match_score(query, candidate.title)

        return (
            extractor,
            candidates,
            PlatformStatus(status="success", result_count=len(candidates)),
        )

    async def _get_detail(
        self,
        extractor: BaseExtractor,
        candidate: SearchCandidate,
    ) -> NovelMetadata:
        async with self._external_request_slots:
            return await extractor.get_detail(candidate)

    @staticmethod
    def _preferred_exact_entries(
        query: str,
        entries: list[tuple[BaseExtractor, SearchCandidate]],
    ) -> list[tuple[BaseExtractor, SearchCandidate]]:
        """Prefer the base work when title normalization also collapses editions or side stories."""
        if not entries or title_variant_tokens(query):
            return entries
        base_work_entries = [
            entry for entry in entries if not title_variant_tokens(entry[1].title)
        ]
        return base_work_entries or entries

    def _resolution_rank(
        self,
        entry: tuple[BaseExtractor, SearchCandidate],
        query: str,
        author: str | None,
    ) -> tuple[int, int, float, int, int, int]:
        _, candidate = entry
        query_variants = title_variant_tokens(query)
        candidate_variants = title_variant_tokens(candidate.title)
        if query_variants:
            variant_preference = (
                2
                if query_variants == candidate_variants
                else 1
                if candidate_variants
                else 0
            )
        else:
            variant_preference = int(not candidate_variants)
        completeness = sum(
            (
                bool(candidate.cover_url),
                bool(candidate.description),
                bool(candidate.author),
                bool(candidate.genres),
                bool(candidate.tags),
            )
        )
        platform_priority = -self._platform_order[candidate.platform]
        return (
            int(literal_titles_match(query, candidate.title)),
            int(bool(author) and authors_match(author or "", candidate.author or "")),
            candidate.match_score,
            variant_preference,
            completeness,
            platform_priority,
        )

    def _is_ambiguous(
        self,
        ranked: list[tuple[BaseExtractor, SearchCandidate]],
        *,
        exact: bool,
        author_supplied: bool,
    ) -> bool:
        if len(ranked) < 2:
            return False

        best = ranked[0][1]
        best_identity = (normalize_title(best.title), normalize_author(best.author or ""))
        distinct = [
            candidate
            for _, candidate in ranked[1:]
            if (normalize_title(candidate.title), normalize_author(candidate.author or ""))
            != best_identity
        ]
        if not distinct:
            return False

        if exact and not author_supplied:
            known_authors = {
                normalize_author(candidate.author or "")
                for _, candidate in ranked
                if candidate.author
            }
            return len(known_authors) > 1

        return best.match_score - distinct[0].match_score < self.ambiguity_margin

    @staticmethod
    def _public_error(exc: Exception) -> str:
        if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
            return "플랫폼 응답 시간이 초과되었습니다."
        message = " ".join(str(exc).split())
        safe_prefixes = (
            "인증",
            "로그인",
            "설치된 Chrome",
            "Chrome 또는 Edge",
            "노벨피아",
            "네이버 시리즈",
            "카카오페이지",
            "리디",
        )
        if 0 < len(message) <= 180 and message.startswith(safe_prefixes):
            return message
        return "플랫폼에서 검색 결과를 가져오지 못했습니다."
