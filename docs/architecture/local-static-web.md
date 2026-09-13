# 같은 레포의 local-static Web 앱

## 2026-09-10 폴더 분리 정정

사용자가 요청한 ‘별도 폴더’는 같은 레포의 별도 앱이었다. 이전에 만든 독립 `moya-web` Git 복사본의
Web 기능을 `apps/web`으로 통합한다. Git·workspace·lockfile은 메인 레포의 것을 공유한다.
원본 Reader·파서·repository·domain 코드는 복사하지 않고 root `src`와 `packages`를 직접 사용한다.

## 제품 조합

Google 계정과 동기화는 `product.cloudVaultProvider`로 주입한다. Web의 `google-session`은 공식 GIS 버튼,
nonce/서명 검증과 별도 Drive 동의를 관리한다. 서버 없는 모드는 토큰을 메모리에만 보관하며,
선택적 `services/web-auth` 연결 시 브라우저 재시작 후 모야 세션을 복원하고 Google 접근 토큰을 자동 갱신한다.
Google refresh token은 인증 서버에 암호화해 보관한다. 책 원문은 인증 서버를 통하지 않는다. 공유 controller는 계정 라벨/subject와
기존 Vault 설정만 저장하며, 원문·파서·병합은 기존 경계를 유지한다. 동기화 메뉴는 ‘계정 · 동기화’와
‘저장 · 오프라인’으로 나누고 메인의 ‘인터넷 없이 읽기’는 후자를 바로 연다.
설정/검증은 [Google 설정 안내](../operations/google-login-drive-setup.md)와 [인증 서버 운영](../../services/web-auth/README.md)을 따른다.

- 기존 root `src/main.tsx`와 self-host/native 실행 경로는 유지한다.
- `apps/web/src/main.tsx`는 같은 `src/App.tsx`를 사용한다.
- Web runtime은 repository factory에 `mode: local`, `allowServerSync: false`를 명시한다.
  기본 옵션을 생략하는 기존 앱은 기존 local/remote/connected 동작을 그대로 유지한다.
- `AppRuntime.product`는 선택적 제품 구성이다. 기존 앱에서는 생략한다. Web에서만 저장/동기화
  UI를 주입하고 direct cloud source, Web 정보, 시스템 음성 안내를 사용한다.
- 선택적 `LibraryNotice`, `Lifecycle`, `onBackupExported`로 Web 서재 안내·PWA 작업 보호·백업 날짜를 연결한다.
  공통 Library는 React node slot만 받으며 Web 코드를 import하지 않는다. 완료 callback은 export와 저장 요청 성공
  뒤에만 호출한다. 취소/실패를 백업 완료로 기록하지 않는다. 브라우저 다운로드 완료 자체는 사용자가 확인한다.
- 공유 코드가 `apps/web`을 역참조하지 않는다. 앱이 공통 코드를 조합하는 방향을 유지한다.
- 실제 AI 엔진 없는 상태에서 mock 결과를 생성하지 않는다. Web의 AI provider는 명시적으로 실패한다.
- Web은 서버 source broker를 초기화하지 않고, 서버 source와 AI 익스텐션을 등록하지 않는다.
- 공통 text offsets, 원본 asset, content revision, IndexedDB schema 및 Cloud Vault 형식은 변경하지 않는다.

## 빌드와 업데이트

`web:dev`, `web:build`, `web:preview`, `check:web-local`이 레포 루트의 실행 명령이다.
출력은 `apps/web/dist`이며 기존 `dist`와 별도다. 공유 브랜드와 라이선스를 빌드 시 읽어 포함한다.
Web OAuth 공개 식별자는 `apps/web/.env.local`에서만 읽고 서버 주소/token 변수는 빈 값으로 고정한다.
공통 Reader 수정은 두 앱에 함께 반영한다. 동작이 달라야 하는 UI는 제품 구성 경계에서 구분한다.

PWA는 Vite의 entry/static import/CSS graph와 필수 public assets만 먼저 캐시한다. lazy chunks/Workers/WASM은
온라인에서 사용할 때 캐시하거나 설정의 ‘인터넷 없이 읽기 켜기’로 받는다. build manifest는 각 파일의 크기와
SHA-256 integrity를 고정하고 실행 자산은 request integrity 검사 후 저장한다. HTML은 AdGuard 등 기기 콘텐츠 필터가
변경할 수 있어 network SRI를 적용하지 않고 매 버전 새로 받는다. 이전 cache에서 URL과 integrity가 같은 실행 파일은
재사용한다. 저장 header는 원래 build descriptor의 revision이며 필터를 거친 HTML의 바이트 해시를 증명하지 않는다.
전체 다운로드는 순차적으로 진행하며 재시도 시 이미 받은 파일을 건너뛴다. 부분 실패가 정상 앱 셸을
지우지 않는다. 전체 준비 완료 marker가 있으면 다음 업데이트도 전체 준비 후에만 설치를 완료한다.
실패 설치는 새 cache만 제거하고 이전 버전을 유지한다. 외부 origin, 인증 header, Range, API, mutation을 가로채지 않는다.
캐시 정리는 `moya-web-shell:<encoded mount path>:` namespace에만 적용하며 이전 버전 하나를 유지한다. 업데이트는 사용자
선택 후 활성화한다. OAuth query와 개인 원문을 app-shell cache key/content로 저장하지 않는다.
앱에서 import/backup/folder/source/Cloud Vault 작업 중 업데이트를 막고 beforeunload 확인을 요청한다.
독서 화면에는 업데이트 알림을 표시하지 않는다. 모바일 강제 종료 및 다른 탭의 작업까지 보호하는 주장은 하지 않는다.

