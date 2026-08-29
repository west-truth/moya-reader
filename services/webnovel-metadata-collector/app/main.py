from contextlib import asynccontextmanager
import hmac
import os
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from app.auth_session import AUTH_PLATFORMS, AuthFeatureUnavailable, AuthSessionManager
from app.authenticated_extractor import AuthenticatedExtractor
from app.cover_delivery import (
    ALLOWED_COVER_CONTENT_TYPES,
    COVER_REF_TTL_SECONDS,
    MAX_COVER_BYTES,
    CoverFetcher,
    CoverReferenceStore,
    CoverTooLargeError,
    CoverUpstreamError,
    CoverUpstreamTimeoutError,
    UnsafeCoverUrlError,
    UnsupportedCoverImageError,
)
from app.extractors import (
    KakaoPageExtractor,
    MunpiaExtractor,
    NaverSeriesExtractor,
    NovelpiaExtractor,
    RidiExtractor,
)
from app.models import (
    BatchResolveRequest,
    BatchResolveResponse,
    AuthActionRequest,
    AuthPlatformUpdate,
    AuthStatusResponse,
    RemoteBrowserAction,
    ResolveResponse,
    SearchResponse,
)
from app.resolve_coordinator import ResolveCoordinator
from app.search_service import SearchService


search_service = SearchService(
    [
        MunpiaExtractor(),
        NaverSeriesExtractor(),
        KakaoPageExtractor(),
        NovelpiaExtractor(),
        RidiExtractor(),
    ]
)
auth_sessions = AuthSessionManager()
resolve_coordinator = ResolveCoordinator(
    search_service,
    auth_sessions,
    [
        AuthenticatedExtractor(auth_sessions, NaverSeriesExtractor()),
        AuthenticatedExtractor(auth_sessions, KakaoPageExtractor()),
        AuthenticatedExtractor(auth_sessions, NovelpiaExtractor()),
        AuthenticatedExtractor(auth_sessions, RidiExtractor()),
    ],
)
cover_refs = CoverReferenceStore()
cover_fetcher = CoverFetcher()

