# 웹소설 메타데이터 수집기 구조

이 문서는 현재 구현된 프로그램의 구성과 실행 흐름을 설명한다. 목표는 소설 뷰어가 작품명과 선택적인 작가명을 전달하면, 여러 웹소설 플랫폼에서 후보를 찾고 가장 적합한 작품 한 건의 표지 URL과 메타데이터를 반환하는 것이다.

이 문서는 장래 구상이 아니라 현재 코드의 동작을 기준으로 한다.

## 1. 범위와 설계 기준

- 기본 경로는 DB와 캐시 없이 외부 플랫폼을 실시간 조회한다.
- 문피아, 네이버 시리즈, 카카오페이지, 노벨피아, 리디를 지원한다.
- `/api/v1/resolve`는 자동 적용에 사용할 결과 한 건만 반환한다.
- `/api/v1/search`는 플랫폼별 후보와 수집 상태를 확인하는 진단용 API다.
- 플랫폼 검색은 병렬로 실행하지만 최종 후보 한 건만 상세 조회한다.
- 검색 경로는 표지 이미지를 미리 저장하지 않고 원본 URL을 반환한다. Moya용 binary는 resolve가 발급한
  짧은 수명의 opaque ref와 제한된 endpoint를 통해 요청 시에만 전달한다.
- 성인 작품 검색은 기본적으로 꺼져 있으며, 사용자가 직접 로그인한 전용 브라우저 프로필을 사용하는 선택 기능이다.
- 한 플랫폼의 장애가 다른 플랫폼의 정상 결과를 막지 않도록 부분 실패 정보를 응답에 포함한다.

## 2. 전체 구성

```text
브라우저 UI / 소설 뷰어
          │
          │ HTTP JSON
          ▼
app/main.py (FastAPI, 입력 검증, 로컬 인증 API 보호)
          │
          ▼
ResolveCoordinator
    ├─ 공개 검색 SearchService
    │    ├─ MunpiaExtractor
    │    ├─ NaverSeriesExtractor
    │    ├─ KakaoPageExtractor
    │    ├─ NovelpiaExtractor
    │    └─ RidiExtractor
    │
    └─ 선택적 인증 검색 SearchService
         └─ AuthenticatedExtractor
              ├─ 원래 플랫폼 파서 재사용
              └─ AuthSessionManager 또는 플랫폼 공개 API

선정된 후보
    └─ 상세 조회 → 공통 후처리 → ResolveResponse 한 건
```

프로그램은 `app/main.py`를 불러올 때 다음 장기 객체를 한 번 만든다.

1. 공개 플랫폼 수집기 다섯 개를 가진 `SearchService`
2. 인증 전용 브라우저 프로필을 관리하는 `AuthSessionManager`
3. 공개 검색과 인증 검색 결과를 조정하는 `ResolveCoordinator`
4. 최대 512개의 15분 표지 ref를 관리하는 store와 허용된 표지만 가져오는 `CoverFetcher`

FastAPI 종료 시 공개 수집기와 표지 fetcher의 HTTP 연결, 인증 브라우저 컨텍스트를 정리한다.

## 3. 디렉터리와 파일 책임

```text
app/
├─ main.py                    FastAPI 앱, 라우트, 객체 조립, 입력·접근 검증
├─ models.py                  API 및 내부 전달용 Pydantic 모델
├─ resolve_coordinator.py     공개 검색과 인증 검색의 실행·결과 병합
├─ search_service.py          병렬 검색, 점수 계산, 후보 결정, 상세 조회
├─ normalizer.py              제목·작가 정규화와 제목 유사도 계산
├─ postprocessor.py           설명·장르·태그·상태값 공통 후처리
├─ auth_session.py            전용 브라우저 프로필과 인증 요청 관리
├─ authenticated_extractor.py 인증 세션을 플랫폼 파서에 연결하는 어댑터
├─ cover_delivery.py          opaque ref, 표지 host/redirect/크기/format 검증
├─ extractors/
│  ├─ base.py                 공통 비동기 HTTP 클라이언트와 수집기 인터페이스
│  ├─ munpia.py               문피아 검색·상세 파서
│  ├─ naver_series.py         네이버 시리즈 검색·상세 파서
│  ├─ kakao_page.py           카카오페이지 JSON API 파서
│  ├─ novelpia.py             노벨피아 검색·상세 파서
│  └─ ridi.py                 리디 검색 응답 파서
└─ web/
   └─ index.html              의존성 없는 단일 검색·인증 확인 화면

tests/
└─ test_core.py               핵심 파싱, 정규화, 선정, 인증 어댑터 계약 검증

docs/
├─ architecture.md            현재 프로그램 구조
├─ implementation-plan.md     구현 범위와 진행 기록
├─ adult-authentication.md    19세 작품 수집 장애와 해결 내역
└─ viewer-auth-integration.md 소설 뷰어와 인증 기능을 연결하는 방법
```

