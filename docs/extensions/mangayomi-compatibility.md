# Mangayomi JavaScript 지원 범위

기준: 2026-09-19 P0와 HTTP·SDK 후속 구현. 이 문서는 작업 트리의 구현 상태이며 해당 변경이 포함된 서버 버전부터 적용된다.
설치 가능한 확장과 실제 본문까지 취득 가능한 확장은 구분한다. 전체 Mangayomi 호환을 보장하지 않는다.

## 실행 방식

Mangayomi JS 원본은 서버의 제한된 QuickJS realm에서 실행한다. Android WebView나 Flutter 앱을 실행하지 않는다.
사이트 JavaScript가 필요한 확장은 기존 서버 Chromium bridge를 사용할 수 있다. 일반 HTTP와 브라우저의
세션은 소스별로 분리되어 연결된다. 인증서 검증·네트워크 권한·취소·용량 제한은 그대로 적용된다.

현재 대상으로 삼는 형식은 JavaScript 만화(`itemType: 0`)와 소설(`itemType: 2`)이다.
Dart, 영상 추출, APK의 Android 객체는 이 지원표에 포함하지 않는다.

## 현재 API

| 기능        | 현재 동작                                                                                                                                   | 한계                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 목록        | `getPopular`, `getLatestUpdates`, `search`, `supportsLatest`, 필터 변환                                                                     | 소스가 각 메서드를 구현해야 한다.                                                     |
| 상세/회차   | `getDetail` 결과를 Moya 작품·회차로 변환                                                                                                    | 회차를 별도 조회할 때 상세 함수가 다시 실행될 수 있다.                                |
| 이미지      | `getPageList`의 문자열 또는 `{url, headers}`와 `getHeaders`                                                                                 | 이미지 URL 발견과 실제 바이트 다운로드를 별도로 확인해야 한다.                        |
| 소설        | `getHtmlContent` 결과를 한 번 취득하고 안전한 TXT로 변환                                                                                    | 삽화·서식·EPUB 보존은 별도 기능이다.                                                  |
| 선택 기능   | `getSourcePreferences/getHeaders`의 정확한 `… not implemented` 신호는 기본값으로 처리                                                       | 다른 예외를 정상 결과로 바꾸지 않는다. 비동기 선택 메서드는 지원 계약 밖이다.         |
| 문자열      | 문자열 인스턴스의 `substringAfter/AfterLast/Before/BeforeLast/Between`                                                                      | 기존 `MProvider` 동명 helper도 유지한다.                                              |
| DOM         | CSS `select/selectFirst`, `attr/hasAttr`, `text/innerHtml/outerHtml`, class/tag 조회, children/siblings, `getHref/getSrc/getDataSrc/getImg` | XPath·전체 브라우저 DOM을 지원한다는 의미는 아니다.                                   |
| 빈 DOM 결과 | `selectFirst`는 빈 노드 wrapper를 반환하고 문자열 속성은 `''`, 목록은 `[]`                                                                  | `if (node)`로 존재를 판단하지 않는다. 필요한 속성이나 문자열을 검사한다.              |
| 텍스트      | DOM `text`의 원래 공백을 보존한다.                                                                                                          | 표시용 정리가 필요하면 원본 소스에서 `trim()` 등을 적용한다.                          |
| 설정        | 문자열·숫자·boolean 저장. `getString(key, defaultValue)`는 누락 시 기본값을 반환·저장                                                       | 문자열 복수 선택을 저장·복원한다. 항목 최대 128개이며 선언한 선택지만 저장할 수 있다. |
| HTTP        | GET/POST/PUT/DELETE/HEAD/PATCH, 응답 body/headers/statusCode/isRedirect와 요청 정보 일부                                                    | 아래 옵션·응답 범위를 참고한다. 전체 native HTTP client와 동일하지는 않다.            |
| 브라우저    | `evaluateJavascriptViaWebview`, 직접 `sendMessage`의 해당 메서드, `setResponse` callback                                                    | Android 객체·임의 native bridge와 동일하지 않다.                                      |
| 암호화      | 원본 CopyManga가 사용하는 동기 `cryptoHandler`의 AES-CBC/PKCS7/base64 계약                                                                  | Mangayomi profile 전용, 최대 입력 4 MiB. 다른 암호 helper를 포괄하지 않는다.          |
| 실행 수명   | 호출마다 새 realm과 인스턴스, 저장한 설정과 호스트 세션은 별도 보존                                                                         | 인스턴스 필드·전역 변수의 호출 간 보존을 기대할 수 없다.                              |

