from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, SecretStr


NovelStatus = Literal["ongoing", "completed", "hiatus", "unknown"]
MatchType = Literal["exact_title_and_author", "exact_title", "fuzzy_title", "ambiguous"]
MetadataQuality = Literal["full", "partial"]


class SearchCandidate(BaseModel):
    title: str
    author: str | None = None
    platform: str
    platform_work_id: str
    source_url: str
    cover_url: str | None = None
    description: str | None = None
    genres: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    status: NovelStatus | None = None
    match_score: float = 0.0


class NovelMetadata(SearchCandidate):
    fetched_at: datetime


class PlatformStatus(BaseModel):
    status: Literal["success", "partial", "no_results", "failed"]
    result_count: int = 0
    error: str | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[NovelMetadata] = Field(default_factory=list)
    platform_status: dict[str, PlatformStatus] = Field(default_factory=dict)
    fetched_at: datetime


class ResolveResponse(BaseModel):
    query: str
    author: str | None = None
    status: Literal["found", "not_found", "ambiguous", "failed"]
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    match_type: MatchType | None = None
    metadata_quality: MetadataQuality | None = None
    metadata: NovelMetadata | None = None
    searched_platforms: int = 0
    failed_platforms: list[str] = Field(default_factory=list)
    platform_errors: dict[str, str] = Field(default_factory=dict)
    skipped_platforms: list[str] = Field(default_factory=list)
    authenticated_search: bool = False
    public_adult_metadata: bool = False
    cover_ref: str | None = None
    fetched_at: datetime


class ResolveRequest(BaseModel):
    query: str = Field(min_length=2, max_length=100)
    author: str | None = Field(default=None, min_length=1, max_length=100)
    include_adult: bool = False


class BatchResolveRequest(BaseModel):
    items: list[ResolveRequest] = Field(min_length=1, max_length=50)


class BatchResolveResponse(BaseModel):
    results: list[ResolveResponse]
    fetched_at: datetime


class AuthPlatformUpdate(BaseModel):
    enabled: bool


class NovelpiaCredentialsRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: SecretStr = Field(min_length=1, max_length=512)


class NovelpiaLoginKeyRequest(BaseModel):
    login_key: SecretStr = Field(min_length=40, max_length=256)


class AuthActionRequest(BaseModel):
    requested: bool = True
    viewport_width: int | None = Field(default=None, ge=360, le=1280)
    viewport_height: int | None = Field(default=None, ge=480, le=900)


class AuthStatusResponse(BaseModel):
    available: bool
    browser_running: bool
    browser_presentation: Literal["local_window", "remote_frame"]
    enabled_platforms: list[str] = Field(default_factory=list)
    last_error: str | None = None
    session_saved_at: str | None = None
    active_platform: str | None = None
    remembered_credential_platforms: list[str] = Field(default_factory=list)


class RemoteBrowserAction(BaseModel):
    action: Literal["click", "text", "fill", "key", "scroll", "back", "forward", "reload", "select_tab", "close_tab"]
    page_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    x: float | None = Field(default=None, ge=0, le=1280)
    y: float | None = Field(default=None, ge=0, le=900)
    text: str | None = Field(default=None, max_length=2048)
    key: str | None = Field(default=None, min_length=1, max_length=32)
    delta_y: float | None = Field(default=None, ge=-4000, le=4000)
