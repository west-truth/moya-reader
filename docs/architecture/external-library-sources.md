# 외부 작품 소스 아키텍처

상태: Phase 3B Source Hub, Dropbox·Google Drive live, Suwayomi serial-comic과 self-host Docker profile 구현
기준일: 2026-08-31

## 삭제 후 연결 복구와 회차 상태

- 연결의 저장된 해시만으로 다운로드를 생략하지 않는다. 대상 작품이 실제로 있을 때만 중복/append 판정에
  사용한다. 원본·표지·증분 업로드 경계는 그대로 유지한다.
- 연결 정리용 조회만 휴지통을 포함한다. Hosted는 `GET /books?includeTrash=true`의 owner-scoped ID cursor와
  `includesTrash` 응답 확인을 사용한다. 기본 Library 목록은 바뀌지 않는다. 구버전 API나 실패/불완전한
  조회를 작품 삭제로 취급하지 않는다.
- 조회 전의 link snapshot과 아직 같은, 실제로 없는 작품의 완료된 link만 source IndexedDB transaction에서
  지운다. 마지막 연결의 subscription도 함께 정리하되 휴지통·진행 중 import·다른 작품의 연결·다운로드 전
  작품 등록은 보존한다. 새로운 purge/generation 실행 계층이나 polling은 추가하지 않는다.
- Library 변경 및 기존 소스 진입/새로고침 경계에서 상태를 갱신한다. 휴지통 작품에는 새 회차를 덮어쓰지 않고
  복원/영구 삭제를 안내한다.
- 읽음 상태는 만화 section ID, 소설 chapter ID에 저장된 기록으로 판단한다. 현재 회차보다 앞이라는 이유만으로
  읽음 처리하지 않는다. Reader에서 상세로 돌아가기 전 저장을 기다린다.

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
- `browsePreferences`: catalog 위치별 인기/최신 mode와 extension filter 값, cloud 기본 폴더
- `subscriptions`: 제품 UI의 `라이브러리에 추가한 원격 작품`을 구현하는 내부 account-scoped record. 작품
  identity, cover/metadata, 이미 확인한 회차 ID, 아직 확인하지 않은 새 회차 ID와 마지막 확인 시각을 보존

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
   (`http://127.0.0.1:1421`, 필요하면 별도로 `http://localhost:1421`).
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
  → source capability에 따른 POPULAR / LATEST / SEARCH와 확장 필터
  → 작품 상세와 회차 목록
  → 작품을 라이브러리에 추가하고 foreground 새 회차 metadata 확인
  → 사용자가 선택한 회차 CBZ만 다운로드
  → 작품별 bounded aggregate CBZ + moya-series.json
  → 기존 ImportService와 작품/회차 ExternalSourceLink
  → 회차 선택이 가능한 고정 문서 Reader
