# Cloud Vault 동기화 아키텍처

Status: metadata v1, per-book AI/TTS encrypted objects, Web content objects, revision-aware foreground auto sync implemented
Last updated: 2026-08-31

## 만화 회차별 원본

- 누적 작품 목록 한도 확대가 대용량 복원까지 지원한다는 뜻은 아니다. 현재 복원용 portable package는
  모든 part를 한 번에 materialize하므로 원본 합계 1GiB까지만 지원한다. 앱 전체 백업의 별도 용량/항목
  한도도 남아 있다. 이 경계의 스트리밍 복원은 별도 checkpoint다.
- 만화 회차 추가로 만든 작은 manifest 원본과 immutable 회차 CBZ를 별도로 전송한다. 본문 소유권에
  속하는 `sourcePartObjects`는 제목/표지 metadata clock과 섞지 않는다. 소설의 원본 전송은 바꾸지 않는다.
- 원본은 기존 content hash 기반 경로에 저장한다. 이전 완료 목록에 있는 part는 재업로드하지 않고,
  모든 part가 준비된 뒤 manifest를 게시한다. 실패한 원본 전송을 완료 상태로 표시하지 않는다.
- 복원은 hash/크기를 검사하고 이미 기기에 있는 part는 재다운로드하지 않는다. 검증된 manifest+part
  package를 기존 importer에 전달하며, 기존 기기의 페이지 순서 변경도 revision 활성화와 함께 갱신한다.
- 전체 백업과 일반 CBZ 내보내기는 별도다. 구버전 앱은 새 source format을 복원할 수 없으므로 기기 앱을
  함께 갱신하거나 신버전에서 일반 CBZ로 내보낸다. 복원 DB 쓰기 자체를 완전 증분화한 것은 아니다.

## 목적

Cloud Vault는 모야 서버를 운영하지 않는 사용자도 여러 기기에서 서재와 독서 상태를 옮길 수 있게 하는 선택
기능이다. 기본 상태에서는 클라우드 사업자가 암호화된 Vault 기록 파일만 보관한다. 사용자가 `작품 파일과
표지`를 명시적으로 켜면 새 기기 복원을 위해 원본과 활성 표지도 사용자의 개인 저장소에 별도 보관한다.

기존 서버 동기화와의 관계는 다음과 같다.

- 서버 동기화를 쓰지 않는 로컬 사용자는 Cloud Vault를 양방향 동기화로 사용할 수 있다.
- 서버 동기화가 연결된 사용자는 Cloud Vault를 암호화 백업 대상으로만 사용한다. 두 개의 양방향 동기화 엔진이 같은 데이터를 동시에 수정하지 않는다.
- Cloud Vault 연결은 선택 사항이고, 연결하지 않은 경우 현재의 IndexedDB 로컬 우선 동작은 바뀌지 않는다.

## 1차 지원 범위

기본으로 포함하는 데이터:

- 작품 식별 정보와 메타데이터, 서재와 컬렉션
- 마지막 독서 위치와 작품별 진행률
- 북마크, 하이라이트, 메모
- 독서 세션과 누적 통계
- 등장인물, 관계, 화자 라벨, 사용자 보정, 음성 배정 등 재생성 비용이 있는 AI/TTS 산출물

선택 항목:

- Reader 표시 설정은 기기별 선호가 다를 수 있으므로 기본값은 꺼짐이다.
- 작품 원본과 활성 표지는 기본값이 꺼짐이다. 사용자가 켠 경우에만 업로드하며, 다른 Web 기기의 수동 동기화에서
  누락 작품을 기존 import pipeline으로 복원한다.

의도적으로 제외하는 데이터:

- 정규화 본문, 문단 텍스트, 검색/OCR index와 EPUB 추출 resource처럼 원본에서 재생성할 수 있는 파생 데이터
- TTS 오디오 바이너리
- API key, OAuth access token 평문, provider job/lease, 임시 캐시와 로그

TTS 오디오는 파일 크기, 만료 정책, 부분 업로드와 중복 제거가 별도 설계를 요구하므로 v1에서 항상 제외한다.

