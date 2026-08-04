# Cloud Vault 동기화 아키텍처

Status: v1 implemented; live provider verification pending
Last updated: 2026-08-01

## 목적

Cloud Vault는 모야 서버를 운영하지 않는 사용자도 여러 기기에서 독서 상태를 옮길 수 있게 하는 선택 기능이다. 클라우드 사업자는 암호화된 단일 Vault 파일만 보관하며, 모야가 가져온 소설 원문을 업로드하는 기능은 제공하지 않는다.

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

의도적으로 제외하는 데이터:

- 소설 원문, 정규화 본문, 문단 텍스트
- EPUB 이미지 등 원본 asset과 TTS 오디오 바이너리
- API key, OAuth access token 평문, provider job/lease, 임시 캐시와 로그

TTS 오디오는 파일 크기, 만료 정책, 부분 업로드와 중복 제거가 별도 설계를 요구하므로 v1에서 항상 제외한다.

## 저장 형식과 암호화

논리 포맷은 `noveldesk-cloud-vault` version 1이고 클라우드에는 `noveldesk-vault-v1.enc.json` 한 파일로 저장한다.

1. 현재 IndexedDB 상태를 `CloudVaultSnapshotV1`으로 캡처한다.
2. 로컬과 원격 snapshot을 항목 단위로 병합한다.
3. JSON payload를 사용자 암호로 PBKDF2-SHA-256(310,000회) 키 유도 후 AES-256-GCM으로 암호화한다.
4. provider는 암호문과 revision만 읽고 쓴다.

암호는 세션 메모리에만 둔다. Dropbox refresh token은 동일한 사용자 암호로 별도 봉인해 로컬 전용 Cloud Vault 설정 DB에 저장한다. 암호를 잊으면 원격 Vault를 복구할 수 없으므로 UI에서 이 제약을 명확히 알린다.

## 작품 재연결

원문이 Vault에 없기 때문에 다른 기기에서는 사용자가 같은 파일을 먼저 가져와야 한다. 연결은 표시 제목이나 로컬 ID가 아니라 `normalizedTextHash`로 수행한다.

- 작품: `normalizedTextHash` 완전 일치
- 챕터: `index + textHash` 완전 일치
- 문단 anchor: `paragraphIndex + textHash` 완전 일치

같은 원문이 아직 없으면 해당 작품의 원격 기록은 삭제하지 않고 `waiting for source` 상태로 보존한다. 작품은 일치하지만 chapter/paragraph anchor가 불일치하는 레코드는 잘못된 위치에 적용하지 않고 격리 건수로 보고한다.

같은 본문을 다른 파일명으로 가져오면 local book/chapter/paragraph ID가 달라질 수 있다. 병합 파일은 각 기기의 content-addressed anchor reference를 함께 보존하며, 서재 membership은 local book ID가 아니라 `shelfId + normalizedTextHash` 기반 Vault ID를 사용한다.

## 병합과 충돌 규칙

- 진행 위치와 메타데이터: `updatedAt`이 최신인 값
- 북마크/하이라이트/메모/독서 세션: 안정적인 entity ID 기준 합집합 후 최신 revision
- AI/TTS 산출물: 일반 산출물보다 사용자 확정 캐릭터, 사용자 보정 segment, 사용자 선택 음성을 우선
- 삭제: tombstone이 대상 레코드보다 같거나 최신일 때만 삭제
- 동기화 범위: 현재 기기에서 사용자가 선택한 scope가 적용 동작의 기준
- 원격 write: provider revision을 이용한 compare-and-swap, 충돌 시 최신 원격을 다시 읽고 제한 횟수 재병합

Vault의 원격 데이터는 사용자가 현재 scope를 껐다는 이유로 즉시 파기하지 않는다. 다만 꺼진 범주의 데이터를 로컬에 적용하거나 새로 캡처하지 않는다.

## Provider 경계

`CloudVaultFileProvider`는 다음 두 동작만 노출한다.

- `read(): bytes + revision`
- `write(bytes, expectedRevision): revision`

현재 구현 provider:

- 로컬 동기화 폴더: File System Access API의 사용자 선택 directory handle. Syncthing, Dropbox desktop, OneDrive 등 사용자가 운영하는 동기화 폴더와 조합할 수 있다.
- Dropbox App Folder: PKCE OAuth 후 앱 전용 경로에 암호화 파일을 저장한다. 브라우저 bundle에는 app key만 두며 app secret은 두지 않는다.

Google Drive, WebDAV, S3 호환 저장소는 동일 경계 위에 후속 provider로 추가할 수 있다. provider별 UI와 인증은 platform adapter에 머물고, snapshot/merge/crypto 코드는 공유한다.

## 구현 위치

- 계약과 포맷: `src/cloud-vault/contracts.ts`
- 암호화: `src/cloud-vault/crypto.ts`
- 충돌 병합: `src/cloud-vault/merge.ts`
- IndexedDB 캡처/재연결: `src/cloud-vault/indexeddb-artifact-repository.ts`
- provider: `src/cloud-vault/directory-provider.ts`, `src/cloud-vault/dropbox-provider.ts`
- OAuth: `src/cloud-vault/dropbox-oauth.ts`
- orchestration: `src/cloud-vault/service.ts`
- 로컬 연결 정보: `src/cloud-vault/local-state.ts`

## 운영상 남은 경계

- v1은 수동 동기화를 기본으로 한다. 자동 동기화는 앱 시작/종료와 mutation debounce 정책을 정한 뒤 추가한다.
- 단일 암호문 파일이 지나치게 커지면 manifest와 book shard로 나누는 v2 migration을 검토한다.
- Dropbox 배포에는 제품별 `VITE_DROPBOX_APP_KEY`와 정확한 redirect URI 등록이 필요하다.
- 암호 변경은 기존 Vault를 복호화한 뒤 새 암호로 재암호화하는 명시적 작업으로만 제공한다.

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