## 4. 주요 데이터 모델

### 4.1 후보와 최종 메타데이터

`SearchCandidate`는 플랫폼 검색 결과를 공통 형태로 바꾼 내부 후보이며 다음 값을 가진다.

| 필드 | 의미 |
|---|---|
| `title` | 플랫폼에 표시된 작품명 |
| `author` | 작가명. 없을 수 있음 |
| `platform` | `munpia`, `naver_series`, `kakao_page`, `novelpia`, `ridi` 중 하나 |
| `platform_work_id` | 플랫폼 내부 작품 식별자 |
| `source_url` | 작품 상세 페이지 URL |
| `cover_url` | 원본 또는 가능한 가장 큰 표지 URL |
| `description` | 작품 소개. 검색 단계에서는 없거나 축약될 수 있음 |
| `genres`, `tags` | 플랫폼 값을 공통 목록으로 표현한 장르와 태그 |
| `status` | `ongoing`, `completed`, `hiatus`, `unknown` |
| `match_score` | 정규화된 제목의 문자열 유사도, 0.0~1.0 |

`NovelMetadata`는 후보 필드에 `fetched_at`을 더한 최종 수집 모델이다. 상세 조회가 실패해 검색 결과로 대체될 때도 같은 형태를 사용한다.

### 4.2 단일 작품 결정 응답

`ResolveResponse`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
|---|---|
| `status` | `found`, `not_found`, `ambiguous`, `failed` |
| `confidence` | 선정된 후보의 제목 유사도. 작품 동일성을 단독 보장하지 않음 |
| `match_type` | `exact_title_and_author`, `exact_title`, `fuzzy_title`, `ambiguous` |
| `metadata_quality` | `full` 또는 `partial` |
| `metadata` | 자동 적용 대상 한 건. `found`가 아니면 없음 |
| `searched_platforms` | 정상적으로 검색 응답을 받은 플랫폼 수 |
| `failed_platforms` | 실패한 플랫폼 식별자 목록 |
| `platform_errors` | 사용자에게 공개 가능한 플랫폼별 오류 요약 |
| `skipped_platforms` | 조기 확정으로 완료를 기다리지 않은 플랫폼 목록 |
| `authenticated_search` | 인증 검색 경로가 실제로 실행됐는지 여부 |
| `cover_ref` | 선택된 표지를 제한된 binary endpoint에서 가져오는 짧은 수명의 opaque ref |

`metadata_quality=full`은 선정 후보의 상세 조회가 성공했다는 의미다. 모든 선택 필드가 반드시 채워졌다는 의미는 아니다. `partial`은 상세 조회가 실패했지만 검색 단계에 표지가 있어 축약 결과로 대체했다는 뜻이다.

### 4.3 API 진입점

| 메서드와 경로 | 역할 |
|---|---|
| `GET /` | 내장 검색 UI 반환 |
| `GET /health` | 서비스/API version과 resolve, cover-ref, adult-auth capability 조회 |
| `GET /api/v1/search` | 플랫폼별 후보와 상세 수집 상태 진단 |
| `GET /api/v1/resolve` | 제목, 선택적 작가명으로 최종 결과 한 건 결정 |
| `POST /api/v1/resolve/batch` | 최대 50개 작품을 입력 순서대로 결정 |
| `GET /api/v1/covers/{cover_ref}` | resolve가 발급한 ref의 검증된 JPEG/PNG/WebP binary 반환 |
| `GET /api/v1/auth/status` | 인증 기능 사용 가능 여부, 로그인 창, 활성 플랫폼 상태 조회 |
| `POST /api/v1/auth/{platform}/open` | 플랫폼 로그인 전용 브라우저 열기 |
| `PUT /api/v1/auth/{platform}` | 로그인 완료 후 해당 플랫폼 인증 검색 활성화 또는 비활성화 |
| `POST /api/v1/auth/browser/close` | 전용 로그인 창과 인증 컨텍스트 닫기 |
| `DELETE /api/v1/auth/session` | 저장된 브라우저 프로필과 활성 플랫폼 설정 삭제 |