## 저장 형식과 암호화

논리 metadata 포맷은 `noveldesk-cloud-vault` version 1이고 클라우드에는
`noveldesk-vault-v1.enc.json`을 저장한다. 원본 동기화는 이 파일을 v2로 강제 변환하지 않고 optional descriptor를
증분 추가한다. 구형 v1 payload에는 descriptor가 없으며 지금처럼 `원문 연결 대기`로 동작한다.

1. 현재 IndexedDB 상태를 `CloudVaultSnapshotV1`으로 캡처한다.
2. 로컬과 원격 snapshot을 항목 단위로 병합한다.
3. JSON payload를 사용자 암호로 PBKDF2-SHA-256(310,000회) 키 유도 후 AES-256-GCM으로 암호화한다.
4. provider는 암호문과 revision만 읽고 쓴다.

작품 파일 동기화를 켠 경우에는 다음 sidecar 경계를 추가한다.

- object key: `content/v1/sha256/<원본 SHA-256>`
- 동일 byte content는 작품이나 기기가 달라도 한 번만 저장한다.
- object path에는 제목이나 로컬 book id를 넣지 않는다.
- 원본과 표지는 사용자의 개인 Dropbox App Folder 또는 선택 폴더에 **추가 Moya 암호화 없이 그대로** 저장한다.
- 작품마다 별도 암호, 키, ZIP을 만들지 않는다. Vault 암호는 metadata 기록과 Dropbox credential 봉인에만 사용한다.
- download 후 byte length와 SHA-256을 확인한 뒤에만 기존 importer에 전달한다.
- remote object 삭제와 garbage collection은 안전한 참조/보존 정책이 마련될 때까지 하지 않는다.

AI/TTS 산출물은 공용 metadata 파일을 작품 수와 분석 구간 수에 비례해 계속 키우지 않도록 작품별 암호화
sidecar로 분리한다.

- object key: `ai-tts/v1/sha256/<산출물 payload SHA-256>`
- payload identity: `normalizedTextHash`; 제목이나 로컬 book id는 경로에 넣지 않는다.
- 등장인물, 관계, 화자 segment, 사용자 보정과 음성 배정만 해당 작품 payload에 저장한다.
- 각 payload는 공용 Vault와 같은 사용자 암호/PBKDF2/AES-GCM 경계로 암호화한다. 원본·표지 object의 평문
  정책과 다르다.
- 공용 `CloudVaultBookV1`에는 최신 `aiTtsObject` descriptor와 revision만 남긴다.
- 다른 기기는 descriptor가 처음 보이거나 바뀐 작품만 다운로드·복호화·hash 확인 후 적용한다.
- 기존 v1 공용 파일에 inline AI/TTS 배열이 있으면 첫 정상 동기화에서 sidecar를 먼저 저장한 뒤 descriptor로
  바꾼다. sidecar 저장 실패 시 inline 배열을 유지해 다음 동기화에서 재시도한다.
- content-addressed object의 원격 정리는 공통 참조/보존 정책이 생기기 전까지 하지 않는다.

Vault 암호는 최소 8자다. 사용자가 기본값인 `이 기기에서 기억`을 유지하고 암호로 한 번 성공하면, Web 런타임은
비추출형 AES-GCM 기기 키를 IndexedDB에 만들고 암호화된 암호만 같은 origin의 Cloud Vault 설정 DB에 저장한다.
다음 실행에서는 암호 원문을 input이나 React 상태로 복원하지 않고 controller의 세션 참조만 잠금 해제한다.
사이트 데이터를 지우거나 기기 키를 잃으면 다시 입력해야 하며, 연결 해제와 기억 끄기는 저장된 암호 envelope를
삭제한다. 기기 키와 envelope가 같은 Web origin에 있으므로 이는 디스크의 평문 노출을 줄이는 장치이지 XSS나
침해된 origin에 대한 OS keychain 수준의 방어는 아니다. Windows Tauri 런타임은 기억한 Vault 암호와 Dropbox
OAuth credential을 Windows Credential Manager에 저장한다. React에는 암호를 다시 렌더링하지 않고 controller
session ref만 잠금 해제하며, 구형 desktop IndexedDB envelope는 성공적으로 읽은 뒤 native store로 한 번 이관한다.
Android는 기존 Keystore credential 경계를 유지하지만 Dropbox OAuth 진입은 아직 비활성화되어 있다. DB v2 전환 중
다른 구버전 Moya 탭이 열려 있으면 무한 대기하지 않고 다른 탭을 닫은 뒤 새로고침하도록
안내하며, 열린 DB는 이후 `versionchange`에서 스스로 닫는다.

