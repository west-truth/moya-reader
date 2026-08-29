import html
import re

from bs4 import BeautifulSoup

from app.models import NovelMetadata, NovelStatus


_WHITESPACE = re.compile(r"\s+")
_STATUS_MAP: dict[str, NovelStatus] = {
    "ongoing": "ongoing",
    "serializing": "ongoing",
    "연재": "ongoing",
    "연재중": "ongoing",
    "미완결": "ongoing",
    "complete": "completed",
    "completed": "completed",
    "완결": "completed",
    "hiatus": "hiatus",
    "paused": "hiatus",
    "휴재": "hiatus",
    "unknown": "unknown",
}


def normalize_metadata(metadata: NovelMetadata) -> NovelMetadata:
    return metadata.model_copy(
        update={
            "title": _clean_text(metadata.title) or metadata.title,
            "author": _clean_text(metadata.author),
            "source_url": metadata.source_url.strip(),
            "cover_url": metadata.cover_url.strip() if metadata.cover_url else None,
            "description": _clean_description(metadata.description),
            "genres": _clean_terms(metadata.genres),
            "tags": _clean_terms(metadata.tags),
            "status": _STATUS_MAP.get(metadata.status or "", "unknown"),
        }
    )


def _clean_description(value: str | None) -> str | None:
    if not value:
        return None
    decoded = html.unescape(value)
    if "<" in decoded and ">" in decoded:
        decoded = BeautifulSoup(decoded, "lxml").get_text(" ", strip=True)
    return _clean_text(decoded)


def _clean_text(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = _WHITESPACE.sub(" ", value).strip()
    return cleaned or None


def _clean_terms(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = (_clean_text(value) or "").lstrip("#").strip()
        key = cleaned.casefold()
        if cleaned and key not in seen:
            result.append(cleaned)
            seen.add(key)
    return result