`/search`와 `/resolve`의 제목은 2~100자이며, 작가명은 선택적으로 1~100자를 받는다. `/search`의 플랫폼별 결과 제한은 1~5개다. 인증 플랫폼 식별자는 `naver_series`, `kakao_page`, `novelpia`, `ridi`만 허용한다.

## 5. 공개 단일 작품 결정 흐름

`GET /api/v1/resolve`의 기본 흐름은 다음과 같다.

1. `main.py`가 제목의 앞뒤 공백과 최소 길이를 검사하고 작가명을 정리한다.
2. `ResolveCoordinator`가 공개 `SearchService.resolve()`를 호출한다.
3. `SearchService`가 모든 공개 플랫폼의 `search()`를 동시에 시작한다.
4. 각 플랫폼 응답을 `SearchCandidate` 목록으로 변환하고 제목 유사도를 계산한다.
5. 조기 확정 조건이 충족되면 아직 끝나지 않은 플랫폼 검색을 취소한다.
6. 작가명이 입력됐다면 작가가 일치하지 않는 후보를 제거한다.
7. 정규화 제목이 정확히 같은 후보가 있으면 그 후보 집합만 사용하고, 없으면 전체 후보에서 유사도를 비교한다.
8. 후보를 관련도 순으로 정렬하고 애매한 결과인지 검사한다.
9. 선정한 후보 한 건에 대해서만 `get_detail()`을 호출한다.
10. 공통 후처리 후 표지 URL이 있는 경우에만 `found`로 반환한다.

이 구조 때문에 플랫폼 후보 수가 많아져도 자동 적용 경로의 상세 페이지 요청은 원칙적으로 한 건이다.

### 5.1 조기 확정 조건

다음 중 하나가 확인되면 느린 플랫폼을 더 기다리지 않는다.

- 제목과 작가가 입력값에 문자 그대로 일치하고 후보에 표지가 있음
- 작가명이 입력되지 않은 경우, 서로 다른 두 플랫폼이 정규화 제목과 작가가 같은 작품에 합의했고 적어도 한 후보에 표지가 있음

취소된 플랫폼은 실패가 아니라 `skipped_platforms`에 기록한다.

### 5.2 제목 정규화

제목 비교 전에 다음 차이를 흡수한다.

- 유니코드 호환 문자와 대소문자
- 공백과 일반 문장부호
- `[독점]`, `[BL]`, `[19금]`, `[완결]` 같은 플랫폼 장식 문구
- 한글 본제목 뒤 괄호에 병기된 영문 제목
- `(총 123화/완결)`, `(총 5권/완결)` 같은 회차·권수 문구
- 외전, 완전판, 단행본, 개정판, 리마스터, 시즌 등의 판본 표기

정규화 결과가 같으면 제목 점수는 `1.0`이다. 그 외에는 Python `SequenceMatcher` 비율을 사용한다.

판본 표기는 작품을 탈락시키지 않는다. 기본 제목을 검색하면 본편 표기가 없는 후보를 우선하고, 사용자가 `외전`처럼 판본을 명시하면 같은 판본 표기가 있는 후보를 우선한다. 판본 후보만 존재해도 반환할 수 있다.

### 5.3 작가 정규화

작가명은 다음을 처리한다.

- `글`, `저자`, `작가`, `원작` 접두어 제거
- 쉼표, 슬래시, `&`, 가운데점, `and`로 구분된 여러 작가 처리
- 괄호나 대괄호 안의 별칭 제거
- 공백과 문장부호 정리