Web의 Dropbox refresh token은 같은 Vault 암호로 별도 봉인해 저장한다. Windows desktop은 access/refresh token
JSON을 OS secure store에 저장한다. 어느 런타임이든 Vault 암호를 잊으면 원격 metadata를 복구할 수 없으며 기억
기능은 복구 수단이 아니다.

## 작품 재연결과 복원

신규 동기화는 로컬 book ID와 분리된 `vaultBookId`를 작품 identity로 사용한다. 기존 v1 manifest나 아직 stable ID가
저장되지 않은 기기는 `normalizedTextHash`로 한 번만 매칭한 뒤 원격 stable ID를 로컬 작품에 승격한다.

Stable ID가 같은 작품의 본문이 교체되면 metadata clock과 분리된 additive `contentAt`/`contentDeviceId`가 본문,
format, chapter reference와 source descriptor의 승자를 정한다. 같은 normalized body는 기기별 anchor reference를
합치지만 source ownership은 content clock을 따른다. 다른 hash의 최신 원문을 기존 local 작품 ID에 교체하는 것은
`원본 파일` 동기화 범위를 켠 경우에만 가능하며, 다운로드 hash와 parser의 normalized hash를 canonical activation
전에 모두 확인한다. 원본 동기화를 끈 기기는 해당 본문을 자동 교체했다고 주장하지 않는다.

- 작품: `normalizedTextHash` 완전 일치
- 챕터: `index + textHash` 완전 일치
- 문단 anchor: `paragraphIndex + textHash` 완전 일치

작품 파일 동기화가 꺼졌거나 remote 원본 object가 없으면 해당 작품의 원격 기록은 삭제하지 않고
`waiting for source` 상태로 보존한다. object가 있으면 download/hash 검증, 기존 `ImportService`, normalized text hash
확인, 기존 artifact apply 순으로 복원한다. 작품은 일치하지만 chapter/paragraph anchor가 불일치하는 레코드는
잘못된 위치에 적용하지 않고 격리 건수로 보고한다.

복원 과정에서 원본 hash 또는 최종 `normalizedTextHash`가 다르면 그 작품의 기록은 적용하지 않는다. 한 작품의
실패가 암호화 metadata 파일이나 이미 존재하는 로컬 작품을 롤백하지는 않으며 UI에 개별 실패로 남긴다. 새로
복원한 작품에는 remote 활성 표지를 적용한다. 기존 로컬 작품도 metadata 병합에서 remote revision이 선택됐고
활성 표지의 hash 또는 맞춤/위치가 다르면 선택된 remote 표지로 교체한다. 이때 오래된 로컬 표지가 병합 직후
remote 표지 descriptor를 다시 덮어쓰지 않도록, local metadata가 선택된 작품의 표지만 upload 후보로 사용한다.

같은 본문을 다른 파일명으로 가져오면 local book/chapter/paragraph ID가 달라질 수 있다. 병합 파일은 각 기기의
content-addressed anchor reference를 함께 보존한다. 서재 membership은 stable ID 승격 전에는
`shelfId + normalizedTextHash`, 승격 후에는 `shelfId + vaultBookId` 기반 Vault ID를 사용한다.

## 병합과 충돌 규칙

