# 외부 작품 소스 아키텍처

상태: Phase 3B Source Hub, Dropbox·Google Drive live, Suwayomi/Mihon Source Bridge와 self-host Docker profile 구현
기준일: 2026-08-24

## 사용자 흐름

`설정 → 소스`는 Dropbox 같은 기본 커넥터와 플러그인이 제공하는 작품 소스의 연결·재연결·해제를
관리한다. 연결된 source는 Library 좌측의 `소스` 구역에만 나타나며, 선택하면 Library와 동급인 Source Hub에서
원격 파일·작품을 탐색하고 명시적으로 import한다. Source Hub는 인증 입력을 소유하지 않는다. 외부 항목은
로컬 `Novel`로 가장하지 않으며 목록을 여는 동안 원문을 다운로드하지 않는다.

```text
built-in connector or plugin source contribution
  -> host broker가 metadata page 조회
  -> device-local 목록 cache
  -> 사용자가 파일/작품 선택
  -> host broker가 선택 항목 한 개 다운로드
  -> 기존 ImportService
  -> ExternalSourceLink(remote identity -> local book)
```

가져온 항목은 `가져옴`으로 표시한다. 같은 remote identity의 provider revision이 바뀌면 `업데이트 있음`으로
표시하며 자동으로 현재 원문을 교체하지 않는다. 업데이트도 사용자가 다시 선택해야 기존 import/content
revision 경계를 통과한다.

## 계약과 신뢰 경계

- Dropbox와 이후 Google Drive 같은 제품 기본 커넥터는 익스텐션 inventory에 들어가지 않는다.
  `AppExternalSourceRegistry`가 기본 커넥터를 항상 소유하고 `설정 → 소스`에서 계정 상태를 관리한다.
- `packages/extension-contracts`의 `externalSources` descriptor는 커뮤니티/신뢰 플러그인이 source kind,
  capability와 지원 runtime을 선언할 때 사용한다. `external.source.list`와 `external.source.download` 권한은
  해당 플러그인의 익스텐션 상세에도 계속 표시된다.
- 플러그인 source contribution은 trusted registry의 activation/disable lifecycle을 따르며 꺼지면 소스 설정과
  Library Source Hub 탐색 목록에서 reactive하게 제거된다. 기본 Dropbox 커넥터는 익스텐션 토글 대상이 아니다.
- provider token, refresh token, raw provider response와 `fetch`는 익스텐션에 전달하지 않는다. 기본 Dropbox도
  동일한 bounded `dropbox` host broker만 사용하지만 extension manifest/enablement를 거치지 않는다.
- community package loader와 sandbox는 아직 없으므로 이 API가 임의 설치 코드를 main realm에서 실행하도록
  허용하지 않는다.

## 로컬 저장

`noveldesk-external-sources` IndexedDB는 Reader 정본과 분리된다.

- `credentials`: source별 암호화 credential envelope와 device-local connection identity
- `credentialKeys`: Web Crypto가 만든 non-extractable AES-GCM 기기 키. 사용자가 기억하는 별도 암호는 없다.
- `cachePages`: account/query/cursor별 bounded metadata page, 기본 TTL 15분
- `links`: connector/account/remote ID와 local book ID, imported revision/source hash 연결
- `selectedItems`: Google Picker처럼 provider 전체 목록 권한이 없는 connector에서 사용자가 직접 고른 remote ID와
  bounded metadata만 보존

목록 cache에는 원문, provider response 전문, signed URL, cookie나 token을 넣지 않는다. 연결 해제는 credential과
해당 account cache를 지우지만 이미 가져온 local book과 안전한 link history는 지우지 않는다.