입력 작가와 후보 작가의 정규화된 이름 집합에 하나라도 공통값이 있으면 일치로 본다. 작가명을 명시했는데 일치 후보가 없으면 자동 적용하지 않는다.

### 5.4 후보 정렬 순서

후보는 다음 값을 앞에서부터 비교한다.

1. 입력 제목과 플랫폼 제목의 문자 그대로 일치 여부
2. 작가명이 입력됐을 때 작가 일치 여부
3. 정규화 제목 유사도
4. 본편·외전·판본 표기 선호도
5. 표지, 설명, 작가, 장르, 태그가 채워진 정도
6. 수집기 등록 순서

메타데이터가 많은 낮은 관련도 후보가 제목 관련도가 높은 후보를 역전하지 못하도록 관련도 항목이 완성도보다 앞선다.

정규화 정확 일치 후보가 없으면 최고 제목 점수가 `0.9` 이상이어야 한다. 최고 후보와 서로 다른 작품 후보의 점수 차가 `0.03` 미만이면 `ambiguous`로 반환한다. 정확 제목이 여러 작가에게 존재하고 작가 입력이 없을 때도 `ambiguous`가 된다.

### 5.5 상세 조회와 표지 필수 조건

- 상세 조회 성공: 공통 후처리 후 `metadata_quality=full`
- 상세 조회 실패 + 검색 후보에 표지 있음: 검색 정보로 대체하고 `metadata_quality=partial`
- 상세 조회 실패 + 표지 없음: `failed`
- 상세 조회 후에도 표지 없음: `not_found`

이 프로그램의 최종 용도가 표지 자동 적용이므로, 관련 작품을 찾았더라도 표지 URL이 없으면 `found`로 반환하지 않는다.

## 6. 진단 검색과 일괄 처리

### 6.1 진단용 검색

`GET /api/v1/search?q=...&limit=3`은 플랫폼별 후보를 살펴보기 위한 API다.

- 모든 플랫폼 검색이 끝날 때까지 기다린다.
- 플랫폼마다 제목 점수가 높은 후보를 `limit`개까지 고른다.
- 선택한 후보들은 모두 상세 조회한다.
- 상세 조회 일부가 실패하면 검색 결과로 대체하고 해당 플랫폼을 `partial`로 표시한다.
- 전체 결과는 제목 점수순으로 정렬한다.

따라서 `/search`는 문제 진단과 UI 확인에 유용하지만, 한 작품을 자동 적용할 때는 더 적은 상세 요청을 사용하는 `/resolve`가 기본 경로다.

### 6.2 일괄 결정

`POST /api/v1/resolve/batch`는 최대 50개 입력을 받는다.

- 결과 순서는 입력 순서를 유지한다.
- 작품은 최대 4개씩 처리한다.
- 각 항목은 단일 `/resolve`와 같은 규칙을 사용한다.
- 항목별로 `include_adult`를 지정할 수 있다.

## 7. 플랫폼 수집기

모든 수집기는 `BaseExtractor`의 다음 인터페이스를 구현한다.

```python
async def search(query: str) -> list[SearchCandidate]
async def get_detail(candidate: SearchCandidate) -> NovelMetadata
```

`BaseExtractor`는 플랫폼별 `httpx.AsyncClient`를 지연 생성하고 재사용한다. 리디는 현재 검색 요청에 표준 라이브러리 `urlopen`을 사용한다.

| 플랫폼 | 공개 검색 | 상세 정보 | 성인 검색 경로 | 표지 처리 |
|---|---|---|---|---|
| 문피아 | 모바일 검색 HTML | 상세 HTML의 JSON-LD와 태그 | 지원하지 않음 | 검색 또는 JSON-LD 이미지 URL |
| 네이버 시리즈 | 검색 HTML | 상세 HTML, OG 메타, 작품 정보와 전체 소개 | 인증 브라우저로 같은 HTML 요청 | `pstatic.net` 썸네일의 `type` 크기 제한 제거, 성인 자리표시자 제외 |
| 카카오페이지 | BFF JSON 검색 API | overview/about JSON API | 인증 브라우저로 같은 JSON API 요청 | 이미지 리소스 ID를 CDN URL로 변환 |
| 노벨피아 | `/proc/novel` JSON 응답 | 상세 HTML에서 실제 표지 보완 | 인증 브라우저로 `novel_age=19` 검색 | 상세 표지를 우선하고 알려진 자리표시자 제외 |
| 리디 | 공개 검색 JSON API | 검색 응답에 필요한 정보가 있어 별도 네트워크 상세 요청 없음 | 같은 공개 검색 API에서 성인 제외 옵션을 끈 뒤 성인 후보만 분리 | `xxlarge` CDN URL 생성 |