- 진행 위치와 메타데이터: `updatedAt`이 최신인 값
- 북마크/하이라이트/메모/독서 세션: 안정적인 entity ID 기준 합집합 후 최신 revision
- AI/TTS 산출물: 일반 산출물보다 사용자 확정 캐릭터, 사용자 보정 segment, 사용자 선택 음성을 우선
- 삭제: tombstone이 대상 레코드보다 같거나 최신일 때만 삭제
- 동기화 범위: 현재 기기에서 사용자가 선택한 scope가 적용 동작의 기준
- 원격 write: provider revision을 이용한 compare-and-swap, 충돌 시 최신 원격을 다시 읽고 제한 횟수 재병합
- 적용 순서: source/AI sidecar 준비 뒤 원격 write가 필요하면 manifest CAS를 먼저 완료한다. No-op이면 apply 직전
  provider revision을 다시 확인한다. 두 경로 모두 네트워크 대기 중 로컬 snapshot이 바뀌지 않았을 때만 병합
  결과를 IndexedDB에 적용한다.
- 작품/표지 삭제: stable ID와 legacy hash를 함께 가진 영구 tombstone. 작품 복원이나 새 표지는 더 최신 clock으로
  tombstone을 해제한다.

Vault의 원격 데이터는 사용자가 현재 scope를 껐다는 이유로 즉시 파기하지 않는다. 다만 꺼진 범주의 데이터를 로컬에 적용하거나 새로 캡처하지 않는다.

## Provider 경계

`CloudVaultFileProvider`는 작은 암호화 metadata 파일에 다음 두 동작을 노출한다.

- `read(): bytes + revision`
- `write(bytes, expectedRevision): revision`

Dropbox처럼 metadata 조회가 싼 provider는 `getRevision()`도 제공한다. foreground 확인은 마지막 revision과 같으면
Vault 본문을 다운로드하지 않는다. 로컬 폴더 provider는 네트워크 전송이 없으므로 기존 read 경계를 유지한다.

원본 sidecar를 지원하는 provider는 별도 `CloudVaultObjectStore`를 구현한다.

- `getObject(objectKey): Blob`
- `putObject(objectKey, Blob, expected byte length): created/revision`

object는 content-addressed immutable data이므로 초기 제품 경로에는 list/delete/overwrite가 없다. 브라우저에서
큰 Blob을 불필요하게 `Uint8Array`로 복사하지 않으며 Dropbox는 큰 원본에 upload session을 사용한다.

현재 구현 provider:

- 로컬 동기화 폴더: File System Access API의 사용자 선택 directory handle. Syncthing, Dropbox desktop, OneDrive 등 사용자가 운영하는 동기화 폴더와 조합할 수 있다.
- Dropbox App Folder: PKCE OAuth 후 앱 전용 경로에 암호화 파일을 저장한다. 브라우저 bundle에는 app key만 두며 app secret은 두지 않는다.

Google Drive Cloud Vault provider는 아직 없다. 현재 Google Drive Picker source 연결과 credential을 재사용하지
않고, 앱이 만든 전용 폴더만 다루는 별도 `drive.file` OAuth/provider로 구현한다. WebDAV, S3 호환 저장소도 동일
object 경계 위의 후속 provider다. provider별 UI와 인증은 platform adapter에 머물고 snapshot/merge/crypto 코드는
공유한다.

## 구현 위치

- 계약과 포맷: `src/cloud-vault/contracts.ts`
- 암호화: `src/cloud-vault/crypto.ts`
- 충돌 병합: `src/cloud-vault/merge.ts`
- IndexedDB 캡처/재연결: `src/cloud-vault/indexeddb-artifact-repository.ts`
- provider: `src/cloud-vault/directory-provider.ts`, `src/cloud-vault/dropbox-provider.ts`
- OAuth: `src/cloud-vault/dropbox-oauth.ts`
- Windows system-browser callback와 OS secure store: `src-tauri/src/desktop_oauth.rs`,
  `src-tauri/src/secure_credentials.rs`, `src/platform/secure-credentials.ts`
- orchestration: `src/cloud-vault/service.ts`
- source/cover upload, integrity verification and import restore: `src/cloud-vault/content-transfer.ts`
- per-book encrypted AI/TTS sidecars: `src/cloud-vault/ai-tts-transfer.ts`
- local mutation scheduling policy: `src/cloud-vault/sync-policy.ts`
- 로컬 연결 정보: `src/cloud-vault/local-state.ts`
- Web 기기 암호 봉인: `src/cloud-vault/device-passphrase.ts`