Web에서는 source credential을 자동 생성한 non-extractable 기기 키로 암호화하고 같은 browser profile/origin에서
시작 시 자동 복구한다. 사이트 데이터나 해당 키가 지워졌거나 이전 사용자 암호 형식만 남아 있으면 credential을
평문으로 내리지 않고 `다시 연결 필요`로 전환한다. 이 보호는 같은 origin에서 이미 실행 중인 악성 코드까지
막는 보안 경계는 아니며 다른 기기로 credential을 동기화하지도 않는다. Tauri/Android는 connector를 실제로
연결할 때 OS secure store adapter로 교체하는 것이 후속 범위다. Cloud Vault의 사용자 passphrase는 기기 간
내보내기 가능한 vault를 위한 별도 기능이므로 그대로 유지한다.

## Google Drive selected-file connector

Google Drive는 제품 기본 외부 소스지만 전체 Drive 브라우저가 아니다. Web의 공식 Google Picker와
`drive.file` scope로 사용자가 명시적으로 고른 지원 파일만 `selectedItems`에 등록한다. Picker 안에서는 폴더를
이동할 수 있지만 폴더 자체, 폴더 하위 전체, 새로 생기는 파일을 연결하지 않는다.

- Source Hub의 `Drive에서 파일 추가`가 Picker를 열며 선택 전에는 파일 본문을 받지 않는다.
- 선택 뒤 host broker가 Drive API로 해당 ID의 metadata만 재확인하고 기존 external item/import/link 경계에
  투영한다.
- 파일 가져오기와 업데이트는 Dropbox와 같은 `ImportService` 경로를 사용한다.
- Source Hub에서 선택 항목을 제거해도 이미 가져온 Library 작품과 source link는 삭제하지 않는다.
- Web access token은 자동 생성 device key로 봉인하지만 Google의 짧은 token model을 따르므로 만료 뒤에는
  `다시 연결 필요`가 된다. 다시 연결해도 같은 계정의 선택 파일 목록은 유지한다.
- token, Google API response와 raw `fetch`는 UI나 plugin에 전달하지 않는다.

로컬 Vite 개발은 다음 세 public identifier의 `VITE_*` fallback을 사용한다. Docker Web은 같은 값을
`MOYA_GOOGLE_DRIVE_*` runtime public config로 시작 시 주입하므로 identifier 변경 때문에 image를 다시 build할
필요가 없다. 어느 경로도 client secret을 bundle이나 runtime config에 넣지 않는다.

1. 같은 Google Cloud project에서 Google Drive API와 Google Picker API를 활성화한다.
2. OAuth consent screen을 구성하고 테스트 상태면 사용할 계정을 test user로 등록한다.
3. OAuth 2.0 Web application client의 Authorized JavaScript origins에 실제 origin을 정확히 등록한다
   (`http://127.0.0.1:1420`, 필요하면 별도로 `http://localhost:1420`).
4. Browser API key는 같은 origin과 필요한 Google API로 제한한다.
5. 로컬 개발은 `.env.local`에 `VITE_GOOGLE_DRIVE_CLIENT_ID`, numeric project number인
   `VITE_GOOGLE_DRIVE_APP_ID`, `VITE_GOOGLE_DRIVE_DEVELOPER_KEY`를 설정하고 dev server를 다시 시작한다.
   Docker는 `.env`의 대응하는 `MOYA_GOOGLE_DRIVE_CLIENT_ID`, `MOYA_GOOGLE_DRIVE_APP_ID`,
   `MOYA_GOOGLE_DRIVE_DEVELOPER_KEY`를 컨테이너 재생성 때 읽는다.

실제 Chrome Web에서 test-user consent, Picker 선택, 선택한 65 MB EPUB의 metadata/content download, Library
import와 reload 영속성까지 확인했다. Source Hub는 큰 파일이 멈춘 것처럼 보이지 않도록 remote download, 원문
확인, 분석·저장 단계를 구분해 표시한다. token expiry/revocation 재연결과 다운로드 중 취소는 별도 live gate다.
전체 Drive 탐색과 `drive.readonly` 요청은 보류 상태이며 이 connector가 암묵적으로 승격하지 않는다.

## Dropbox Web connector

