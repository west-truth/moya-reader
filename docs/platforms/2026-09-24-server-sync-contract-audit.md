# D0: 독립 서재 동기화 계약 조사

작성: 2026-09-24. D0 지원표와 D1 첫 구현 범위다. 기존 `/api/sync`는 클라이언트와 서버 사이의 이벤트 계약이며, 아래 D1 실행기가 같은 계약의 독서 위치 이벤트만 서버 사이에서 운반한다.

## 공통 운반 계약

- 서버 `/api/sync/capabilities`는 v1/v2를 광고한다. v2는 `v2-sha256-128` ID와 tagged SHA-256 hash다. `GET /api/sync?since=<cursor>&contractVersion=2&idContract=...&hashContract=...`는 최대 500개 이벤트와 다음 cursor를 반환한다. `POST /api/sync/events`는 동일 계약의 이벤트 배열을 받아 accepted/rejected를 돌려준다.
- `sync_events`의 `sequence`는 **각 서버의 순번**이다. D1에는 `상대 서버 ID + 방향`별 cursor와 마지막 처리 이벤트를 서버 DB에 보존해야 한다. 보내기 성공 전에 cursor를 전진시키지 않는다. 같은 이벤트 ID는 `on conflict (id) do nothing`으로 중복 적용을 막지만, stale/invalid 거절을 성공으로 취급하면 안 된다.
- 기존 `LocalOutboxSyncService`는 브라우저 IndexedDB outbox와 캐시를 사용한다. 이를 데스크톱 서버의 정본이나 백그라운드 서버 간 실행기로 옮겨 쓰지 않는다.
- 앱의 공개 공유 listener는 `Authorization` 헤더를 403으로 막는다. 외부 상대에게 native owner bearer를 보내는 방식은 사용할 수 없다. 공개 gateway에서 사용 가능한 인증은 self-host 계정 로그인 뒤 session cookie다. 서버 간 장기 세션의 보관·갱신·해제 계약이 아직 없다.

## 항목별 지원표

| 항목 | 현재 writer / push·pull | ID·revision 및 중복·충돌 | D1 이후 부족한 부분과 확인 검사 |
| --- | --- | --- | --- |
| 독서 위치 | `routes/books/reader-state-routes.ts`가 쓰고 `reading_position_updated/deleted` 이벤트 생성. push는 `reader-entity-persistence.ts`, pull은 `sync_events`. | 같은 book/chapter ID가 먼저 존재해야 한다. 대상은 `updated_at` 조건으로 오래된 위치를 거절한다. 이벤트 ID 중복은 저장 계층이 제거한다. | D1은 **동일 작품과 회차가 두 서버에 이미 존재하는 fixture**만 다룬다. A→B→A, 동시 변경, 재전송, 재시작 뒤 cursor 검증. 다른 원본에서 우연히 같은 book ID인 경우를 금지한다. |
| 책 추가·원본 | 서버 import가 `book_imported` 이벤트를 생성한다. 기존 브라우저 동기화는 이벤트를 받은 뒤 book snapshot API로 로컬 캐시를 채운다. | push의 `hasExistingBookForEvent`는 일부 이벤트만 기존 책을 요구한다. `book_imported` 이벤트만 보냈다고 대상 서버에 `library_books`/`book_objects`가 생성되는 경로는 확인되지 않았다. | 최초 snapshot, 원본/페이지/자산 전송, 해시 검증, 크기 제한 및 재개 계약 필요. D1 범위 밖. |
| 작품 정보·표지 | catalog/cover route가 `book_updated`를 기록한다. push는 metadata를 적용한다. | `metadata_revision`, `updated_at`과 source/cover 자산 변경 규칙을 함께 봐야 한다. | 표지 binary는 이벤트만으로 오지 않는다. 실제 자산 전송과 동시 수정 충돌 검증 필요. |
| 삭제·휴지통 | catalog route가 `book_trashed/restored/purged`를 기록한다. push에 상태 적용 경로가 있다. | 원본 제거는 되돌릴 수 없으므로 단순 timestamp 승자 정책만으로 허용하지 않는다. | tombstone 보존 기간, 상대 미접속 중 purge, 복원 충돌과 객체 GC 합의가 필요. |
| 북마크·하이라이트·메모 | annotation route가 생성/수정/삭제 이벤트를 쓰고 push가 서버 행에 적용한다. | ID별 시각·soft delete 조건이 있다. 대상 작품/anchor 선행 조건 확인 필요. | 같은 ID 수정 충돌, 원본 revision 교체 시 anchor 재매핑 검사. |
| 문서 주석·텍스트 순서·듣기 위치 | shared sync event type과 push 적용 경로가 있다. | book/revision/page hash 조건을 검증해야 한다. | 해당 서버 REST writer가 모든 변경을 이벤트로 내는지, 서버 백업에도 포함되는지 확인. 누락 시 sync 지원으로 표시하지 않는다. |
| 읽기 설정·책장 | `settings_updated`, `shelf_*` 이벤트와 push 경로가 있다. | 설정은 공유 설정만 merge하며, shelf는 ID/revision과 이름 유일성 제약이 있다. | 서버 간 동일 이름/다른 ID, 기기 전용 설정 제외, 최초 snapshot 검증 필요. |
| AI·TTS 상태 | `ai-tts-sync-persistence.ts`와 일부 AI route/provider job writer가 있다. | 계정 API 키와 생성 자산은 이벤트 payload에 넣지 않는다. revision fence가 있는 결과는 원본 revision을 확인한다. | writer/asset별 지원 목록, 음성 파일 전송, 인증 비밀 보호, stale 결과 정책을 별도 확정. |