플랫폼 HTML 구조나 비공개에 가까운 웹 API 응답이 바뀌면 해당 플랫폼 파일의 파서만 수정하는 것을 원칙으로 한다.

## 8. 공통 메타데이터 후처리

상세 조회 이후 `postprocessor.normalize_metadata()`가 플랫폼 차이를 정리한다.

- HTML 엔티티 해제
- 소개에 HTML이 포함된 경우 텍스트로 변환
- 연속 공백 축소
- 장르와 태그 앞의 `#` 제거
- 대소문자를 무시한 장르·태그 중복 제거
- 플랫폼 상태값을 `ongoing`, `completed`, `hiatus`, `unknown`으로 통일

후처리는 플랫폼 파서가 원본 필드를 추출한 뒤 한 번 적용한다. 플랫폼 특유의 DOM이나 JSON 구조는 공통 후처리로 가져오지 않는다.

## 9. 선택적 인증 검색 구조

인증 기능은 `playwright` 선택 의존성이 설치된 경우에만 사용할 수 있다.

### 9.1 로그인과 세션 저장

1. 사용자가 UI에서 플랫폼의 `로그인 창 열기`를 누른다.
2. `AuthSessionManager`가 시스템 Chrome 또는 Edge를 전용 사용자 데이터 디렉터리로 실행한다.
3. 사용자가 그 창에서 직접 로그인, 성인 인증, 휴대폰 2단계 인증을 완료한다.
4. `로그인 완료·사용`을 켜면 로그인 창을 종료하고 같은 프로필을 Playwright 영구 컨텍스트로 열 수 있는지 확인한다.
5. 이후 인증 검색은 같은 쿠키와 저장소가 있는 headless 컨텍스트를 사용한다.

프로그램은 아이디와 비밀번호를 입력받거나 저장하지 않는다. 다만 전용 브라우저 프로필에는 로그인 쿠키가 저장되므로 민감한 로컬 데이터로 취급해야 한다.

Windows 기본 저장 위치는 다음과 같다.

```text
%LOCALAPPDATA%\WebNovelMetadataCollector\auth\
├─ browser-profile\
└─ settings.json
```

`settings.json`에는 활성화한 플랫폼 이름만 저장한다. Windows가 아니거나 `LOCALAPPDATA`가 없으면 `~/.webnovel-metadata-collector/auth`를 사용한다.

### 9.2 인증 검색 실행

`include_adult=true`이고 하나 이상의 인증 플랫폼이 활성화돼 있으면 다음 두 작업을 동시에 수행한다.

- 기존 공개 `SearchService`
- 활성화된 플랫폼만 포함한 인증 `SearchService`

`AuthenticatedExtractor`는 인증된 응답을 기존 플랫폼 파서에 전달하고, 성인 후보만 남긴 뒤 `19금` 태그를 추가한다. 공개 결과와 인증 결과가 모두 있으면 다음 순서로 하나를 선택한다.

1. 문자 그대로 제목이 일치하는 응답
2. `exact_title_and_author` → `exact_title` → `fuzzy_title`
3. 제목 점수
4. 상세 조회 성공 여부

정규화 제목이 같지만 공개 결과와 인증 결과의 작가가 다르면 잘못 적용하지 않고 `ambiguous`를 반환한다.

인증 브라우저 프로필은 동시에 여러 페이지에서 복구·재시작되지 않도록 인증 요청을 한 번에 하나씩 직렬 처리한다. 응답이 401/403이거나 로그인 페이지로 이동하면 세션 만료로 판단하고 재연결 메시지를 반환한다.

### 9.3 접근 경계