Dropbox source는 제품 기본 외부 소스이며 Cloud Vault provider를 파일 브라우저로 재사용하지 않는다. 같은
public app key를 쓸 수는 있지만 `files.metadata.read files.content.read` scope의 별도 OAuth grant와 별도
credential envelope를 사용한다.
`VITE_DROPBOX_SOURCE_APP_KEY`가 있으면 우선하고, 없으면 `VITE_DROPBOX_APP_KEY`를 public client ID로 재사용한다.
Docker Web에서는 같은 우선순위를 `MOYA_DROPBOX_SOURCE_APP_KEY`, `MOYA_DROPBOX_APP_KEY` runtime 값에 적용한다.

host broker가 제공하는 범위는 다음뿐이다.

- root/folder `list_folder`와 cursor continuation
- filename search와 cursor continuation
- 지원 형식 metadata projection
- 사용자가 고른 stable remote ID 한 개의 다운로드
- ID/revision/size 재검증, 512 MiB 상한과 abort
- token 만료 시 single-flight refresh
- 유효기간 전 401도 refresh 뒤 한 번만 재시도하고 동시 refresh는 single-flight로 합친다.
- continuation cursor는 account/folder/query 문맥에 묶고 같은 provider cursor가 반복되면 중단한다.
- 대기 중인 metadata/file response stream은 취소 시 reader까지 중단한다.
- status 기반 안전한 오류만 UI에 전달하고 Dropbox response body는 숨김

외부 소스 연결은 popup 의존 없이 현재 탭의 Authorization Code/PKCE/state redirect로 진행하고 callback query를
정리한 뒤 같은 화면을 복구한다. credential은 같은 browser profile/origin에서 자동 복구한다. Popup relay는 다른
Dropbox 화면과의 호환 경로로 남아 있지만 외부 소스의 기본 흐름은 아니다. Tauri production custom scheme과
Android Custom Tab/app-link adapter는 후속 범위다. App access type이 App Folder면 그 폴더만, Full Dropbox면
grant가 허용한 계층을 표시한다.

## Suwayomi / Mihon Source Bridge

Moya는 Mihon Android extension APK를 Web/React 안에서 직접 실행하지 않는다. 제품 기본 `catalog` source인
Suwayomi bridge가 사용자가 소유한 Suwayomi Server를 호스트 runtime으로 사용한다. Mihon 호환 extension의
설치·업데이트·사이트별 네트워크 처리는 Suwayomi가 맡고, Moya는 이미 설치되어 로드 가능한 source만
정규화해 표시한다. 이 connector는 익스텐션 토글 대상이 아니며 Moya AI/UI 익스텐션과도 별도다.

현재 구현 경로는 다음과 같다.

```text
설정 → 소스에서 Suwayomi endpoint 연결
  → 설치된 Mihon source 목록
  → POPULAR 또는 검색 작품 목록
  → 작품 상세와 회차 목록
  → 사용자가 선택한 회차 CBZ 한 개 다운로드
  → 기존 ImportService와 ExternalSourceLink
  → 고정 문서 Reader
```

- GraphQL `POST /api/graphql`의 `aboutServer`, `sources`, `fetchSourceManga`,
  `fetchMangaAndChapters`를 사용한다. Source ID는 `LongString` 그대로 보존해 음수 ID도 number 변환 없이
  전달한다.
- 회차 import는 공식 `GET /api/v1/chapter/{chapterId}/download?markAsRead=false` CBZ를 우선 사용한다.
  해당 endpoint가 없는 구버전은 `fetchChapterPages` 결과를 같은 인증으로 읽어 bounded CBZ를 만든다.
- 인증 없음, UI login access/refresh token, Basic auth를 지원한다. UI login password는 저장하지 않고 token만
  기기 키로 봉인한다. Basic password도 저장하지 않아 앱 재시작 뒤 다시 연결해야 한다. Cookie 중심
  `SIMPLE_LOGIN`은 cross-origin Web 제약 때문에 v1에서 지원하지 않는다.
