# Moya 웹소설 메타데이터 수집기 companion service

웹소설 제목을 검색해 가장 일치하는 작품 하나의 표지 URL과 핵심 메타데이터를 반환하는 FastAPI 애플리케이션이다. 소설 뷰어가 표지와 작품 정보를 자동 적용하는 용도를 기본으로 한다.

현재 문피아, 네이버 시리즈, 카카오페이지, 노벨피아, 리디를 지원하며 metadata DB나 영구 검색 캐시 없이
병렬로 실시간 조회한다. 인증 browser profile과 짧은 수명의 in-memory cover ref만 별도 보존한다.

이 디렉터리는 Moya 저장소에 포함되는 Python 수집기다. Moya에서는 기본 비활성화된
`웹소설 표지·작품 정보` 신뢰 익스텐션이 typed client와 broker를 거쳐 사용한다. Windows Desktop 설치본은
수집기를 내장 sidecar로 묶어 익스텐션을 켤 때 자동 실행하고, 끄거나 앱을 종료할 때 함께 종료한다. 사용자가
별도 프로그램을 열거나 API 주소를 입력할 필요가 없다. 일반 Web과 self-host 배포는 아직 이 서비스를 별도로
실행하고 주소를 연결하는 companion 방식이다.

## 실행

아래 명령은 수집기 자체 개발과 일반 Web/self-host 연결에 사용한다.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .
uvicorn app.main:app --reload --no-access-log
```

19세 작품 인증 검색까지 사용할 때만 선택 의존성을 설치한다. 시스템 Chrome 또는 Edge를 전용 프로필로 실행하므로 사용자의 평소 브라우저 프로필은 사용하지 않는다.

```powershell
pip install -e ".[auth]"
```

서버 실행 후 `http://127.0.0.1:8000`을 열면 검색 화면을 사용할 수 있다.

## Desktop 내장 번들

Windows Desktop 배포용 단일 실행 파일은 저장소 루트에서 다음 명령으로 만든다.

```powershell
pnpm collector:bundle
```

스크립트가 `.tmp/webnovel-metadata-collector-bundle-environment`에 전용 venv를 만들고 `pyproject.toml`과 Python
identity fingerprint가 같으면 재사용한다. 전역 Python site-packages는 번들 대상이 아니다. `[auth,bundle]`
의존성 설치, PyInstaller onefile/noconsole 생성, 실제 배포 환경 기준 license inventory와 license text 복사를
한 명령에서 수행한다.

생성물은 `src-tauri/collector-sidecar/webnovel-metadata-collector.exe`에 놓이며 Git에는 포함하지 않는다.
같은 위치의 `python-license-inventory.json`과 `third_party/licenses/python/`도 생성물이며 37개 component의
분류와 복사된 license file을 기록한다. 하나라도 분류되지 않거나 license file을 찾지 못하면 번들을 실패시킨다.
Tauri production build는 `beforeBuildCommand`에서 같은 명령을 실행하고 해당 디렉터리를 app resource에 담는다.
개발 Tauri는 별도 binary 대신 현재 Python으로 `app.sidecar`를 실행하므로 Python 의존성이 설치되어 있어야 한다.

## Self-host Web 내장 서비스

Docker Web에서는 수집기 주소를 브라우저에 입력하거나 외부에 공개하지 않는다. 저장소 루트에서 선택형
Compose override를 사용한다.

```bash
docker compose -f compose.yaml -f compose.metadata-collector.yaml up -d --build
```

브라우저는 기존 Moya origin의 `/api/integrations/webnovel-metadata`만 호출하고 Moya API가 내부
`http://metadata-collector:8000`으로 allowlist된 health·resolve·batch·cover 요청을 전달한다. 따라서 외부
reverse proxy 종류와 무관하며 수집기용 host port, domain이나 CORS 설정이 필요 없다. override가 없거나
수집기가 중단되면 해당 익스텐션만 unavailable이 되고 Moya의 나머지 기능은 계속 동작한다.

기본 self-host 이미지는 `[auth]` extra와 사용자 브라우저를 포함하지 않으며 19세 인증 capability를 비활성으로
제공한다. 필요할 때만 Chromium image override를 마지막에 추가한다.

```bash
docker compose \
  -f compose.yaml \
  -f compose.metadata-collector.yaml \
  -f compose.metadata-collector-auth.yaml \
  up -d --build
```