`include_adult` 요청과 `/api/v1/auth/*` 라우트는 브라우저가 보낸 `Origin`과 `Sec-Fetch-Site`를 검사해 명백한 외부 웹페이지의 교차 출처 호출을 거부한다. `Origin`이 있다면 호스트가 `127.0.0.1`, `localhost`, `::1`, `tauri.localhost` 중 하나여야 한다. 서버 간 호출처럼 `Origin`이 없는 요청은 허용하며, 클라이언트 IP나 로그인 사용자를 검사하지는 않는다. 따라서 이것은 인터넷에 노출된 서버를 위한 사용자 인증 체계가 아니다.

외부 브라우저로 접속하는 소설 뷰어와 결합할 때는 뷰어 백엔드가 이 수집기를 내부 서비스로 호출하고, 뷰어 자체의 사용자 인증과 CSRF 방어를 담당해야 한다. 서버·Docker 환경의 권장 UX와 아직 필요한 구성은 [소설 뷰어용 19세 인증 API 연동](viewer-auth-integration.md)에 별도로 정리돼 있다.

Moya 로컬 개발을 위해 `localhost`, `127.0.0.1`, `[::1]`의 HTTP/HTTPS Origin과 임의 포트, Tauri의
`http(s)://tauri.localhost` 및 `tauri://localhost`에만 CORS를 허용한다. 자격 증명 CORS는 사용하지 않는다.
이는 외부 네트워크 접근 제어나 사용자 인증을 대신하지 않는다.

표지 ref는 resolve 응답에서만 발급하며 클라이언트가 URL을 지정할 수 없다. 최초 URL과 최대 3번의 redirect는
모두 HTTPS와 선택된 플랫폼의 표지 host allowlist를 통과해야 한다. 응답은 10MiB에서 중단하고 binary magic으로
JPEG, PNG, WebP만 허용한다. ref는 프로세스 메모리에서 최대 512개, 15분 동안만 유효하므로 다중 worker 공유
저장소나 영속 링크로 사용하지 않는다.

## 10. 동시성, 제한시간, 연결 수명

| 범위 | 현재 값 | 적용 위치 |
|---|---:|---|
| 공개 수집기 HTTP 요청 제한시간 | 10초 | `BaseExtractor`의 `httpx.AsyncClient` |
| 단일 공개 작품 결정 전체 제한시간 | 15초 | `SearchService.resolve()` |
| 인증 작품 결정 전체 제한시간 | 20초 | `ResolveCoordinator`가 만드는 인증 `SearchService` |
| 공개 외부 요청 동시 실행 | 최대 8개 | 공개 `SearchService` 세마포어 |
| 인증 서비스 외부 요청 동시 실행 | 작품 결정 요청별 최대 4개 | 인증 `SearchService` 세마포어 |
| 인증 브라우저 프로필 요청 | 한 번에 1개 | `AuthSessionManager` 세마포어 |
| 일괄 작품 처리 | 최대 4개 | `ResolveCoordinator.resolve_batch()` |
| 일괄 입력 | 최대 50개 | `BatchResolveRequest` |

플랫폼별 `httpx.AsyncClient`는 최초 요청 때 생성하고 이후 연결을 재사용한다. FastAPI 앱 종료 시 `lifespan`에서 공개 수집기 클라이언트와 인증 브라우저를 닫는다.

## 11. 오류와 부분 장애 표현

### 11.1 최종 상태

- `found`: 자동 적용할 표지와 메타데이터 한 건이 있음
- `not_found`: 후보가 없거나, 점수가 부족하거나, 작가가 맞지 않거나, 최종 표지가 없음
- `ambiguous`: 자동으로 하나를 고르기 위험한 복수 후보가 있음
- `failed`: 모든 플랫폼 검색 실패, 전체 제한시간 초과, 또는 선정 후보의 상세 조회 실패 후 대체 표지도 없음

일부 플랫폼이 실패해도 다른 플랫폼에서 유효한 후보를 찾으면 `found`를 반환할 수 있다. 이때 장애는 `failed_platforms`와 `platform_errors`에 함께 남는다.

외부 예외 전문은 그대로 API에 노출하지 않는다. 시간 초과, 인증 만료처럼 사용자가 조치할 수 있는 오류만 제한적으로 공개하고 나머지는 공통 메시지로 바꾼다. 상세 원인은 서버 로그에 기록한다.