- 원격 오류 body, password와 token은 UI/plugin/cache로 전달하지 않는다. 인증이 필요한 thumbnail은 DOM URL로
  직접 내보내지 않고 앱 내부 임시 표지를 사용한다.
- 작품 카드를 여는 것만으로 회차 원문을 다운로드하지 않는다. 회차별 버튼 또는 일괄 선택이 기존
  download/hash/import/link 안전 경계를 통과해야 한다.

현재 local book model에는 원격 연재 작품 하나 아래 여러 CBZ 회차를 누적하는 aggregate가 없다. 따라서 v1은
회차 하나를 Library의 CBZ 문서 하나로 가져오며 UI에도 이 제한을 명시한다. 다음 catalog checkpoint는
`serial comic` aggregate, 작품 단위 provenance와 원격 이어읽기를 설계한다. 모든 회차를 브라우저에서 하나의
거대한 archive로 다시 묶는 방식은 사용하지 않는다.

### 개인 self-host Docker profile

`compose.suwayomi.yaml`은 공식 `ghcr.io/suwayomi/suwayomi-server:stable` image를 선택형 compatibility runtime으로
추가한다. Suwayomi 호스트 port는 publish하지 않고, Moya Web과 Suwayomi를 사용자가 미리 만든 외부 Nginx Proxy
Manager network에 각각 `moya-web:80`, `moya-suwayomi:4567` alias로 연결한다. NPM이 Docker 컨테이너일 때
`127.0.0.1`이 NPM 자신을 가리키는 문제를 피하면서 기존 Moya host port는 계속 loopback에 둘 수 있다.

- `ui_login`이 기본이며 username/password가 없으면 Compose interpolation 단계에서 fail-closed한다. `basic_auth`도
  선택할 수 있지만 Moya의 Basic password는 session-only라 browser 재시작 뒤 다시 연결해야 한다.
- `/home/suwayomi/.local/share/Tachidesk`는 `suwayomi-data` named volume에 보존한다. Extension store를 환경
  변수로 강제하지 않아 WebUI에서 저장한 설정을 재시작 때 빈 값으로 덮어쓰지 않는다.
- healthcheck는 credential을 command line에 넣지 않고 root의 2xx/3xx 또는 인증 경계의 401/403을 생존 응답으로
  인정한다.
- Docker Web entrypoint는 Dropbox/Google public identifier 5개와 `MOYA_SUWAYOMI_DEFAULT_URL`만 allowlist한
  `/runtime-config.js`를 매 시작 생성한다. 이 파일은 application module보다 먼저 로드되고 nginx와 service
  worker 모두 cache하지 않는다. 임의 env, bearer token, app/client secret과 provider key는 투영하지 않는다.
- `MOYA_SUWAYOMI_DEFAULT_URL`은 Source 설정 form의 기본 주소로 자동 투영한다. 현재 API path가 root 기준이므로
  HTTP(S) origin만 허용하고 subpath, query, fragment와 URL userinfo는 거부한다.
- 운영 예시는 [WireGuard 전용 Nginx Proxy Manager 배포](../operations/nginx-proxy-manager-wireguard.md)를 따른다.

Runtime config의 allowlist/escaping/cache bypass와 Docker image build는 로컬에서 검증했다. Base/public Compose와
Suwayomi overlay 조합, 필수 credential 누락 실패, 공식 stable image의 `ui_login` root 생존과 `basic_auth` 401
health boundary도 확인했다. 이는 실제 WireGuard routing, DNS/TLS 인증서, NPM Proxy Host, Hosted OAuth callback,
volume 재생성 복구나 제3자 Mihon extension browse/import를 대상 서버에서 완료했다는 뜻은 아니다.

HTTP localhost Moya와 공식 계약 fixture로 연결 → 설치 source → 작품 → 상세/회차 → CBZ import → Reader →
reload 영속성을 실제 Web에서 확인했다. 이 evidence는 UI와 host boundary 검증이며 실제 제3자 Mihon extension
하나를 설치한 Suwayomi live gate, source filter/latest, source preference/login, authenticated cover asset,
HTTPS Web에서 HTTP LAN endpoint로 접근할 때의 mixed-content/PNA, Tauri managed sidecar를 완료했다는 뜻은 아니다.