본문 정리는 확장의 `getHtmlContent()` 책임이다. 호스트가 `cleanHtmlContent()`를 자동으로 한 번 더 호출하지
않는다. 기존 자체 작성 Mangayomi JS가 호스트의 추가 정리에 의존했다면, 원본 함수에서 직접 정리한 결과를
반환하도록 맞춰야 한다. 자체 `.moyaext`의 `getContent()` 계약은 바뀌지 않는다.

DOM의 `getSrc/getHref` 등은 비교 기준 upstream의 outer HTML 기반 추출 의미를 따른다. 일반 웹 DOM의
`element.src/href`처럼 절대 URL 해석을 해주는 API가 아니다. 고정 revision 23개 파일의 실제 helper 사용과
사이트별 판정은 [원본 corpus와 실사이트 판정](mangayomi-corpus-2026-09-20.md)에 정리했다. 현재 corpus에서
암호화 helper는 CopyManga의 `cryptoHandler` 하나만 확인해 구현했으며, XPath와 host unpack 사용은 없었다.
EPUB helper와 동적 native handler는 지원하지 않는다.

### HTTP 옵션과 응답

`new Client({timeout, followRedirects, maxRedirects})`를 지원한다. `timeout`은 upstream과 같은 초 단위이며
기본 15초, 최대 90초다. DNS 대기부터 redirect·본문 수신까지 같은 요청 예산을 사용하고, 호출 전체의 실행 제한과
사용자 취소가 우선한다. 본문이 헤더 뒤에서 멈추는 경우도 취소한다. `followRedirects: false`는 3xx를 그대로
반환하며, `maxRedirects`는 0~4회 범위에서 적용한다. 더 큰 값은 호스트 한도 4회로 제한한다.

응답의 `request`에는 원래 요청 URL·메서드·확장이 지정한 헤더·본문 바이트 길이·redirect 정책을 제공한다.
vault에서 호스트가 추가한 쿠키·인증 헤더를 이 필드로 노출하지 않는다. `reasonPhrase`와 native 연결 상태 등은
아직 제공하지 않는다. `connectTimeout` 별도 제어·`noProxy`·`useDartHttpClient`는 적용하지 않으며
`verifyCertificates: false`로 TLS 검증을 해제할 수 없다. 이 제한은 설치 소스가 운영자의 네트워크 정책을
바꾸지 못하게 유지하는 의도적인 차이다.

## 재현 가능한 검사

```sh
corepack pnpm test:mangayomi-compatibility
```

이 검사는 전체 플랫폼 빌드 없이 호환 실행기·호스트·HTTP·원본 회귀 검사를 실행한다. 기존
`test:extensions-sources`에도 포함되어 있다.

원본 파일은 수정하지 않고 fixture로 보관하고 SHA-256을 검사한다.
[원본 경로·revision·라이선스](../../apps/server/src/extensions/mangayomi/fixtures/upstream/README.md)를 함께 관리한다.
실제 HTTP 대신 결정적인 응답을 주입해 외부 사이트 장애와 호환 API 오류를 구분한다.