auth profile에서도 collector host port나 별도 domain은 만들지 않는다. 사용자는 Moya 설정 안의 제한된 JPEG
frame으로 전용 Chromium을 보고 click/text/key/scroll/navigation을 전달한다. 기존 Moya account/session gateway가
이 route를 보호하고 browser cookie/Authorization을 collector에 넘기지 않는다. 로그인 입력 자체는 HTTPS Moya
연결을 거쳐 브라우저로 전달되므로 평문 HTTP 외부 접속에서는 사용하면 안 된다.

profile/cookie는 private `metadata-collector-data` volume에만 남고 Moya 설정, Cloud Vault와 기기 동기화에는
포함되지 않는다. 현재 self-host는 소유자 한 명과 profile 하나를 전제로 한다. `로그인 완료`는 platform 사용
설정일 뿐 실제 성인 인증 성공 증명이 아니며 실제 19세 결과는 해당 계정으로 확인해야 한다.

Desktop host는 실행할 때마다 임의 loopback port와 256-bit session token을 만들고 다음 환경 변수를 sidecar에만
전달한다.

- `MOYA_COLLECTOR_SESSION_TOKEN`: 모든 non-OPTIONS 요청이 `X-Moya-Collector-Token` header로 제시해야 하는 token
- `MOYA_COLLECTOR_DATA_DIR`: 전용 인증 browser profile을 포함한 Moya app-data 하위 디렉터리

token을 설정하지 않은 수동 개발 실행은 기존 standalone Web 화면과 API를 그대로 제공한다. 내장 실행은
loopback 이외 host를 거부하며 endpoint와 token을 UI나 영구 설정에 저장하지 않는다.

`--no-access-log`는 개발 화면의 GET 검색어가 terminal 기록에 남지 않게 한다. Moya 익스텐션의 작품 조회는
POST batch 계약을 사용하지만, companion의 독립 검색 화면과 진단용 GET API를 직접 사용할 때는 reverse proxy와
실행 로그에도 작품명이 남지 않도록 같은 정책을 권장한다.

단일 작품 결정 API:

```text
GET http://127.0.0.1:8000/api/v1/resolve?q=재벌집%20막내아들
GET http://127.0.0.1:8000/api/v1/resolve?q=작품명&author=작가명
GET http://127.0.0.1:8000/api/v1/resolve?q=작품명&include_adult=true
```

`/api/v1/resolve`는 플랫폼 검색을 병렬 실행하고 최종 후보 하나만 상세 조회한다. 제목과 작가가 정확히 일치하거나 두 플랫폼에서 동일한 제목·작가가 확인되면 느린 검색은 기다리지 않는다. 공백 차이가 있어도 기본 작품 후보끼리 같은 작가가 합의되면 판본·외전 후보를 제외하며, 서로 다른 기본 작품 작가가 남으면 계속 `ambiguous`로 보류한다. 결과의 `status`는 `found`, `not_found`, `ambiguous`, `failed` 중 하나이며 실제 메타데이터는 `metadata` 한 건으로 반환한다.

자동 적용 판단을 위한 필드도 함께 반환한다.

- `match_type`: `exact_title_and_author`, `exact_title`, `fuzzy_title`, `ambiguous`
- `metadata_quality`: 상세 조회 성공 시 `full`, 검색 결과로 대체하면 `partial`
- `confidence`: 제목 문자열 일치도이며 작품 동일성을 단독으로 보장하는 값은 아니다.
- `searched_platforms`: 정상적으로 검색을 마친 플랫폼 수
- `failed_platforms`: 검색 요청에 실패한 플랫폼 목록
- `skipped_platforms`: 정확한 후보가 조기 확정되어 기다리지 않은 플랫폼 목록

여러 작품을 입력 순서대로 일괄 처리할 수 있다. 작품은 최대 50건이며 한 번에 최대 4건을 처리하고, 전체 외부 요청 수는 기존 8개 제한을 함께 적용한다.

```http
POST /api/v1/resolve/batch
Content-Type: application/json

{
  "items": [
    {"query": "재벌집 막내아들", "author": "산경"},
    {"query": "화산귀환"},
    {"query": "19세 작품명", "include_adult": true}
  ]
}
```

플랫폼별 후보와 수집 상태를 직접 확인해야 할 때는 진단용 검색 API를 사용할 수 있다.

```text
GET http://127.0.0.1:8000/api/v1/search?q=재벌집%20막내아들&limit=3
```

API 문서는 서버 실행 후 `http://127.0.0.1:8000/docs`에서 확인할 수 있다.

## Moya companion 계약

`GET /health`는 단순 생존 상태뿐 아니라 버전이 있는 capability 계약을 반환한다.