```

- GraphQL `POST /api/graphql`의 `aboutServer`, `sources`, `fetchSourceManga`,
  `fetchMangaAndChapters`를 사용한다. Source ID는 `LongString` 그대로 보존해 음수 ID도 number 변환 없이
  전달한다.
- 회차 import는 공식 `GET /api/v1/chapter/{chapterId}/download?markAsRead=false` CBZ를 우선 사용한다.
  해당 endpoint가 없는 구버전은 `fetchChapterPages` 결과를 같은 인증으로 읽어 bounded CBZ를 만든다.
- 인증 없음, UI login access/refresh token, Basic auth를 지원한다. UI login password는 저장하지 않고 token만
  기기 키로 봉인한다. Basic password도 저장하지 않아 앱 재시작 뒤 다시 연결해야 한다. Cookie 중심
  `SIMPLE_LOGIN`은 cross-origin Web 제약 때문에 v1에서 지원하지 않는다.
- 원격 오류 body, password와 token은 UI/plugin/cache로 전달하지 않는다. 인증이 필요한 thumbnail은 broker가
  같은 인증으로 읽어 session-only blob URL로 투영하고 catalog cache에는 저장하지 않는다. Library 최초 import에서는
  사용자 표지가 없는 경우에만 작품 표지를 검증해 `approved_enrichment` cover로 보존한다.
- 작품 카드를 여는 것만으로 회차 원문을 다운로드하지 않는다. 회차별 버튼 또는 일괄 선택이 기존
  download/hash/import/link 안전 경계를 통과해야 한다.

2026-08-26 serial-comic checkpoint부터 같은 원격 작품의 선택 회차는 Library 작품 하나에 누적한다. Aggregate의
root `moya-series.json`은 collection identity, 원격 회차 ID/revision/hash, 정렬 순서와 정확한 page entry를 기록한다.
내부 page chapter/paragraph ID는 `localBookId + remote release ID + release 내 page index`로 만들어 뒤에 회차를
추가해도 기존 독서 위치가 이동하지 않는다. Reader는 page 기반 구조를 유지하면서 회차 선택으로 각 시작 page에
이동한다.

현재 구현은 선택해 받은 회차만 최대 5,000 page/1 GiB의 aggregate CBZ로 다시 만든다. 회차 추가·교체는 기존
원본을 export해 manifest가 확인된 page를 보존한 뒤 같은 local book ID의 새 content revision으로 원자적으로
교체한다. 이전 단일 회차 import 하나는 연결 provenance가 있으면 첫 aggregate로 승격한다. 같은 작품의 과거
단일 회차가 여러 Library 항목에 흩어진 경우에는 임의 병합하지 않고 실패한다. 대형 장기 연재가 이 한도에
도달하기 전 segmented source asset으로 바꾸는 것은 후속 확장점이다.

회차 link는 `collectionRemoteId`와 개별 source identity를 함께 보존한다. Suwayomi의 조회 시각 `fetchedAt`과
첫 다운로드 뒤에 채워질 수 있는 `pageCount`는 content revision에서 제외하고 회차 ID·업로드 시각만 사용한다.
이전 `chapterId:pageCount:uploadDate` link는 비교 시 현재 형식으로 정규화해 단순 cache fill이 가짜
`업데이트 있음`을 만들지 않는다. 실제 update/import 실패·취소 시 기존 aggregate와 link는 유지된다.

`subscriptions` capability는 내부 갱신 계약 이름이며 제품 UI에는 별도 `구독` 개념으로 노출하지 않는다. Source
카드나 작품 상세의 `라이브러리 추가`는 cover/metadata와 원격 작품 identity를 저장해, 회차를 아직 받지 않은
작품도 Library의 일반 작품 카드로 투영한다. 첫 회차 import 뒤에는 같은 collection link를 가진 실제 로컬 작품
카드가 그 자리를 이어받아 중복 카드를 만들지 않는다. 추가 시 현재 회차 ID가 baseline이 되며 이후 Source Hub
진입, `새 회차 확인` 또는 작품 상세 새로고침이 bounded 회차 metadata만 다시 조회한다. 새 ID는 확인 완료하거나
해당 회차를 성공적으로 가져올 때까지 account-local badge로 남는다. `새 회차 선택`은 기존 단일/일괄 import
안전 경계에 선택만 전달하며, 라이브러리에 추가하는 것만으로 CBZ나 page image를 다운로드하지 않는다. 연결
해제나 다른 account 전환 시 record는 보존하지만 해당 account가 다시 연결되기 전에는 조회하지 않는다. 인증된
Suwayomi가 만든 session-only `blob:` 표지는 추가 시 bounded JPEG/PNG/WebP data URL로 materialize해 같은 로컬
record에 저장한다. 따라서 session 종료나 reload 뒤에도 원격-only Library 카드 표지가 유지되며 catalog cache에는
여전히 임시 blob URL을 쓰지 않는다.

POPULAR/LATEST와 extension-defined filter 값도 connector/account/source navigation 위치별로 저장한다. 작품
상세에서 source 목록으로 돌아가거나 같은 source를 다시 열면 마지막 mode와 filter request를 복원한다. Provider가
filter schema를 바꿔 저장값을 거부하면 일반 목록 오류/마지막 cache 경계를 따르며 canonical Library 데이터에는
영향을 주지 않는다.

Mihon의 extension filter는 source의 POPULAR/LATEST method가 아니라 SEARCH request의 `FilterList`에서 소비된다.
따라서 Source Hub의 `확장 필터 → 적용`은 텍스트 검색어가 비어 있어도 명시적인 SEARCH로 실행한다. 이후 같은
목록의 새로고침과 더 보기도 SEARCH identity를 유지한다. `인기` 또는 `최신`으로 돌아가는 동작은 각 mode 버튼을
명시적으로 선택했을 때만 일어나며, 빈 검색어의 필터 화면은 UI에서 `필터 결과`로 표시한다.

Library에서 `image_archive` 작품에 logical document section이 있으면 바로 page Reader를 열지 않고 연재 작품
상세로 진입한다. 상세 화면은 텍스트 작품 상세와 같은 cover/byline/description/tag/action/stat shell을 사용하고,
로컬 page chapter를 `documentSectionId` 단위 회차로 투영하며 source 연결이 살아 있으면 같은 collection의 원격
회차를 합친다. 받은 회차, 미다운로드 회차와 revision 변경 회차의 작업은 접근 가능한 34px 보기/다운로드/갱신
icon으로 표시한다. Source 연결이 없거나 끊겨도 받은 회차와
표지·metadata는 로컬 상세에 남는다. Reader는 선택 회차의 첫 page로 열리고 뒤로가기는 작품 상세를 복원한다.

이 상세/회차 projection은 Suwayomi 전용 UI가 아니다. `moya-series.json`처럼 logical section을 가진 로컬
image archive도 같은 상세와 회차 목록을 사용한다. 2026-08-26 local-series import부터 사용자가 함께 고른
회차별 ZIP/CBZ/RAR/CBR/7z 또는 한 단계 안쪽에 ZIP/CBZ 회차가 든 outer ZIP/CBZ를 하나의 aggregate로 만들 수
있다. 작품 상세의 작은 `+` 보조 동작 또는 import dialog에서 exact title 후보를 명시적으로 선택해 기존 작품에
추가한다. exact hash 중복은 건너뛰고 같은 release identity의 다른 내용은 기존 회차를 보존한 채 conflict로
표시한다. 이미 별도 Library 작품으로 저장된 항목의 사후 병합과 fuzzy title 자동 병합은 아직 지원하지 않는다.

작은 `+`로 제공하는 `로컬 회차 추가`는 source 연결의 기능이 아니라 Library 보조 기능이다. Suwayomi 연결 여부와 관계없이 일반 단일
image archive를 첫 회차로 승격할 수 있고, TXT/Markdown/EPUB 작품 상세에서도 같은 명시적 진입점을 제공한다.
텍스트/EPUB는 원격 source link 대신 `moya-document-series.json`과 보존된 원본 파일로 구성된 local package를
사용한다. 따라서 Suwayomi 작품에 로컬 파일을 얹는 것이 기본 흐름은 아니며, 로컬 작품의 파일 기반 증분 관리가
주 목적이다.

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

HTTP localhost Moya와 공식 계약 fixture에 더해 실제 설치된 Blacktoon/Naver Mihon source를 확인했다. Blacktoon은
authenticated cover와 HTTP 400 direct-download fallback으로 35-page 회차 import가 통과했다. Naver는
POPULAR/LATEST와 extension-defined select/sort filter를 실제 목록에 투영했고, `서른의 봄` 01·02를 한 작품으로
가져온 뒤 03을 추가해 3개 회차·212 page가 됐다. Reader 회차 선택, reload 영속성과 안정적인 revision 재조회도
통과했다. 후속 새 회차 checkpoint는 `서른의 봄`을 Library 원격 작품으로 추가하고 reload 뒤 root 작품 카드와
15개 회차 재진입, POPULAR/LATEST preference 복원 및 390×844 레이아웃을 확인했다. 이어서 Source 카드 전체
상세 진입/원클릭 추가, 영구 원격 표지, text-detail형 상세·회차 표와 작은 `+` 로컬 추가 동선도 실제 Naver
source에서 확인했다.
이는 주기적 background polling/notification,
모든 Mihon extension 호환, HTTPS Web의 HTTP LAN mixed-content/PNA, target-host Docker/NPM 및 Tauri managed
sidecar 완료를 뜻하지 않는다.

## 가져오기 연결의 crash·다중 창 복구

외부 source link는 본문보다 먼저 성공 상태로 기록하지 않는다. 다운로드와 hash 검증 뒤 import 직전에
`pendingImport`를 저장하고, 본문 활성화가 끝난 뒤에만 확정 link로 바꾼다.

- intent에는 매 실행마다 다른 `operationId`, 기존 link 존재 여부, 이전 content revision, 기대 source asset hash와
  적용할 원격 revision/hash를 기록한다.
- 앱이 중단되면 다음 source projection이 활성 작품의 `sourceContentHash`를 기대 hash와 비교한다. 정확히 일치할
  때만 확정하고, 일치하지 않으면 기존 link는 복구하고 새 link intent는 제거한다. 단순히 content revision ID가
  달라졌다는 이유만으로 해당 source import 성공으로 간주하지 않는다.
- 확정·복구는 IndexedDB 한 transaction 안에서 현재 `operationId`가 기대값과 같은지 확인하는 compare-and-swap을
  사용한다. 다른 탭의 더 최신 가져오기를 이전 탭의 늦은 성공/실패가 덮어쓰지 않는다.
- staging도 기존 link baseline과 pending owner를 같은 transaction에서 검사해 acquire한다. Hash가 아직 바뀌지 않은
  30분 이내 intent는 진행 중으로 보고 건드리지 않으며, lease가 지난 intent만 exact hash 확정 또는 이전 link
  복구 대상으로 삼는다.
- import promise가 완료된 순간부터 본문은 적용된 것으로 본다. 그 뒤 projection용 재조회가 실패해도 이전 link로
  되돌리지 않고 import 결과와 durable intent로 복구한다.
- 단일 작품과 Suwayomi aggregate 회차 가져오기는 같은 규칙을 사용한다. Aggregate는 실제로 import할 최종 CBZ의
  hash를 먼저 계산해 각 회차 link intent에 공통으로 기록한다.

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
Cover에는 원격 이미지 또는 중립 아이콘만 표시하고 제목·파일 형식 글자 overlay는 표시하지 않는다.
Catalog의 표시 제목과 import 파일명은 `importFileName`으로 분리한다. 실제 Dropbox root/card/open-local-book와
개발 catalog의 단일 card import 2→3권/reload가 local Web에서 통과했다. Suwayomi work detail, 원격 cover와
표지 없는 release list는 후속 bridge에서 구현했다. Library의 연재 작품 카드에서도 같은 detail로 진입하며
로컬/원격 회차 상태를 합친다. Development fixture는 production bundle에 등록되지 않는다.

Cloud folder 안에서는 현재 위치를 source connector와 account connection 조합의 기본 폴더로 지정할 수 있다.
선택은 source 전용 IndexedDB preference에 breadcrumb와 opaque `parentRef`만 저장하며 credential이나 원문은
저장하지 않는다. Library에서 source를 다시 열거나 Web을 reload한 뒤에도 해당 위치부터 목록을 불러오고, 저장된
위치를 provider에서 열 수 없으면 preference를 제거한 뒤 최상위 폴더로 돌아간다.

다음 connector도 같은 common model과 host broker를 사용하되 cloud file과 작품 catalog의 provider semantics를
한 거대한 optional interface로 합치지 않는다. 배포 직후에는 실제 WireGuard/NPM host에서 HTTPS origin,
OAuth callback, 컨테이너·volume 재생성 및 합법적으로 설치한 Mihon extension 하나의 live gate를 수행한다.
Suwayomi source preference와 Library 원격 작품/foreground 새 회차 확인은 구현됐다. 다음 source 후보는 사용자가 실제로
요청할 때의 선택적 새 회차 알림/자동 다운로드 정책, HTTPS→HTTP LAN PNA/managed sidecar와 장기 연재 segmented
storage다. 사후 Library 작품 병합은 개발 단계에서는 우선하지 않는다. Dropbox/Google의 강제 token expiry·권한
철회·대형 파일 취소는 connector 공통 회귀 gate에서 함께 확인한다.