`moya-web-data-safety-v1`에는 백업 생성 시각과 메인 안내 닫기 여부만 기록한다. 이전 `dismissedUntil`이 있으면
이미 닫은 안내로 이관한다. 일주일마다 백업을 요구하던 메인 알림은 제거했다. 책장 데이터/원문/토큰을 넣지 않으며
백업이나 Cloud Vault로 동기화하지 않는다. localStorage 쓰기 실패는 성공한 백업을 실패로 바꾸지 않는다.
보호 요청은 설정의 사용자 버튼에서만 실행하고, 용량은 브라우저 추정치로 표시한다. 메인에는 자동 저장 한 줄과
‘인터넷 없이 읽기’ 진입만 둔다. 설정에서는 오프라인 사용과 설치·백업을 선택 기능으로 안내하고 상세 설명을 접는다.

artifact gate는 초기 cache 4MiB 이하, entry gzip 650KiB 이하, initial graph에 WASM/PDF worker 없음과
모든 manifest 파일의 크기/integrity를 검사한다. 전체 asset graph의 native/server 코드 제거는 후속 최적화다.

Cloud Vault는 기존 opt-in 원본·암호화 metadata·충돌 병합·foreground 동기화 정책을 유지한다.
실제 OAuth, 모바일 및 OCR/음성 offline은 코드 gate와 별도로 검증한다.
이전 Sites 등록은 이 앱의 구성이나 배포 의존성이 아니다.

## GitHub Pages / 데스크톱 배포 전략 — 2026-09-11

- 웹에서 설치 없이 독서·서재 관리·시스템 TTS를 제공하고, 수집기·네이티브 연동·설정된 AI/TTS는 데스크톱으로 안내한다.
- `WEB_BASE_PATH`로 `/` 또는 `/moya-reader/`를 설정한다. Vite 자산, 공통 브랜드/라이선스 링크,
  manifest 상대 경로, 서비스 워커 등록·scope·캐시·OAuth callback HTML 모두 같은 mount path를 따른다.
- `src/utils/public-asset-url.ts`만 공통 정적 링크 처리를 담당한다. 기존 root/native 빌드의 `/` 기본값은 유지한다.
- 캐시는 경로별로 분리하고 다른 Pages 앱 캐시를 지우지 않는다. 이전 `moya-web-shell-` 캐시는 자동 삭제하지 않는다.
  IndexedDB는 기존 호환성을 유지하므로 같은 origin의 경로별 앱을 독립 사용자 저장소로 간주하지 않는다.
- `WebDataSettings`가 저장 안내와 `WebDesktopPanel`을 앱 정보/동기화 UI에 주입한다. 독서 화면에는 배너를 넣지 않는다.
  HTTPS `VITE_DESKTOP_DOWNLOAD_URL`이 없으면 설치 가능하다고 주장하지 않고 공개 릴리스 목록으로 안내한다.
- 백업 형식과 저장 schema를 변경하지 않는다. 양쪽의 `IndexedDbBackupRepository`와 충돌 검사를 그대로 사용한다.
  설치 시 자동 이관은 없으며 복원 확인 전 웹 서재를 삭제하지 않는다. Cloud Vault는 별도 OAuth 설정이 필요하다.
- `.github/workflows/web-pages.yml`은 공개 저장소 main에서 수동 실행한다. Pages의 실제 base path로 검증/build 후
  `apps/web/dist`만 업로드한다. OAuth 공개 식별자만 repository variables로 받고 서버 비밀은 빌드에 전달하지 않는다.
- 배포/공개 저장소 반영/네이티브 설치 검증은 로컬 코드 완료와 별도로 기록한다.

2026-09-12 공개 저장소 PR #41을 병합하고 Pages를 `workflow` 방식으로 활성화했다. 첫 수동 배포 run
`34672371705`가 성공했으며 공개 주소는 `https://west-truth.github.io/moya-reader/`이다. 실제 HTTPS에서
HTML·manifest·worker·offline manifest·icon 응답과 새 Edge 프로필의 UI boot, service-worker scope,
offline reload를 확인했다. OAuth와 네이티브 설치 프로그램은 아직 구성되지 않았다.

운영 절차와 데이터 이동 방법은 [Web README](../../apps/web/README.md)를 따른다.
설정 근거: [Vite public base path](https://vite.dev/guide/build.html#public-base-path),
[GitHub Pages custom workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## 검증

기존 runtime local/remote/connected, 기존 정보·듣기 UI 회귀 검사와 Web profile 경계 검사를 함께 실행한다.
공통 import/source 보존, cloud provider/merge, PWA cache lifecycle을 집중 검증한 후 두 진입점의 build를
검사한다. 결과는 `docs/operations/verification-log.md`에 기록한다.