## 개발과 검증

`VITE_ENABLE_EXTERNAL_SOURCE_SMOKE_FIXTURE=true`인 development build만
`moya.dev.external-fixture.catalog`를 동적 import한다. Production inventory와 bundle에는 이 sample을 넣지 않는다.
`VITE_EXTERNAL_SOURCE_FIXTURE_REVISION=1|2`로 같은 remote identity의 원격 변경을 재현할 수 있다. 개발 fixture Web
gate는 revision 1 선택 import 뒤 같은 origin을 revision 2로 다시 열어 `업데이트 있음`, 사용자 확인, 동일 작품
ID의 새 content revision, 변경 본문과 link의 reload 영속화를 확인했다. Exact source hash가 같으면
`ImportService`를 건너뛰고 checked revision만 갱신하며 실패·취소 시 이전 link와 활성 본문을 유지한다.

실제 Dropbox Web gate는 등록된 public app key와 read scope로 현재 탭 OAuth를 완료한 뒤 루트 목록의 폴더와
지원 PDF metadata만 먼저 표시하고, 사용자가 고른 `Dropbox 시작하기.pdf` 한 개만 다운로드·검증·import했다.
10페이지 PDF가 로컬 책장에 추가되고 항목이 `가져옴`으로 바뀌었으며, 새로고침 뒤에도 4권 책장·연결 credential·
remote-to-local link가 복구됐다. 이 과정에서 raw `fetch`의 illegal invocation, download metadata의 생략 가능한
`.tag`, import worker 안에서 PDF.js worker 채널이 충돌하는 Web 결함을 수정했다. 실제 token expiry 강제 refresh,
권한 철회·재연결, 100개 이상 실계정 pagination과 대형 파일 취소는 별도 gate다.

Source Hub checkpoint는 기존 modal과 중복 source rail을 제거했다. 연결된 source만 desktop sidebar와 mobile
drawer에 나타나며 cloud folder는 별도 탐색 영역, file/work는 Library형 card로 표시한다. 새 항목은 카드별
`라이브러리로 추가` 또는 일괄 선택, 기존 link는 `라이브러리에서 보기`, revision drift는 명시적 `업데이트`를 사용한다.
Catalog의 표시 제목과 import 파일명은 `importFileName`으로 분리한다. 실제 Dropbox root/card/open-local-book와
개발 catalog의 단일 card import 2→3권/reload가 local Web에서 통과했다. Suwayomi work detail은 후속 bridge에서
구현했지만 generic remote cover fetch/cache와 release list는 아직 없으며 development fixture도 production
bundle에는 등록되지 않는다.

Cloud folder 안에서는 현재 위치를 source connector와 account connection 조합의 기본 폴더로 지정할 수 있다.
선택은 source 전용 IndexedDB preference에 breadcrumb와 opaque `parentRef`만 저장하며 credential이나 원문은
저장하지 않는다. Library에서 source를 다시 열거나 Web을 reload한 뒤에도 해당 위치부터 목록을 불러오고, 저장된
위치를 provider에서 열 수 없으면 preference를 제거한 뒤 최상위 폴더로 돌아간다.

다음 connector도 같은 common model과 host broker를 사용하되 cloud file과 작품 catalog의 provider semantics를
한 거대한 optional interface로 합치지 않는다. 배포 직후에는 실제 WireGuard/NPM host에서 HTTPS origin,
OAuth callback, 컨테이너·volume 재생성 및 합법적으로 설치한 Mihon extension 하나의 live gate를 수행한다.
제품 구조의 다음 우선순위는 Suwayomi 회차를 한 작품 아래 누적하는 `serial comic` model이다. Dropbox/Google의
강제 token expiry·권한 철회·대형 파일 취소는 connector 공통 회귀 gate에서 함께 확인한다.