```json
{
  "status": "ok",
  "service": "webnovel-metadata-collector",
  "version": "0.1.0",
  "api_version": 1,
  "capabilities": {
    "resolve": { "version": 1 },
    "batch_resolve": { "version": 1, "max_items": 50 },
    "diagnostic_search": { "version": 1 },
    "cover_ref": {
      "version": 1,
      "path": "/api/v1/covers/{cover_ref}",
      "ttl_seconds": 900,
      "max_bytes": 10485760,
      "content_types": ["image/jpeg", "image/png", "image/webp"]
    },
    "adult_auth": {
      "version": 1,
      "available": true,
      "platforms": ["naver_series", "kakao_page", "novelpia", "ridi"]
    }
  }
}
```

`/api/v1/resolve`와 batch 안의 각 resolve 결과에는 선택적인 최상위 `cover_ref`가 추가된다. 기존
`metadata.cover_url`은 호환성을 위해 유지한다. Moya는 표지 binary가 필요할 때 다음 endpoint를 사용한다.

```text
GET /api/v1/covers/{cover_ref}
```

- ref는 resolve가 허용된 플랫폼 HTTPS 표지 URL에 대해서만 발급하는 임의 토큰이다.
- ref는 프로세스 메모리에 최대 512개만 보관하며 15분 뒤 만료된다. 서비스 재시작 후에도 유지되지 않는다.
- endpoint는 임의 URL을 받지 않는다. 최초 URL과 모든 redirect를 같은 플랫폼의 허용 host로 다시 검사한다.
- 응답은 최대 10MiB이며 binary magic으로 확인한 JPEG, PNG, WebP만 반환한다.
- `404`는 없거나 만료된 ref, `413`은 크기 초과, `415`는 지원하지 않는 이미지, `502/504`는 안전하지 않거나
  실패한 upstream 요청을 뜻한다.
- 이 경계는 Moya의 후속 cover 후보 검증과 사용자 승인을 대체하지 않는다.

Vite 등 로컬 개발 Web과 Tauri desktop에서 capability와 공개 검색을 호출할 수 있도록 `http(s)://localhost`,
`127.0.0.1`, `[::1]`의 임의 포트, `http(s)://tauri.localhost`와 `tauri://localhost` Origin만 CORS에 허용한다.
자격 증명 CORS는 허용하지 않으며 서비스를 외부 네트워크에 공개하는 인증 수단으로 사용할 수 없다.

## 현재 범위

- 문피아, 네이버 시리즈, 카카오페이지, 노벨피아, 리디 작품명 병렬 검색
- 전체 후보 중 가장 일치하는 작품 하나를 선정한 뒤 해당 후보만 상세 조회
- 제목·작가 정확 일치 또는 두 플랫폼 합의 시 느린 검색 조기 종료
- 플랫폼별 HTTP 연결 재사용 및 앱 종료 시 안전한 연결 정리
- 입력 순서를 보존하는 최대 4건 제한 병렬 일괄 적용 API
- 선택적인 작가명 일치와 애매한 결과 차단
- 유니코드·플랫폼 장식 문구와 `권/회차/범위/완결` 배포 suffix를 분리하는 보수적 제목 정규화
- `1984`, `제5공화국`, `20th Century Boys`, 날짜형 제목과 임의 괄호 제목을 지우지 않는 숫자·괄호 safeguard
- 원 요청 문자열은 응답에 보존하면서 정제한 작품명만 플랫폼 검색어로 사용하는 query boundary
- 다중 작가명 비교
- 본편·외전·단행본·완전판 차이는 검색 탈락 조건이 아니라 동일 작품 후보의 선택 우선순위로만 사용
- 태그, 장르, 설명, 연재 상태 공통 후처리
- 자동 적용 요청 전체 15초 제한과 외부 요청 최대 8개 동시 실행
- 네이버 시리즈 원본 이미지 URL, 노벨피아 상세 페이지 표지 및 리디 `xxlarge` 표지 사용
- 공개 HTML, JSON-LD 및 비로그인 JSON 응답 파싱
- 제목, 작가, 작품 URL, 표지 URL, 소개, 장르, 태그, 연재 상태 반환
- 검색 결과별 제목 일치 점수 반환
- 플랫폼 요청 실패 시 오류 상태를 포함한 유효한 JSON 반환
- 브라우저에서 검색 결과와 표지를 확인하는 단일 화면
- 전용 브라우저에서 사용자가 직접 로그인한 세션을 이용하는 선택적 19세 작품 검색
- 네이버 시리즈, 카카오페이지, 노벨피아, 리디 인증 검색을 플랫폼별로 켜고 끄는 설정
- 인증 검색으로 확인한 19세 작품에만 공통 `19금` 태그 반환