SERVICE_NAME = "webnovel-metadata-collector"
SERVICE_VERSION = "0.1.0"
API_VERSION = 1
LOCAL_UI_HOSTS = {"127.0.0.1", "localhost", "::1", "tauri.localhost"}
SESSION_TOKEN_HEADER = "X-Moya-Collector-Token"
LOCAL_DEV_ORIGIN_PATTERN = (
    r"^(?:https?://(?:localhost|127\.0\.0\.1|\[::1\]|tauri\.localhost)(?::\d{1,5})?"
    r"|tauri://localhost)$"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await search_service.aclose()
    await auth_sessions.aclose()
    await cover_fetcher.aclose()


app = FastAPI(
    title="웹소설 메타데이터 수집기",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=LOCAL_DEV_ORIGIN_PATTERN,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", SESSION_TOKEN_HEADER],
    expose_headers=["Content-Length", "Content-Type", "Cache-Control"],
)
web_root = Path(__file__).parent / "web"


@app.middleware("http")
async def require_managed_session(request: Request, call_next):
    expected = os.environ.get("MOYA_COLLECTOR_SESSION_TOKEN", "").strip()
    if expected and request.method != "OPTIONS":
        supplied = request.headers.get(SESSION_TOKEN_HEADER, "")
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse(
                status_code=401,
                content={"detail": "Moya 수집기 세션이 올바르지 않습니다."},
                headers={"Cache-Control": "no-store"},
            )
    return await call_next(request)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(
        web_root / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "api_version": API_VERSION,
        "capabilities": {
            "resolve": {"version": 1},
            "batch_resolve": {"version": 1, "max_items": 50},
            "diagnostic_search": {"version": 1},
            "cover_ref": {
                "version": 1,
                "path": "/api/v1/covers/{cover_ref}",
                "ttl_seconds": COVER_REF_TTL_SECONDS,
                "max_bytes": MAX_COVER_BYTES,
                "content_types": list(ALLOWED_COVER_CONTENT_TYPES),
            },
            "adult_auth": {
                "version": 1,
                "available": auth_sessions.available,
                "browser_presentation": auth_sessions.browser_presentation,
                "platforms": list(AUTH_PLATFORMS),
            },
        },
    }


@app.get("/api/v1/search", response_model=SearchResponse)
async def search_novel(
    q: str = Query(min_length=2, max_length=100),
    limit: int = Query(default=3, ge=1, le=5),
) -> SearchResponse:
    query = _clean_query(q)
    return await search_service.search(query, limit)


@app.get("/api/v1/resolve", response_model=ResolveResponse)
async def resolve_novel(
    request: Request,
    q: str = Query(min_length=2, max_length=100),
    author: str | None = Query(default=None, min_length=1, max_length=100),
    include_adult: bool = Query(default=False),
) -> ResolveResponse:
    if include_adult:
        _require_local_request(request)
    clean_author = author.strip() if author else None
    response = await resolve_coordinator.resolve(
        _clean_query(q),
        clean_author or None,
        include_adult=include_adult,
    )
    return _with_cover_ref(response)


@app.post("/api/v1/resolve/batch", response_model=BatchResolveResponse)
async def resolve_novels(
    request: Request,
    payload: BatchResolveRequest,
) -> BatchResolveResponse:
    if any(item.include_adult for item in payload.items):
        _require_local_request(request)
    items = [
        (
            _clean_query(item.query),
            (item.author.strip() if item.author else None) or None,
            item.include_adult,
        )
        for item in payload.items
    ]
    response = await resolve_coordinator.resolve_batch(items)
    return response.model_copy(
        update={"results": [_with_cover_ref(item) for item in response.results]}
    )


@app.get("/api/v1/covers/{cover_ref}")
async def download_cover(cover_ref: str) -> Response:
    reference = cover_refs.get(cover_ref)
    if reference is None:
        raise HTTPException(status_code=404, detail="표지 참조가 없거나 만료되었습니다.")

    try:
        cover = await cover_fetcher.fetch(reference)
    except CoverTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except UnsupportedCoverImageError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except CoverUpstreamTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except (UnsafeCoverUrlError, CoverUpstreamError) as exc:
        raise HTTPException(
            status_code=502,
            detail="표지 이미지를 안전하게 가져오지 못했습니다.",
        ) from exc

    return Response(
        content=cover.content,
        media_type=cover.content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/v1/auth/status", response_model=AuthStatusResponse)
async def auth_status(request: Request) -> AuthStatusResponse:
    _require_local_request(request)
    return AuthStatusResponse(**auth_sessions.status())


@app.post("/api/v1/auth/{platform}/open", response_model=AuthStatusResponse)
async def open_auth_browser(
    platform: str,
    payload: AuthActionRequest,
    request: Request,
) -> AuthStatusResponse:
    _require_local_request(request)
    _require_auth_platform(platform)
    if not payload.requested:
        raise HTTPException(status_code=422, detail="브라우저 열기 요청이 필요합니다.")
    try:
        await auth_sessions.open_login(
            platform,
            viewport_width=payload.viewport_width,
            viewport_height=payload.viewport_height,
        )
    except AuthFeatureUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return AuthStatusResponse(**auth_sessions.status())


@app.put("/api/v1/auth/{platform}", response_model=AuthStatusResponse)
async def update_auth_platform(
    platform: str,
    payload: AuthPlatformUpdate,
    request: Request,
) -> AuthStatusResponse:
    _require_local_request(request)
    _require_auth_platform(platform)
    if payload.enabled:
        try:
            await auth_sessions.finish_login()
        except AuthFeatureUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    auth_sessions.set_enabled(platform, payload.enabled)
    return AuthStatusResponse(**auth_sessions.status())


@app.post("/api/v1/auth/browser/close", response_model=AuthStatusResponse)
async def close_auth_browser(
    payload: AuthActionRequest,
    request: Request,
) -> AuthStatusResponse:
    _require_local_request(request)
    if payload.requested:
        try:
            await auth_sessions.close_browser()
        except AuthFeatureUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AuthStatusResponse(**auth_sessions.status())


@app.get("/api/v1/auth/browser/frame")
async def remote_auth_browser_frame(
    request: Request,
    after_revision: int = Query(default=0, ge=0, le=2_147_483_647),
) -> Response:
    _require_local_request(request)
    try:
        frame = await auth_sessions.remote_frame(after_revision)
    except AuthFeatureUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if frame is None:
        return Response(
            status_code=204,
            headers={
                "Cache-Control": "private, no-store",
                "X-Moya-Frame-Revision": str(after_revision),
            },
        )
    return Response(
        content=frame["content"],
        media_type="image/jpeg",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Moya-Frame-Revision": str(frame["revision"]),
            "X-Moya-Frame-Width": str(frame["width"]),
            "X-Moya-Frame-Height": str(frame["height"]),
        },
    )


@app.post("/api/v1/auth/browser/action", status_code=204)
async def remote_auth_browser_action(
    payload: RemoteBrowserAction,
    request: Request,
) -> Response:
    _require_local_request(request)
    try:
        await auth_sessions.remote_action(
            payload.action,
            x=payload.x,
            y=payload.y,
            text=payload.text,
            key=payload.key,
            delta_y=payload.delta_y,
        )
    except AuthFeatureUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(status_code=204, headers={"Cache-Control": "private, no-store"})


@app.delete("/api/v1/auth/session", response_model=AuthStatusResponse)
async def clear_auth_session(request: Request) -> AuthStatusResponse:
    _require_local_request(request)
    try:
        await auth_sessions.clear_session()
    except AuthFeatureUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return AuthStatusResponse(**auth_sessions.status())


def _clean_query(value: str) -> str:
    cleaned = value.strip()
    if len(cleaned) < 2:
        raise HTTPException(status_code=422, detail="작품명을 두 글자 이상 입력해 주세요.")
    return cleaned


def _with_cover_ref(response: ResolveResponse) -> ResolveResponse:
    metadata = response.metadata
    if response.status != "found" or metadata is None or not metadata.cover_url:
        return response
    try:
        reference = cover_refs.issue(
            metadata.platform,
            metadata.platform_work_id,
            metadata.cover_url,
        )
    except UnsafeCoverUrlError:
        return response
    return response.model_copy(update={"cover_ref": reference})


def _require_auth_platform(platform: str) -> None:
    if platform not in AUTH_PLATFORMS:
        raise HTTPException(status_code=404, detail="지원하지 않는 인증 플랫폼입니다.")


def _require_local_request(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin:
        if urlparse(origin).hostname not in LOCAL_UI_HOSTS:
            raise HTTPException(status_code=403, detail="로컬 화면에서만 사용할 수 있습니다.")
        return
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(status_code=403, detail="로컬 화면에서만 사용할 수 있습니다.")
