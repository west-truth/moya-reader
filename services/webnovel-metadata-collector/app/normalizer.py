import re
import unicodedata
from difflib import SequenceMatcher


_BRACKETED_TEXT = re.compile(r"\[([^\]]*)]|\(([^)]*)\)|【([^】]*)】|（([^）]*)）")
_NON_WORD = re.compile(r"[^0-9a-z가-힣]+")
_KNOWN_LIBRARY_EXTENSION = re.compile(
    r"\.(?:txt|md|markdown|epub|pdf|mobi|azw3?|fb2|zip|cbz|rar|cbr|7z|cb7)$",
    re.IGNORECASE,
)
_TRAILING_FILE_COPY_SUFFIX = re.compile(r"\s+\([1-9]\d{0,3}\)\s*$")
_LEADING_NOISE_GROUP = re.compile(
    r"^\s*[\[(（【](?:텍본|웹소설|카카오페이지|네이버\s*시리즈|리디|노벨피아|문피아|"
    r"digital|raw|scan|scans|kor|korean|jpn|japanese|eng|english)[\])）】]+\s*",
    re.IGNORECASE,
)
_TRAILING_TOTAL_COUNT = re.compile(
    r"\s+\(?\s*총\s*\d[\d,]*(?:\.\d+)?\s*(?:화|회|장|권|편)"
    r"(?:\s*[/|·-]?\s*(?:완결작?|완료|완|完結|完|연재중|미완결|ongoing|complete|completed))?"
    r"\s*\)?\s*$",
    re.IGNORECASE,
)
_TRAILING_EXPLICIT_RELEASE = re.compile(
    r"\s+(?:(?:제\s*|第\s*)?\d{1,6}(?:\.\d+)?(?:\s*[-~]\s*\d{1,6}(?:\.\d+)?)?\s*"
    r"(?:화|회|話|장|권|巻|편)|(?:chapter|ch(?:apter)?\.?|episode|ep(?:isode)?\.?)\s*"
    r"\d{1,6}(?:\.\d+)?(?:\s*[-~]\s*\d{1,6}(?:\.\d+)?)?|s\d{1,3}\s*e\d{1,6}(?:\.\d+)?)"
    r"\s*$",
    re.IGNORECASE,
)
_TRAILING_BARE_RANGE = re.compile(
    r"\s+\d{1,6}(?:\.\d+)?\s*[-~]\s*\d{1,6}(?:\.\d+)?\s*$"
)
_TRAILING_NOISE_GROUP = re.compile(
    r"\s*[\[(（【](?:digital|web|raw|scan|scans|kor|korean|jpn|japanese|eng|english|텍본|웹소설|"
    r"카카오페이지|네이버\s*시리즈|리디|노벨피아|문피아|\d{3,4}p|\d{3,5}px|(?:x|h)26[45]|"
    r"avif|webp|complete|completed|완결작?|완료|완|完結|完)[\])）】]+\s*$",
    re.IGNORECASE,
)
_TRAILING_NOISE_TOKEN = re.compile(
    r"\s+(?:digital|raw|텍본|웹소설|\d{3,4}p|\d{3,5}px|(?:x|h)26[45]|complete|completed|"
    r"완결작?|완료|완|完結|完|연재중|미완결|ongoing)\s*$",
    re.IGNORECASE,
)
_AUTHOR_PREFIX = re.compile(r"^(?:글|저자|작가|원작)\s*[:：]?\s*")
_AUTHOR_SEPARATOR = re.compile(r"\s*(?:,|/|&|·|ㆍ|\||\band\b)\s*")
_AUTHOR_ALIAS = re.compile(r"\[[^\]]*]|\([^)]*\)|【[^】]*】|（[^）]*）")
_VARIANT_PATTERN = (
    r"특별\s*외전|외전|특별편|특별판|후일담|본편|단행본|연재본|완전판|합본|"
    r"(?:15세\s*)?개정(?:증보)?판|리마스터(?:판)?|리메이크|remake|"
    r"side\s*story|spin[-\s]*off|시즌\s*[0-9ivx]+|season\s*[0-9ivx]+|"
    r"part\s*[0-9ivx]+|제?\s*\d+\s*부"
)
_VARIANT_MARKER = re.compile(_VARIANT_PATTERN, re.IGNORECASE)
_VARIANT_SUFFIX = re.compile(
    rf"\s*(?:[-–—:：|/]\s*)?(?:{_VARIANT_PATTERN})\s*$",
    re.IGNORECASE,
)
_COSMETIC_LABELS = {
    "d",
    "bl",
    "gl",
    "novel",
    "독점",
    "독점완결",
    "독점연재",
    "리디only",
    "19금",
    "19세",
    "성인",
    "매일무료",
    "무료",
    "무료연재",
    "선공개",
    "완결",
    "완결작",
    "웹소설",
    "연재",
    "연재중",
}