## D1의 최소 실행 계약

1. 상대 서버 연결은 계정 session 기반으로 만든다. 로그인 비밀번호나 session cookie를 URL/로그/UI에 노출하지 않는다. 장기 저장은 서버의 기존 암호화 경계에 맞추고 재인증·해제 동작을 명시한다.
2. 동기화 대상 book ID와 source hash, active content revision 및 chapter ID가 양쪽에서 일치하는지 먼저 확인한다. D1에서는 일치하지 않으면 명시적으로 중단한다.
3. 각 방향에서 읽은 최대 500개 이벤트를 검사하고 허용한 종류(`reading_position_updated/deleted`)만 보낸다. 다른 이벤트가 cursor 앞에 섞여 있으면 **그냥 건너뛰고 전체 지원으로 표시하지 않는다**. 종류별 정책을 확정할 때까지 대상 상태를 보존한다.
4. 상대 push의 accepted ID와 rejected reason을 확인한 뒤 방향별 cursor를 transaction으로 저장한다. 장애 후 같은 묶음을 재전송해도 이벤트와 위치가 한 번만 적용되어야 한다.
5. 같은 timestamp의 서로 다른 위치, 오래된 위치, 재연결, 상대 session 만료를 포함한 두 합성 서버 통합 검사를 통과해야 D1 완료다.

## D1 첫 구현 기록

- API 서버가 15초마다 상대를 확인하므로 데스크톱 창을 닫고 서버를 유지해도 실행된다. `sync_server_peers`에 상대 ID·방향별 cursor·상태를 저장하고 계정 session cookie는 기존 서버 비밀 키로 AES-GCM 암호화한다. 비밀번호를 저장하지 않는다. 세션 만료는 `needs_login`, 일시 연결 실패는 `offline`, 미지원 사건·내용 불일치·거절은 `blocked`로 남긴다.
- 인증된 `POST /api/sync/peer`는 `url`, `username`, `password`, `startFromNow: true`를 받는다. **초기 복제는 없으며 연결 시점 이전 이벤트를 명시적으로 제외한다.** 재연결에 같은 옵션을 쓰면 그 사이 처리하지 않은 변경도 제외되므로 사용자가 이 범위를 알고 호출해야 한다. 상대 URL은 HTTPS 또는 같은 기기 loopback HTTP만 허용한다. `GET /api/sync/peer`는 비밀 없이 상태와 cursor를 보여 주고, `POST /api/sync/peer/run`은 즉시 실행, `DELETE /api/sync/peer`는 연결 해제와 가능한 경우 상대 세션 로그아웃을 수행한다. 아직 공통 UI에 동기화 설정은 없다.
- 각 book ID의 원본 hash·활성 revision ID·정규화 hash·회차 ID 순서가 양쪽에서 같을 때만 `reading_position_updated/deleted`를 교환한다. 다른 사건이 앞에 있으면 cursor를 건너뛰지 않고 `blocked`가 된다. 상대가 accepted ID를 모두 반환한 뒤 outbound cursor를 저장한다. inbound 이벤트 적용과 cursor 저장은 한 DB transaction이다. 같은 ID 재전송은 내용이 같을 때만 성공한다. 같은 timestamp의 다른 독서 위치는 거부해 기존 위치를 보존한다.
- 서로 다른 기본 사용자 ID(`user_desktop`/`user_dev`)를 둔 두 독립 PostgreSQL DB/실제 HTTP 서버 통합 검사에서 A→B, 상대 서버 일시 중단·동일 주소 재시작 뒤 재연결, API 서버 재시작 후 B→A, 삭제 이벤트, 중복 재전송, 같은 시각 충돌, 미지원 북마크 앞에서 cursor 보존, session 삭제 후 재로그인을 확인했다. 기존 sync route 32개 회귀 검사와 서버 production build도 통과했다.
- **아직 없는 기능:** 최초 작품/원본/자산과 기존 읽던 위치 snapshot, 서로 다른 작품 ID·revision 매핑, 주석·메타데이터·삭제·AI/TTS 동기화, 충돌 해결 UI, 일반 사용자 연결 UI, 비 loopback HTTP 사설망 연결, 실제 다른 기기 사용 검증. `서버 서재 열기`를 오프라인 복제와 동일하게 표시하지 않는다.

D1 이후에는 작품·원본 snapshot/자산, 삭제, 주석/메타데이터, 오프라인 변경 순으로 계약을 넓힌다.