`limit` 값은 진단용 `/search`에서만 사용하는 플랫폼별 상세 조회 후보 수이며 기본값은 3이다.

검색과 상세 조회는 이미지를 미리 다운로드하거나 캐시하지 않는다. resolve가 발급한 짧은 수명의 ref를 사용자가
요청했을 때만 위의 제한된 endpoint가 표지 binary를 전달한다. 기본 검색은 로그인 없이 동작한다. 선택적 인증
검색도 로그인·성인 인증·CAPTCHA를 자동화하거나 우회하지 않으며, 사용자가 전용 브라우저에서 직접 인증한
세션만 사용한다. Desktop은 전용 Chrome/Edge에 직접 입력하고, self-host는 HTTPS Moya gateway를 거쳐 전용
Chromium에 입력을 전달한다. 어느 경로도 계정 입력을 Moya 설정/DB에 저장하지 않는다.

## 선택적 인증 검색

웹 화면의 `인증 검색 설정`에서 플랫폼별로 다음 순서로 연결한다.

1. `로그인 창 열기`를 누른다. Desktop은 일반 Chrome/Edge 전용 창을, auth self-host는 Moya 안의 전용 Chromium
   화면을 연다.
2. 해당 플랫폼에서 사용자가 직접 로그인과 성인 인증을 마친다.
3. 화면에서 `로그인 완료·사용`을 체크한다. 프로그램이 로그인 창 종료와 프로필 준비를 끝낸 뒤 검색 가능 상태를 표시한다.
4. `검색할 때 19세 작품 포함`이 켜진 상태에서 검색한다. 이 선택은 다음 실행에도 유지된다.

Desktop 인증 브라우저 프로필은 Windows의 `%LOCALAPPDATA%\WebNovelMetadataCollector\auth` 아래에 저장된다.
로그인 단계는 Playwright가 제어하지 않는 일반 브라우저로 수행하고, 완료 뒤 인증 검색에서 같은 전용 프로필을
사용한다. Self-host profile은 private `metadata-collector-data` volume에 저장되며 UI에는 bounded frame과 action만
노출한다. `저장된 인증 세션 삭제`는 두 경로 모두 전용 profile과 플랫폼 사용 설정을 함께 제거한다. 인증 검색을
켜지 않으면 auth browser는 사용하지 않는다.

카카오페이지처럼 19세 작품 메타데이터가 공개 응답에 포함되는 경우도 기본 검색과 섞이지 않도록 인증 검색 옵션 안에서만 처리한다. 원본 표지 URL은 provenance를 위해 유지하고, Moya가 실제 표지를 적용할 때는 짧은 수명의 `cover_ref`와 제한된 cover endpoint를 사용한다.

공개 페이지에서 더 큰 이미지를 제공하지 않는 경우 해당 플랫폼이 제공하는 표지 크기를 그대로 사용한다. 검색
요청만으로 표지를 별도 다운로드하지 않으며, cover-ref endpoint를 호출했을 때만 제한된 검사를 수행한다. 개인
사용 범위에서는 메타데이터와 이미지 캐시를 사용하지 않는다.

Moya에 연결할 때도 인증 API는 동일한 broker 경계를 사용한다. Desktop에서는 Moya가 비밀번호·cookie를
입력받거나 읽지 않는다. Self-host에서는 로그인 입력이 기존 인증된 HTTPS gateway를 통과하지만 저장되지 않고,
cookie/profile은 collector volume 밖으로 나오지 않는다. 현재는 명시적인 session 만료 판정 대신 검색 오류,
수동 `상태 새로고침`과 `다시 로그인`을 제공하며, 저장 session 삭제는 별도 확인을 받는다. 상태 문구도 실제 성인
결과 성공을 단정하지 않고 `19세 검색 사용 설정됨`으로 표시한다.

현재 모듈 책임, 후보 선정 순서, 요청 흐름과 오류 계약은 [프로그램 구조](docs/architecture.md)를 참고한다. 구현 범위와 이후 순서는 [구현 계획](docs/implementation-plan.md)을 참고한다. 19세 인증 수집의 플랫폼별 장애 원인과 해결 내역은 [19세 작품 인증 수집 기록](docs/adult-authentication.md)에 계속 누적한다. 소설 뷰어에서 로컬 API와 인증 상태를 연결할 때는 [소설 뷰어용 19세 인증 API 연동](docs/viewer-auth-integration.md)을 따른다.