### 11.2 플랫폼 진단 상태

`/api/v1/search`는 각 플랫폼을 다음 상태로 표시한다.

- `success`: 검색과 선택 후보 상세 조회 성공
- `partial`: 검색은 성공했으나 일부 상세 조회를 검색 정보로 대체
- `no_results`: 플랫폼 검색은 성공했지만 후보 없음
- `failed`: 요청 또는 파싱 실패

## 12. 내장 UI

`app/web/index.html`은 별도 프런트엔드 빌드 없이 FastAPI가 그대로 제공한다.

- 제목과 선택적인 작가명 입력
- `/api/v1/resolve` 호출
- 최종 표지, 제목, 작가, 설명, 장르, 태그, 상태 표시
- 일치 유형, 메타데이터 품질, 부분 플랫폼 장애, 조기 종료 표시
- 플랫폼별 인증 창 열기와 사용 여부 설정
- 성인 작품 포함 설정을 브라우저 `localStorage`에 보존
- 전용 인증 브라우저 종료와 저장 세션 삭제

UI는 수집 로직을 갖지 않는다. 모든 선정과 오류 판단은 API 응답을 그대로 사용하므로 소설 뷰어도 동일 API 계약을 재사용할 수 있다.

## 13. 새 플랫폼을 추가하는 위치

새 공개 플랫폼은 다음 최소 변경으로 추가한다.

1. `app/extractors/`에 `BaseExtractor` 구현 추가
2. 검색 응답을 `SearchCandidate`로 변환
3. 상세 응답을 `NovelMetadata`로 변환
4. `app/extractors/__init__.py`에서 내보내기
5. `app/main.py`의 공개 `SearchService` 수집기 목록에 등록
6. 대표 검색·상세 파싱 테스트 추가

성인 인증 검색까지 지원하려면 추가로 다음이 필요하다.

1. `AUTH_PLATFORMS`와 `LOGIN_URLS` 등록
2. `AuthenticatedExtractor`에 인증 요청과 기존 파서 연결
3. UI의 인증 플랫폼 항목 추가
4. 실제 장애 원인과 검증 작품을 `adult-authentication.md`에 기록

플랫폼 공통 인터페이스를 넘어선 추상화는 실제로 두 플랫폼 이상에서 같은 필요가 확인될 때만 추가한다.

## 14. 현재 의도적인 제한

- DB와 메타데이터/이미지 캐시가 없다.
- 검색만으로 표지를 다운로드하지 않는다. resolve에서 발급한 ref를 별도로 요청할 때만 제한된 binary를 전달한다.
- 표지 endpoint는 byte 크기와 format을 확인하지만 pixel 크기, 저작권·사용 조건과 Moya asset 승인을 대신하지 않는다.
- 플랫폼의 비공식 웹 응답과 HTML 구조가 바뀌면 파서 수정이 필요하다.
- `confidence`는 제목 문자열 점수이며 의미 기반 유사도나 작품 고유성 점수가 아니다.
- 작가 정보가 없는 동명 작품은 자동 판별에 한계가 있다.
- `metadata_quality=full`이어도 플랫폼이 제공하지 않는 태그나 상태는 비어 있거나 `unknown`일 수 있다.
- 인증 세션은 하나의 전용 브라우저 프로필을 공유하므로 개인용 단일 사용자 구성을 전제로 한다.
- 현재 인증 창 실행 방식은 시스템 Chrome/Edge가 있는 데스크톱 환경에 맞춰져 있다. Linux Docker 서버의 사용자용 로그인 화면 제공은 뷰어 통합 계층에서 추가해야 한다.

## 15. 문서 간 역할

- 이 문서: 현재 코드의 책임과 요청 흐름
- [구현 계획](implementation-plan.md): 무엇을 구현했고 다음에 무엇을 할지
- [19세 작품 인증 수집 기록](adult-authentication.md): 플랫폼별 실제 장애, 원인, 해결 내역
- [소설 뷰어용 19세 인증 API 연동](viewer-auth-integration.md): 외부 뷰어와 서버 환경의 인증 UX 및 배포 구조