| 원본             | 검사 경로                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| AsuraScans 0.1.7 | 마지막 목록 페이지의 빈 next 요소, 링크/표지, Next.js script 데이터의 문자열 추출, 페이지 순서·Referer          |
| WordRain69 0.0.4 | 원본 파일 검토·설치, 선택 설정 메서드 미구현, 호스트 재시작, 목록·회차·HTML 취득·TXT asset 저장, 중복 정리 방지 |
| API 경계         | 누락된 문자열 구분자, 빈 DOM 하위 조회, 설정 기본값 저장, 실제 확장 오류를 숨기지 않는 처리                     |

이 테스트의 성공은 두 사이트의 현재 온라인 상태나 전체 원본 기능의 완전한 지원을 뜻하지 않는다.
실사이트 검증에서는 HTTP 상태·인증·전송 실패와 adapter 실패를 따로 기록한다. 로그인 안내나 빈 본문을
다운로드 성공으로 처리해서는 안 된다.

### 2026-09-19 격리 실사이트 조회

운영 설치/데이터를 사용하지 않고 위 원본 두 개의 기본 설정으로 제한된 조회를 수행했다.

| 원본       | 관찰                                                                                                                                                        | 판정                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AsuraScans | 원본의 `asuracomic.net/series?...`와 상세 요청이 모두 `asurascans.com/`으로 redirect되어 HTTP 200을 반환했다. 목록 20개는 추출했으나 상세의 회차는 0개였다. | JS 실행·목록 추출은 확인. 사이트 이동 후 원본 URL/selector 대응이 별도로 필요하며 읽기 성공으로 판정하지 않는다. |
| WordRain69 | 원본의 `/manga-genre/novel/page/1/?m_orderby=trending` 요청이 HTTP 404. 원본 parser는 빈 목록을 반환했다.                                                   | 원본이 기대하는 목록 주소를 현재 사이트에서 사용할 수 없었다. adapter fixture 통과와 분리한다.                   |

원본별 사이트 보수는 공통 호스트 API 호환 수정과 다른 작업이다. HTTP 200이나 오류 없는 빈 목록만으로
정상 동작을 선언하지 않는다. 이 결과를 특정 사이트의 영구 장애나 모든 Mangayomi 소스의 실패로 일반화하지 않는다.

## 개발자 문서와 다음 단계

새 Moya 확장은 [JS/TS 개발 가이드](source-development.md)의 SDK와 `check/run/pack` 경로를 사용한다.
Mangayomi 원본을 사용하려고 `.moyaext`로 다시 작성할 필요는 없다. 두 포맷의 설정·권한·배포 절차는 구분한다.

후속으로 독립 배포 가능한 SDK/CLI, 제한된 개발 로그와 로컬 preview를 구현했다. SDK tarball의 외부 프로젝트
타입 검사와 실행을 검증했고, CLI tarball을 checkout 밖에 설치해 텍스트·이미지 프로젝트의
생성/검사/실행/watch/preview/서명 패키징/index 생성을 확인했다. npm 공개 게시, 실제 App을 자동으로 띄우는
개발 화면, 아직 미지원인 호환 API는 별도 작업이다.
[플랫폼 검토](platform-review-2026-09-19.md)의 미구현 항목을 이 변경으로 완료 처리하지 않는다.

## 2026-09-20 복수 선택·다국어 원본 후속

MangaDex 0.1.4 원본(위 fixture와 같은 revision)을 추가했다. 단일 선택의 `valueIndex`와
복수 선택의 `values` 기본값을 실행기·설정 UI에 연결했다. 복수 선택은 문자열 배열로 보존되며,
선택 해제 `[]`, 선언하지 않은 값의 저장 거부, 저장 후 호스트 재시작을 검사한다.
원본의 `langs` 배열은 파일 설치 검토에서 언어별 항목으로 펼친다. 기존 `lang` 단일 소스의 ID 규칙은 유지한다.
한 파일을 추가했다고 모든 언어를 자동 설치하지 않으며 기존 선택 UI에서 언어를 고른다.