def _unicode_text(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _strip_cosmetic_label(match: re.Match[str], *, preserve_brackets: bool = False) -> str:
    content = next((group for group in match.groups() if group is not None), "")
    normalized = _NON_WORD.sub("", _unicode_text(content))
    if normalized in _COSMETIC_LABELS:
        return ""
    if _VARIANT_MARKER.search(content):
        return ""

    # 국내 플랫폼은 한글 본제목 뒤에 영문 번역명을 괄호로 병기하기도 한다.
    # 영문 병기 때문에 동일 제목의 점수가 낮아지지 않게 한다.
    latin_label = _unicode_text(content).strip()
    if (
        len(normalized) >= 3
        and re.search(r"[a-z]", latin_label)
        and not re.search(r"[가-힣]", latin_label)
    ):
        return ""
    return match.group(0) if preserve_brackets else content


def _title_source(title: str, *, preserve_brackets: bool = False) -> str:
    value = _unicode_text(title).replace("_", " ").strip()
    stripped_file_extension = False
    while True:
        stripped = _KNOWN_LIBRARY_EXTENSION.sub("", value).strip()
        if stripped == value:
            break
        stripped_file_extension = True
        value = stripped

    # OS/browser duplicate names append `` (N)`` before the extension. Require
    # actual filename evidence so a real title ending in ``(1)`` stays intact.
    if stripped_file_extension:
        value = _TRAILING_FILE_COPY_SUFFIX.sub("", value).strip()
        while True:
            stripped = _KNOWN_LIBRARY_EXTENSION.sub("", value).strip()
            if stripped == value:
                break
            value = stripped

    previous = ""
    while value != previous:
        previous = value
        value = _LEADING_NOISE_GROUP.sub("", value)
        value = _TRAILING_TOTAL_COUNT.sub("", value)
        value = _TRAILING_NOISE_GROUP.sub("", value)
        value = _TRAILING_NOISE_TOKEN.sub("", value)
        value = _TRAILING_EXPLICIT_RELEASE.sub("", value)
        value = _TRAILING_BARE_RANGE.sub("", value)
        value = value.strip(" -–—_:：|")

    value = _BRACKETED_TEXT.sub(
        lambda match: _strip_cosmetic_label(match, preserve_brackets=preserve_brackets),
        value,
    )
    while True:
        stripped = _VARIANT_SUFFIX.sub("", value).strip()
        if not stripped or stripped == value:
            return " ".join(value.split())
        value = stripped


def search_title(title: str) -> str:
    """Return a conservative catalog query while preserving the stored title."""
    return _title_source(title, preserve_brackets=True)


def normalize_title(title: str) -> str:
    return _NON_WORD.sub("", _title_source(title))


def literal_title_key(title: str) -> str:
    return " ".join(_unicode_text(title).split())


def literal_titles_match(left: str, right: str) -> bool:
    return bool(left and right) and literal_title_key(left) == literal_title_key(right)


def title_variant_tokens(title: str) -> set[str]:
    source = _unicode_text(title)
    return {
        _NON_WORD.sub("", match.group(0))
        for match in _VARIANT_MARKER.finditer(source)
        if _NON_WORD.sub("", match.group(0))
    }


def author_names(author: str) -> set[str]:
    value = _unicode_text(author)
    names: set[str] = set()
    for part in _AUTHOR_SEPARATOR.split(value):
        without_alias = _AUTHOR_ALIAS.sub("", part)
        without_prefix = _AUTHOR_PREFIX.sub("", without_alias)
        normalized = _NON_WORD.sub("", without_prefix)
        if normalized:
            names.add(normalized)
    return names


def normalize_author(author: str) -> str:
    return "|".join(sorted(author_names(author)))


def authors_match(query_author: str, candidate_author: str) -> bool:
    return bool(author_names(query_author) & author_names(candidate_author))


def title_match_score(query: str, title: str) -> float:
    normalized_query = normalize_title(query)
    normalized_title = normalize_title(title)

    if not normalized_query or not normalized_title:
        return 0.0
    if normalized_query == normalized_title:
        return 1.0

    return round(SequenceMatcher(None, normalized_query, normalized_title).ratio(), 3)
