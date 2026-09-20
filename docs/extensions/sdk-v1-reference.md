# Moya source SDK v1 빠른 참조

이 문서는 `@moya/extension-sdk` 0.1.x와 `moya.extension.package` v1의 현재 공개 계약을 요약한다.
정확한 TypeScript 형식은 패키지 선언 파일이 기준이며, 호스트가 제공하지 않는 Node·브라우저·OS API는 사용할 수 없다.

## 필수 소스 메서드

`defineExtension({sources})`의 각 source에는 안정적인 `id`와 다음 네 메서드가 필요하다.

| 메서드         | 입력                                           | 결과                                                  |
| -------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `listWorks`    | `query?`, opaque `cursor?`, browse mode/filter | `{items, nextCursor?, browse?}`                       |
| `getWork`      | `workId`                                       | 제목을 포함한 단일 작품                               |
| `listReleases` | `workId`, opaque `cursor?`                     | 안정적인 `id`, `title`, 숫자 `order` 목록             |
| `getContent`   | `workId`, `releaseId`                          | `{kind:'text', asset}` 또는 `{kind:'images', assets}` |

`getCover`는 선택 사항이다. ID는 사이트 표시명이나 URL 순서가 바뀌어도 같은 작품·회차를 가리켜야 한다.
페이지네이션 cursor는 소스가 해석하는 불투명 문자열로 취급한다.

## `SourceContext`

- `http.text/asset`: manifest의 HTTPS origin만 호출한다. 연결된 인증이 필요할 때만
  `{authenticated:true}`를 지정한다. 토큰을 URL·헤더·로그에 직접 넣지 않는다.
- `http.request`: 소스가 정의한 작은 JSON/텍스트 프로토콜용 전체 status/header/body 응답이다.
- `textAsset`: 파싱한 텍스트를 host asset으로 만든다. 기존 파일의 원본 바이트는 `http.asset`을 사용한다.
- `preferences.get`: manifest에 선언한 비밀이 아닌 사용자 설정을 읽는다.
- `storage.get/set/remove`: 호출 성공 뒤 함께 commit되는 비밀이 아닌 JSON 상태다.
- `webview.evaluate`: manifest가 `requestedAccess.webview: true`를 선언한 경우에만 격리 브라우저에서 실행한다.
- `sleep`: 취소 가능한 짧은 polling delay다.

각 호출은 새 QuickJS realm에서 실행된다. 전역 변수와 인스턴스 필드에 다음 호출의 상태를 저장하지 않는다.

## Manifest 권한

- `networkOrigins`: 최대 16개의 정확한 HTTPS origin. wildcard, credential URL, localhost는 거부한다.
- `storageKiB`: 0~1024. 비밀번호·세션·API token 저장소가 아니다.
- `authentication`: cookie/bearer/basic 연결과 정확한 JSON 검증 endpoint를 source별로 선언한다.
- `webview`: 사이트 JavaScript가 꼭 필요한 source만 켠다.
- 이미지/본문 다운로드를 제공하면 `external.source.download` 권한과 source contribution이 일치해야 한다.

설치 화면은 manifest 권한과 게시자 서명을 사용자에게 보여 준다. 업데이트에서 권한·게시자·source ID가
바뀌면 자동 승격하지 않는다.

## 현재 한도

| 항목                        |                        한도 |
| --------------------------- | --------------------------: |
| package archive / 압축 해제 |             10 MiB / 30 MiB |
| source entry / guest bundle |               5 MiB / 5 MiB |
| 일반 JSON 결과              |                       1 MiB |
| text asset                  |                       2 MiB |
| 이미지 한 장 / 한 content   |            20 MiB / 256 MiB |
| 이미지 수                   |                        2048 |
| source storage              | manifest 합계 최대 1024 KiB |

긴 외부 본문 작업은 `providerText(url)`과 선언형 content service를 사용할 수 있다. 이는 모든 확장의
필수 서버가 아니며, 일반 source는 host HTTP와 asset API만으로 동작한다.

## 사용자에게 전달되는 오류 범주

- `source_auth_required`, `source_auth_forbidden`: 연결 누락·만료 또는 권한 부족.
- `source_rate_limited`, `source_http_failed`, `source_access_denied`: 원격 HTTP 상태.
- `source_connection_failed`, `source_tls_failed`, `source_request_timeout`: 연결·인증서·시간 초과.
- `source_url_denied`, `source_address_denied`, `source_redirect_denied`: manifest/DNS/redirect 경계 위반.
- `source_body_limit`, `source_asset_limit`, `payload_limit`: 크기·개수 한도.
- `source_browser_unavailable`, `source_browser_failed`: 선언 또는 browser 실행 문제.
- `source_storage_limit`, `source_storage_conflict`: 일반 source 상태의 용량·동시 수정 충돌.
- `execution_timeout`, `execution_failed`, `invalid_extension`: guest 실행 또는 결과 계약 위반.

확장은 이 코드를 로그인 재시도나 인증서 우회로 숨기지 않는다. 개발 중에는 `check`, fixture 기반 `run`,
`dev` 또는 `preview` 순서로 재현하고, 실제 네트워크는 마지막에 명시적 `--network`로만 확인한다.

## 개발·릴리스 순서

1. `moya-extension init`으로 text/images 예제를 만든다.
2. `check`로 manifest와 descriptor를 확인한다.
3. fixture 기반 `run` 또는 `preview`로 목록/상세/본문을 개발한다.
4. 필요할 때만 `--network`로 허용 origin의 실제 응답을 확인한다.
5. 재사용할 P-256 게시자 키로 `pack --key`를 실행한다.
6. archive 폴더에 현재 버전 하나씩 두고 `index`를 생성해 archive와 함께 HTTPS로 게시한다.

전체 예제와 인증·저장소 설명은 [개발 가이드](source-development.md), 키 보관과 업데이트 절차는
[공개 릴리스 절차](publishing.md)를 참고한다.

## CLI 실행 범위

`run`, `dev`, `preview`에서도 `http.request`, `sleep`, `preferences.get`을 실행할 수 있다.
HTTP는 기본적으로 `--fixture fixtures.json`의 응답을 사용하고, 실제 외부 접속은 `--network`를 명시해야 한다.
`http.request`는 3xx/4xx도 status/header/body로 반환하며 자동 redirect를 하지 않는다. 다음 URL도 manifest origin
검사를 통과해야 한다. fixture는 `url`, `method`, `status`, `headers`, `body` 또는 `bodyBase64`를 사용할 수 있다.

설정은 manifest의 해당 source 기본값을 사용한다. `--preferences local-preferences.json`으로 선언한 설정을
재정의할 수 있다(예: `{"language":"ko"}`). 알 수 없는 키나 잘못된 타입은 거부한다. 이 파일은 로컬 개발용이며
운영 cookie·vault·private-origin 권한을 가져오지 않는다. 민감값을 넣은 파일은 커밋하지 않는다.

`webview.evaluate`와 운영 로그인 연결은 이 CLI에서 제공하지 않는다. 해당 기능은 격리된 Moya 앱에서 확인한다.