## 운영상 남은 경계

- Web 자동 동기화는 기본값이 켜져 있다. 시작 시에는 종료 직전 미전송 변경을 놓치지 않도록 전체 병합을 한 번
  수행한다. 이후 online/focus/visible 복귀와 화면이 열린 동안 2분 간격 확인은 Dropbox revision만 먼저 비교하고,
  같으면 암호화 파일을 다운로드하거나 다시 쓰지 않는다.
- 명시적 작품·메타데이터·주석 변경은 5초, Reader 설정은 10초로 묶는다. 읽기/듣기 위치와 AI/TTS 결과는
  60초 debounce와 최초 dirty 시점 기준 3분 상한을 사용한다. 30초마다 저장되는 독서 통계는 단독 네트워크 요청을
  만들지 않고 다음 동기화 또는 background 전환에 합류한다. 꺼진 scope의 변경은 예약하지 않는다.
- 동기화 중 들어온 로컬 변경은 완료 직후 한 번 더 실행하며, 중복 focus/visible 원격 확인은 전체 동기화로
  승격하지 않는다. 논리 payload가 원격과 같으면 새 salt로 재암호화하거나 write하지 않는다. 일반 자동 성공은
  toast를 만들지 않고 수동 `지금 동기화`는 유지한다. Service Worker background sync와 완전 종료 뒤 실행은 없다.
- Library의 제품 진입점은 구현 모드명이 아니라 `동기화`를 주 label로 쓴다. 보조 상태는 연결 provider와 자동
  여부를 표시하고, 패널은 기기 간 동기화를 기본으로 노출한다. 항목 선택과 별도 self-host 연결은 disclosure로
  분리해 Dropbox Cloud Vault와 서버 event sync를 같은 기능처럼 보이지 않게 한다.
- 실제 `127.0.0.1:1421`과 `localhost:1422` Web origin이 같은 Dropbox Vault에서 remembered unlock, startup
  sync와 즐겨찾기 변경/복구 round-trip을 통과했다. 이는 물리적 다중 기기 검증을 대신하지 않는다.
- self-host 서버가 연결되지 않은 local-only runtime은 남아 있는 event outbox를 활성 서버 상태로 표시하지
  않는다. outbox는 Cloud Vault capture의 변경 시각과 tombstone 입력으로 로컬에 남지만 Dropbox에 self-host
  event stream으로 전송되지 않으며 UI 대기열에서도 숨긴다.
- AI/TTS 대형 배열은 작품별 암호화 object로 분리됐다. 공용 metadata 자체가 지나치게 커지면 나머지 주석·통계도
  book shard로 나누는 후속 migration을 검토한다.
- 표지 교체와 맞춤/위치 변경은 별도 cover clock을 따라 다른 기기에 적용한다. 표지를 ‘없음’ 상태로 만든 삭제는
  cover tombstone으로 전파하며, 이후 더 최신 표지를 저장하면 tombstone을 제거한다.
- Dropbox 배포에는 제품별 `VITE_DROPBOX_APP_KEY`와 정확한 redirect URI 등록이 필요하다. Web은 배포 origin을,
  Windows desktop은 고정 loopback `http://127.0.0.1:53682/oauth/dropbox`를 등록한다. Desktop은 PKCE verifier와
  random state를 만들고 Rust가 Dropbox authorize URL/redirect/state를 검증한 뒤 OS 기본 브라우저와 loopback
  callback을 중계한다. 인증 code의 token 교환도 Rust HTTP client가 수행하므로 WebView callback/CORS에
  의존하지 않는다. 콜백 대기는 10분이며 완료 시 Moya 창을 다시 활성화한다. App secret은 사용하지 않는다.
- Cloud Vault 전용 key가 없으면 같은 빌드의 `VITE_DROPBOX_SOURCE_APP_KEY`를 재사용할 수 있다. Source와 Vault의
  OAuth credential/state는 계속 별도 저장한다.