참고한 upstream 설정 반환 코드:
[extension_preferences_providers.dart](https://github.com/kodjodevf/mangayomi/blob/aaa0aaebe70cbdc42f67fee9f29992ecd5fc4777/lib/modules/browse/extension/providers/extension_preferences_providers.dart).
원본 테스트는 [mangadex.js](https://github.com/kodjodevf/mangayomi-extensions/blob/6004f1f8d1a56f882dadb734ce26f50c626a3850/javascript/manga/src/all/mangadex.js)를 변경하지 않았다.

### 제한된 실사이트 조회

운영 설치나 계정 없이 원본을 격리 실행했다. 목록 HTTP 200·20개를 확인했고 첫 작품은 회차가 0개였다.
두 번째 작품에서는 상세/회차 HTTP 200·216개, 페이지 목록 1개, 첫 PNG 이미지 HTTP 200·121,550바이트를
취득했다. 최대 10요청·전체 60초로 제한했으며 이미지 본문을 로그/문서에 넣지 않았다.

이 결과는 해당 시점의 영어 소스 목록→상세→회차→첫 이미지 취득 성공이다. 모든 작품/언어,
전체 회차 다운로드, 앱 읽기 화면 또는 사이트의 향후 상태를 보증하지 않는다.
이전 AsuraScans/WordRain69의 외부 사이트 실패를 이 성공으로 덮어쓰지 않는다.

## 2026-09-20 실제 App 연결 검사

`pnpm check:extension-mangayomi-app`은 위에 고정한 MangaDex 원본 JS를 수정하지 않고
production App 번들·실제 인증된 확장 HTTP API·격리 설치 저장소에 연결한다.
외부 MangaDex 응답만 결정적인 fixture로 대체한다. 브라우저의 도서 저장소는 IndexedDB이며,
운영 API/DB/사용자 계정에 설치하거나 도서를 추가하지 않는다.

검증 경로:

1. JS 파일 업로드 → 영어 소스 선택 → 신뢰 확인 → 설치 목록에서 설치 확인.
2. 한국어·일본어 원문 필터 복수 선택 → 저장 → 실제 목록 호출에 적용.
3. 빈 검색 결과와 유효 검색 결과 → 작품 상세 → 회차 선택·가져오기.
4. 직접 생성한 320×480 PNG를 모바일 폭 만화 뷰어에서 디코딩·표시.
5. 앱 새로고침 → 가져온 회차 다시 열기 → 이미지 재다운로드 없이 디코딩.

이 경로에서 두 제품 결함을 확인하고 수정했다.

- 원본 `getDetail`이 제목을 생략할 때 기존 목록 제목을 `undefined`로 덮어써
  `apk_work_invalid`가 발생했다. Mangayomi 어댑터가 목록 제목을 보존한다.
  원본 fixture 회귀 검사는 수정 전 실패하고 수정 후 통과한다.
- 파일 설치 후 빈 저장소 탭에 남아 설치 실패처럼 보였다. 파일 설치를 확인한 뒤
  설치 목록으로 이동한다. 저장소에서 설치하는 기존 흐름은 유지한다.

명령은 `quality.yml`의 hosted 검사에 연결했다. 로컬에서 통과했으며, 이 작업 트리의
GitHub CI 실행 결과는 아니다. 앞 절의 실사이트 첫 이미지 취득과 이 결정적인 App 검사는
서로 다른 증거다. 실사이트에서 전체 회차를 가져와 App으로 읽는 검증, 모든 언어·작품,
원격 도서 저장소까지 포함한 운영 구성 전체를 완료했다고 해석하지 않는다.

남은 공개 준비 작업은 실제 사용할 소스의 검증 범위 확대, 증거가 있는 미지원 API의 보완,
SDK/CLI tarball과 예제 저장소의 실제 공개 게시 및 버전별 지원 운영이다. 오류 위치·안전한 로그·watch와
로컬 preview는 구현했으며 실제 App 자동 실행·브라우저 debugger 연결과는 구분한다.