- 암호 변경은 기존 Vault를 복호화한 뒤 새 암호로 재암호화하는 명시적 작업으로만 제공한다.
- Web 동기화 폴더는 3권/원본 3개/표지 2개를 실제 저장하고 빈 별도 origin에서 3권과 표지 2개, 238화 EPUB 및
  독서 위치를 복원했다. 실제 Dropbox OAuth 재승인 뒤 암호화 Vault 파일이 App Folder에 생성되는 것까지
  확인했다. source origin에서 원본 scope를 켜고 다시 쓴 뒤 별도 `localhost:1422` 0권 origin이 같은 Dropbox
  Vault에서 원문을 내려받아 작품을 복원하는 actual round-trip도 확인했다. content object 전체 열거와 물리적
  두 기기 round-trip은 아직 운영 증거가 없다. 140 MiB 초과 upload-session은 focused provider test만 통과했다.
- 저장 위치를 바꾸면 이전 provider의 성공 시각/revision/byte 표시를 초기화한다. 성공 기록에는 provider kind를
  함께 저장해 legacy 또는 다른 provider의 시각을 현재 Dropbox 성공으로 오인하지 않는다.
- Google Drive Cloud Vault, 선택 작품만 받는 원격 서재 projection, service-worker background sync, remote object
  정리와 Android Custom Tab/App Link는 후속이다. Windows keyring/system-browser 경계와 실제 Dropbox 재연결,
  앱 재시작 뒤 remembered unlock/자동 복원은 확인했다. token 강제 만료 refresh와 물리적 다중 기기 충돌은 배포 전
  수동 release gate로 남는다. 표시용 계정 이름 조회 실패는 credential 저장과 provider 연결을 취소하지 않는다.
- 작품별 AI/TTS sidecar의 생성·갱신은 동기화하지만, 다른 기기에서 해당 작품의 AI/TTS 결과를 전부 초기화한
  사실을 authoritative하게 전파하는 generation tombstone은 아직 후속 호환성 범위다.

## 2026-08-01 listening-position update

Cloud Vault book records now carry optional `ListeningPosition` independently from visual `ReadingPosition`, and
listening tombstones prevent stale restoration. Reflowable anchors are remapped through chapter/paragraph hashes when
the source book is matched. TTS audio, download jobs, OCR/search indexes and thumbnails remain excluded as reproducible
or device-local cache data.

## 2026-08-01 fixed-document annotation update

Cloud Vault v1 book records may additively carry `documentAnnotations`. Absence means an older valid v1 snapshot, not
corruption. Page bookmarks, fixed-text highlights/notes and fixed-region highlights/notes are captured only when the
annotation scope is enabled. Deletions use book-scoped `document_annotation` tombstones, and merge compares
`deletedAt ?? updatedAt` so a stale record cannot resurrect after another device deleted it.

Apply first matches the source by `normalizedTextHash`, then rewrites both the annotation `bookId` and its anchor
`bookId` to the local novel id. Invalid page indexes or mismatched anchor pages are quarantined. Source PDF/page image,
derived native/OCR text and search indexes, thumbnails, TTS audio and download jobs remain excluded. This checkpoint
covers encrypted Cloud Vault and exact backup only. Hosted event sync is implemented through the separate sync v2
path documented in `large-file-and-sync-architecture.md`; physical Dropbox multi-device evidence remains a release gate.

## 2026-08-01 PDF reading-order override update

Cloud Vault v1 book records may additively carry `documentTextOrderOverrides` under annotation scope. The encrypted
payload stores only page hash, ordered/excluded immutable block fingerprints and timestamps; PDF bytes, OCR/native text
and search indexes stay excluded. Older v1 snapshots without this field remain valid.

Vault ids use normalized source hash plus page index, then apply remaps them to the local book/page id. Latest
`updatedAt` wins. Reset writes a page-aware `document_text_order_override` tombstone, and a later local save clears that
tombstone. Invalid page ranges, empty hashes and unbounded fingerprints are quarantined. Hosted sync v2 now mirrors
these update/reset semantics through a separate event path; physical Dropbox/Hosted multi-device evidence remains open.
