# 내장 self-host 데스크톱: 남은 전체 작업과 워커 실행 계획

작성: 2026-09-24. 코드 대조 기준: `96bf0e7` (`feat/desktop-embedded-selfhost`).

**이 문서는 남은 작업의 최신 실행 기준이다.** [전체 제품 계획](2026-09-23-desktop-embedded-selfhost-plan.md)의 목표를 유지하고, [이전 인계](2026-09-24-desktop-next-work-handoff.md)의 미완료 항목을 구체화한다. 이전 문서의 날짜별 기록은 당시 증거이며 새 작업 목록으로 다시 실행하지 않는다.

사용자 요청에 따라 **물리적으로 다른 PC·휴대폰에서 접속·동기화하는 검증은 이번 범위에서 제외한다.** 같은 PC의 독립 DB/서버, 별도 브라우저, Windows CI, 깨끗한 Windows VM 검사는 포함한다. 제외한 검사를 통과했다고 기록하지 않는다.

## 1. 목표와 현재 위치

목표는 Docker 없이 설치·실행하고, 기존 self-host와 같은 기능을 사용하며, 필요하면 외부 접속과 독립 서재 동기화를 제공하는 앱이다.

고정 구조: **공통 웹 UI → 기존 self-host API/worker → PostgreSQL·Redis·서버 파일**. 데스크톱은 실행·종료·창·트레이·OS 입출력을 관리한다. 저장소·수집기·백업·파서를 다시 만들지 않는다.

### 완료된 기반 — 그대로 활용

- 내장 서버 실행·종료·트레이 유지·재시작, 프로필 잠금과 소유 프로세스 확인 후 복구.
- Quick Tunnel 기본 선택, LAN/Tailscale 직접 주소와 고정 터널 선택, 공통 QR·계정 로그인·공유 해제.
- 공통 리더·검색·북마크·PDF 주석, 서버 백업·복원, 기본 로컬 ZIP 이전, 수집기·Chromium 동봉.
- 가져오기 등의 공통 숫자 진행률. 총량 미확정 단계는 단계/바이트 표시.
- 빈 서재 최초 복제, 독서 위치 교환, 새 작품 콘텐츠 전달, 세션 만료 재로그인과 cursor 보존.
- `48b62c5`의 [Windows 실행 35963132505](https://github.com/west-truth/moya-reader/actions/runs/35963132505)에서 작은 TXT 신규 전달과 복구·앱 회귀 통과. 최신 증거를 읽고 같은 기반을 재구현하지 않는다.

### 현재 사용 시 걸리는 제한

1. 동기화 실행기는 `book_imported`, `reading_position_updated/deleted`만 허용한다. **설정·주석 등 미지원 변경 하나로도 동기화가 중단될 수 있다.** 현재 상태를 일반적인 전체 서재 동기화로 안내하면 안 된다.
2. 작품 전송은 initial revision만 지원한다. 기존 작품 원본 교체·회차 추가, 연결 후 여러 차례 바뀐 작품은 후속 계약이 필요하다.
3. 최초 복제는 빈 대상 서재에만 가능하다. 전송 중 원본 서버의 변경이 감지되면 재시도해야 한다.
4. 최초 복제 ZIP에는 전체 길이가 없어 실제 화면은 바이트/단계만 보인다. **최초 복제의 숫자 %는 아직 제공되지 않는다.**
5. 재로그인은 저장된 상대 주소만 사용한다. Quick Tunnel 주소 변경을 기존 연결·cursor를 유지하며 처리하는 UI/API는 없다. 서버 간 연결은 HTTPS 또는 loopback HTTP만 허용한다.
6. 기존 로컬 ZIP은 일부 필드·저장소가 있으면 안전하게 거부한다. 모든 과거 자료의 이전이 끝난 상태가 아니다.

## 2. 남은 작업 전체

| ID  | 결과                                                      | 성격                    | 선행 조건                     |
| --- | --------------------------------------------------------- | ----------------------- | ----------------------------- |
| W01 | 동기화 기능 협상·변경 기록·충돌 기록의 공통 계약          | 동기화 구현 기반        | 없음                          |
| W02 | 기존 작품 원본 교체·회차 추가와 모든 현재 지원 포맷 전달  | 기능 구현, 기존 D2b     | W01                           |
| W03 | 북마크·하이라이트·메모·문서 주석·듣기 상태 교환           | 기능 구현               | W01, 원본 변경 검사는 W02     |
| W04 | 작품 정보·표지·책장·공유 설정·사용자 폰트 교환            | 기능 구현               | W01, 콘텐츠는 W02 재사용      |
| W05 | 휴지통·복원·영구 삭제와 사용자가 해결 가능한 충돌         | 기능 구현               | W01~W04                       |
| W06 | 기존 AI/TTS 사용자 자료의 보존·동기화 범위 완성           | 계약별 누락 구현        | W02~W05                       |
| W07 | 안정적인 최초 복제·대용량 전송·숫자 진행률·중단 후 재시도 | 기능 보완 + 검증        | W01, 최종 전송 검사는 W02~W06 |
| W08 | 주소 변경·재연결·기존 서재 연결·접속 모드와 웹 호환       | 기능 보완 + 검증        | W01, 최종 회귀는 W05/W07      |
| W09 | 실제 배포된 로컬 자료의 직접 이전과 실패 복구             | 기존 변환기 확장 + 검증 | W02/W03의 anchor 규칙 재사용  |
| W10 | 작업 도중 종료·저장 공간 부족·절전/연결 복구              | 검증, 재현 결함 수정    | 관련 기능 구현 후             |
| W11 | 최종 설치본·업데이트·재배포 자료와 릴리즈 증거            | 배포 보완 + 검증        | 최종 코드, W10                |
| W12 | 계정·키·고정 도메인이 필요한 실제 연동 확인               | 환경 의존 검증          | 필요한 자격 증명/환경         |

W01부터 W08까지는 **독립 사본을 동기화하는 기능**을 마치는 일이다. W09부터 W11까지는 **기존 자료를 안전하게 옮기고 앱을 배포하는 일**이다. 모든 항목을 새 엔진 개발로 취급하지 않는다. 이미 있는 기능은 필요한 경계와 검사만 보완한다.

## 3. 워커 공통 실행 규칙

### 작업 위치와 시작

```text
worktree: /home/koho5155/Docker_Services/.worktrees/moya-desktop-selfhost
branch: feat/desktop-embedded-selfhost
baseline: 96bf0e7 (비교 기준이며 reset 대상이 아님)
```

시작 시 `git status --short`, `git log -5 --oneline`을 확인한다. 다른 변경을 보존한다. 본 문서 → 맡은 단위가 참조한 조사 기록 → 관련 구현/검사 순서로 읽는다. 보관 IndexedDB 브랜치를 통째로 merge/cherry-pick하지 않는다.

### 공통 불변 조건

- DB 변경과 해당 sync event는 같은 transaction으로 기록한다. 실패 주입으로 확인한다. 이미 원자적인 writer를 다시 작성하지 않는다.
- 실제 event ID·payload가 같은 재전송만 중복 성공이다. 같은 ID의 다른 내용은 거부한다. 서버 중계 과정에서 원래 사건을 새 사건으로 계속 재생성하지 않는다.
- 데이터 적용 또는 명시적으로 기록한 충돌 해결 없이 cursor를 건너뛰지 않는다. inbound 적용과 cursor 전진은 같은 commit, outbound는 상대의 영속 적용 확인 뒤 전진한다.
- `pull-query.ts`의 commit 순서 보호, 독서 위치의 별도 advisory lock, 초기 복제 대기 상태, 재로그인 후 cursor 보존을 유지한다.
- 원본/anchor가 불일치하면 자료를 보존하고 충돌을 남긴다. 전체 항목을 timestamp 하나로 덮어쓰지 않는다.
- 객체는 스트리밍→길이/해시 확인→참조 commit 순서다. 실패 정리는 이번 작업 소유의 미참조 객체에 한정한다. 기존 백업의 reservation/GC 경계를 재사용한다.
- 공통 push/pull 규칙은 웹 클라이언트와 서버 실행기가 공유한다. peer route 안에 별도의 데이터 병합 규칙을 복제하지 않는다.
- 각 단위는 관련 검사 → 작은 실제 DB/HTTP 사용 흐름 → 필요한 Windows 검사 순서로 진행한다. 문서/플랫폼 무관 변경마다 installer나 529MiB 검사를 돌리지 않는다.
- 각 단위 종료 시 본 문서의 상태표에 commit, 실행 명령/결과, 미검증 조건, 다음 작업을 남긴다. 환경 부족으로 skip된 통합 검사를 성공이라고 쓰지 않는다.

## 4. W01 — 공통 동기화 계약과 변경 기록

**목표:** 미지원 기능을 미리 구분하고, 후속 변경의 공통 기준과 충돌을 영속적으로 기록한다. 이 단위만으로 전체 동기화 완료라고 표시하지 않는다.

**수정 출발점:**

- `packages/contracts/src/sync.ts`, `src/sync/contract.ts`, `src/sync/event-contract-validation.ts`
- `apps/server/src/routes/sync/{capabilities-route,push-route,event-contracts,revision-conflict-policy,sync-event-persistence}.ts`
- `apps/server/src/routes/books/{sync-event-repository,reader-state-routes}.ts`
- `apps/server/src/routes/sync/peer-reading-position-routes.ts`, `apps/server/src/db/migrations/`
- [기존 계약 조사](2026-09-24-server-sync-contract-audit.md)

**구현 순서:**

1. 기존 v1/v2 ID/hash 계약을 보존하면서 capabilities에 구현된 peer 기능을 식별하는 선택 필드를 추가한다. 단순히 v2라는 이유로 원본 교체·주석을 지원한다고 가정하지 않는다. 구버전은 기존 범위만 협상하며 기능 부족 이유를 UI에 전달한다.
2. 지원 확대할 항목별로 `REST/worker writer → event → push → pull → snapshot/asset` 표를 갱신한다. W03/W04/W06에서 맡은 항목의 누락을 실제로 고친다. `SUPPORTED_TYPES`만 늘리지 않는다.
3. 변경 충돌 기준은 기존 content revision/metadata revision/엔티티 버전부터 재사용한다. 독립 서버의 같은 숫자 revision은 같은 내용을 증명하지 못하므로, 항목별 기준 revision 또는 canonical payload hash와 목표 hash를 함께 비교한다. 시각은 표시/기존 호환 규칙에 사용한다.
4. 필요한 최소 DB 기록을 추가 migration으로 만든다: 상대/항목별 마지막으로 확인한 기준, 해결되지 않은 충돌의 event ID·항목·양쪽 버전/내용 참조·상태·해결 ID. 대용량 원본은 참조만 저장한다. 세션·비밀번호는 충돌 payload에 저장하지 않는다. 테이블명은 기존 스키마 중복을 확인한 뒤 확정한다.
5. 충돌은 우선 해당 방향의 cursor를 멈추고 영속 기록한다. 자동 skip이나 범용 분산 병합 프레임워크를 만들지 않는다. 사용자가 해결하는 API/UI는 W05에서 완성한다.
6. 신규 payload를 만들 때 기존 ID/hash 생성·검증·계약 변환 함수를 함께 사용한다. 저장된 과거 사건을 제자리 수정하지 않는다. 기준이 없는 구버전 사건은 증명 가능한 동일 상태만 중복으로 처리하고, 위험한 덮어쓰기는 차단한다.
7. 거절 이유를 `재시도 가능`, `재로그인 필요`, `기능/버전 미지원`, `해결할 충돌`, `손상된 전송`으로 구분한다. 일시 busy/timeout은 cursor를 유지하고 재시도하며, 확정 충돌을 자동 재시도로 계속 덮어쓰지 않는다. capabilities는 해당 단위의 실제 적용 경로와 검사가 완료된 경우에만 활성화한다.

**완료 검사:** 구/신 capabilities 조합, 변조된 payload, 같은 event ID 재전송/다른 내용, writer 실패 rollback, 재시작 후 충돌 기록 유지. `sync-contract-matrix.test.ts`, `sync.test.ts`, `peer-reading-position.integration.test.ts`를 필요한 범위에서 확장한다.

## 5. W02 — 원본 교체·회차 추가·포맷별 콘텐츠

**목표:** 연결 후 기존 작품에 회차를 추가하거나 원본을 바꾸면 상대에 반영되고, 상대의 독서 상태·주석은 보존된다.

**수정 출발점:** `apps/server/src/services/` 아래의 `import-service.ts`, `import-expected-base.ts`, `local-archive-append.ts`, `document-series-snapshot.ts`, `book-revision/{service,contracts,repository,source-anchor-repository,remap-repository}.ts`, `peer-book-content.ts`, `hosted-backup-service.ts`와 `apps/server/src/routes/sync/peer-book-content-routes.ts`. [D2a 기록과 D2b 조사](2026-09-24-peer-book-transfer-plan.md)를 먼저 읽는다.

### W02a. 한 번의 원본 교체

1. import/append commit에서 이전 revision과 새 revision·원본 hash·정규화 hash를 event의 콘텐츠 정보로 기록한다. 현재 `{bookId}`만 있는 `book_imported`는 이전 기준을 증명하지 못한다. 원본 교체와 같은 transaction에서 생성하고 기존 웹 소비자 호환을 유지한다.
2. 콘텐츠 응답은 특정 target revision을 가리키게 한다. 요청 후 source가 바뀌면 다른 revision 바이트를 섞어 보내지 않는다. 전송 descriptor에는 최소 book ID, base/target revision, source/asset hash·길이, 포맷, 필요한 회차/페이지 식별 정보를 넣고 archive와 대조한다.
3. 상대 상태가 target과 같으면 중복 성공, 상대가 base와 같으면 교체, 둘 다 아니면 충돌이다. 객체를 내려받는 동안 상대가 바뀔 수 있으므로 **수신 DB transaction 안에서 다시 비교**한다.
4. 기존 `prepareBookReplacement` → 콘텐츠 행 갱신 → `restoreExactAnchoredReaderState` → `finalizeBookReplacement` 경계를 재사용한다. `restoreHostedBackup(...replace)`로 작품을 삭제하고 다시 넣지 않는다. 공통으로 필요한 코드만 추출한다.
5. 현재 exact-anchor 복원은 특정 append 경로에서 호출된다. TXT/EPUB 교체에서도 보존 가능한 위치·주석을 복원하도록 조건을 검토한다. 매핑 실패 자료는 기존 quarantine에 남기고 W05 UI에서 확인/내보내기 가능하게 한다. 임의의 다른 문단에 붙이지 않는다.
6. archive가 실어 나르는 콘텐츠와 대상 서버가 가진 사용자 설정/주석을 분리한다. 새 원본 수신으로 제목·즐겨찾기·설정까지 되돌리지 않는다. 별도 metadata 사건은 W04에서 처리한다.
7. 기존 exporter는 현재 catalog의 source object를 중심으로 수집한다. revision/복합 source가 참조하는 모든 필요한 객체와 GC 참조를 점검하고 누락된 참조를 고친다. 과거 revision 행만 넣고 원본을 누락시키지 않는다.

**완료 검사:** 실제 두 DB에서 A의 원본 교체→B 반영, B의 위치·메모 보존, 같은 교체 재전송, 다운로드 도중 B 수정, 양쪽 동시 원본 교체, 객체 누락/해시 오류/commit 직전 실패. 기존 `book-revision/reader-state-restore.integration.test.ts`와 `book-revision.integration.test.ts`를 재사용한다.

### W02b. 오프라인 동안 여러 번 변경된 작품

1. A가 r1→r2→r3으로 바뀌고 B는 r1인 경우를 첫 fixture로 삼는다. 현재 exporter에서 과거 r2를 항상 재생할 수 있다고 가정하지 않는다.
2. 기본 방향은 기존 `book_replacement_runs`의 from/to 연결과 revision 참조로 공통 기준을 확인하고, 검증된 현재 revision snapshot으로 따라잡는 것이다. 수신자는 로컬 revision이 증명된 조상인 경우에만 적용한다. 관련 콘텐츠 사건을 대체했다고 기록하는 checkpoint/receipt를 두고 양쪽 확인 후 처리한다.
3. 이때 사이에 있는 주석·삭제·설정 사건은 건너뛰지 않는다. 콘텐츠 변경으로 오래된 anchor가 된 사건은 W03의 재매핑/충돌 보존 경로로 처리한다. 단순히 최신 cursor로 이동하는 구현은 금지한다.
4. 원격 목표 revision 번호/ID를 적용할 때 현재 `local revision + 1` 규칙과 충돌하지 않도록 검증된 fast-forward 입력을 공통 교체 서비스에 제한적으로 추가한다. DB 불변 조건과 기존 local import 규칙은 유지한다.
5. 관계를 증명할 과거 기록/객체가 없으면 재조정 필요 상태와 보존 가능한 자료를 안내한다. 영구 차단을 지우려고 기준 revision을 조작하지 않는다. 일반적인 여러 번의 오프라인 변경은 정상 복구되어야 완료다.

### W02c. TXT 외 포맷과 회차 추가

- EPUB, PDF, CBZ/이미지 작품, 기존 append 모드별 신규 전달·원본 변경을 작은 fixture로 검사한다. `bookIdentity`의 `chapterIds.length > 0` 조건이 모든 포맷에 유효한지 확인하고 문서 page/section identity를 공통 계약에 반영한다.
- 표지·EPUB resource·문서 page·`source_part`·원본 다운로드의 참조와 실제 바이트를 확인한다. parser를 다시 만들지 않는다.
- 포맷마다 신규 추가→읽기→회차 추가 또는 교체→재시작→원본 해시 확인을 통과해야 해당 포맷을 지원표에 올린다.

## 6. W03 — 주석·독서/듣기 상태

**수정 출발점:** `apps/server/src/routes/books/{annotation-routes,document-annotation-routes,document-text-routes,reader-state-routes}.ts`, `routes/sync/{reader-entity-persistence,revision-conflict-policy,event-contracts}.ts`, 기존 Remote repositories와 공통 주석 UI.

1. 북마크/하이라이트/메모 생성·수정·삭제, 문서 주석·텍스트 순서 수정, 듣기 위치를 항목별로 켠다. 실제 writer가 event를 같은 transaction에서 기록하는지 확인한다. listening/document event type이 존재하는 것만으로 writer까지 완성됐다고 판단하지 않는다.
2. 신규 payload에 content revision, 필요한 chapter/paragraph 또는 page hash/text revision을 포함해 W02 이후의 오래된 변경을 판별한다. 구버전 사건은 기존 검증 규칙을 보존하되 안전하게 적용할 수 없는 경우 충돌로 보존한다.
3. 서로 다른 주석 ID는 함께 보존한다. 같은 ID의 같은 버전/내용은 중복 성공, 같은 기준에서 갈라진 수정·삭제는 W05로 넘긴다. 과거 수정이 새 삭제를 되살리지 않도록 tombstone과 row lock을 검사한다.
4. 최신 원본에 정확히 대응되는 anchor만 자동 복원한다. 실패한 위치/주석을 삭제하지 말고 원래 내용·기준 원본을 보존한다.
5. PDF/이미지 만화 프로필, 발화 텍스트 규칙, 독서 기록 등 실제 사용자 소유 상태도 목록에 넣는다. 기존 event가 없는 항목은 W01의 표에 누락을 적고 같은 공통 계약으로 추가한다. 기기 캐시·재생성 가능한 파생 인덱스는 동기화 대상에서 제외한 이유를 명시한다.

**완료 검사:** 양방향 추가/수정/삭제, 동일 항목 동시 수정, 시계가 어긋난 두 서버, 원본 교체와 주석 수정의 교차, 삭제 후 늦게 도착한 수정, 재전송/재시작. 실제 서버 API로 작성한 데이터를 사용한다. SQL fixture만으로 writer 검증을 대신하지 않는다.

## 7. W04 — 작품 정보·표지·책장·설정·폰트

**수정 출발점:** `apps/server/src/routes/books/{catalog-routes,library-management-routes,personalization-routes,reader-state-routes}.ts`, 공통 자산 경로, `routes/sync/reader-entity-persistence.ts`, `src/features/reader-settings/`와 공유 설정 필터.

1. 제목·작가·설명·즐겨찾기 등 실제 catalog writer별 metadata event를 확인한다. 동일 기준에서 서로 다른 필드를 바꾼 경우에만 필드별 병합하고 같은 필드의 서로 다른 변경은 충돌로 보존한다. 기준 값이 없으면 임의 병합하지 않는다.
2. 표지/사용자 폰트는 binary를 먼저 검증·저장하고 metadata 참조를 commit한다. W02의 기존 객체 전송을 활용한다. 로컬 storage key나 브라우저 blob URL을 상대에 복사하지 않는다. 새 표지 실패 시 이전 표지를 유지한다.
3. 책장 생성/이름·순서 수정/삭제/소속 추가·제거를 지원한다. 같은 이름·다른 ID, 동시 이름 변경, 소속 추가/제거 교차를 명시적 충돌로 다룬다. 작품·책장보다 소속 event가 먼저 도착하면 선행 자료를 확보한 뒤 적용한다.
4. 설정은 기존 공유 가능 필드만 전달한다. 기기 주소·peer 세션·공급자 키·다운로드 경로·창 배치 등 기기/비밀 설정은 포함하지 않는다. `reader-state-routes.ts`의 설정 저장은 현재 DB write와 event가 별도 호출이므로 transaction으로 묶는다.
5. 서로 다른 설정 키 수정은 기준 snapshot/필드 버전으로 병합한다. 같은 키 충돌은 W05 선택 대상이다. 초기 복제 중 저장한 대상 설정 보존(`48b62c5`)을 유지하고, 이후 일반 설정 동기화와 연결한다.

**완료 검사:** 각 항목 왕복, 표지/폰트 실제 bytes/hash, 동일 이름 책장 충돌, 설정 키 동시 수정, 설정 event 실패 rollback, 비밀/기기 필드 미포함. 설정 저장만으로 peer가 `unsupported`가 되지 않아야 한다.

## 8. W05 — 삭제·충돌 해결

**수정 출발점:** catalog/library-management writer, sync conflict policy/persistence, W01 DB 기록, `ServerPeerSyncSettings.tsx`, 기존 백업 inspection/copy와 quarantine 코드.

1. 휴지통 이동·복원·영구 삭제를 구분한다. 삭제 tombstone에는 작품 ID·기준 revision·원래 event ID를 보존한다. 작품 행/객체가 없어져도 늦은 추가/수정 사건을 판별할 수 있어야 한다.
2. 기본 정책: 한쪽만 바꾼 휴지통/복원은 전달, 상대가 기준 이후 수정했으면 충돌. 영구 삭제는 상대의 미동기화 수정본을 자동 제거하지 않고 충돌로 보존한다. tombstone은 첫 구현에서 기간만으로 자동 만료시키지 않는다. 수동 연결 해제와 GC 조건을 명시한다.
3. 실제 객체 삭제는 기존 GC/reservation과 content revision·백업/전송·미해결 충돌 참조를 검사한 뒤 실행한다. peer에서 `book_purged` 수신 즉시 파일을 지우는 경로로 넓히지 않는다.
4. 공통 화면에서 충돌 작품/항목, 양쪽 변경, 실패 이유를 보여 준다. 선택은 해당 항목에 맞게 `이쪽 변경 사용`, `상대 변경 사용`, `둘 다 보관`을 제공한다. 원본/주석은 선택 전에 어느 쪽 자료를 보존할지 명확히 보여 준다.
5. 해결 API 입력은 conflict ID, 양쪽의 기대 버전/hash, 선택, idempotency key다. 적용 직전 다시 검증하고 그 사이 변경됐으면 409와 최신 비교를 돌려준다. 적용·해결 receipt·필요한 새 event를 transaction으로 기록한다.
6. `둘 다 보관`은 기존 copy ID 재매핑 경로를 재사용해 별도 작품/주석으로 만든다. 임의 ID 치환으로 참조를 깨뜨리지 않는다. 미해결 anchor는 조회/내보내기·재연결할 수 있게 한다.
7. 해결이 상대에 전달되고 원래 차단 event가 receipt에 의해 명시적으로 처리된 뒤 cursor를 진행한다. `blocked`를 `ready`로 바꾸는 것만으로 해결 처리하지 않는다.

**완료 검사:** 삭제↔수정, 삭제↔복원, 오프라인 상대의 과거 수정, 해결 클릭 중 재수정, 해결 응답 유실/재시도/재시작, 양쪽 원본 보관, GC가 현재·충돌 원본을 삭제하지 않는지 확인. UI 선택→양쪽 수렴까지 작은 통합 흐름을 포함한다.

## 9. W06 — AI/TTS 등 기존 사용자 자료

**수정 출발점:** `apps/server/src/routes/sync/ai-tts-sync-persistence.ts`, `routes/ai/`, `services/provider-jobs/`, `services/book-revision/`, `hosted-backup-archive.ts`의 테이블 목록, 공통 AI/TTS contracts.

1. 기존 캐릭터/관계·확정 라벨·사용자 교정·음성 프로필/배정·발화 규칙을 `사용자 수정`, `재생성 가능한 결과`, `기기/계정 비밀`로 매핑한다. 기존 타입의 이름만 보고 지원을 선언하지 않는다.
2. 사용자 수정은 writer/event/apply/backup의 누락을 보완한다. content/graph revision과 workflow fence가 맞을 때만 적용한다. 원본 교체 후 과거 분석이 새 결과를 덮지 않아야 한다.
3. 생성 음성/자산은 실제 저장 정책을 확인한다. 영구 사용자 자료라면 객체 전송과 참조를 포함한다. 기존 정책상 재생성 캐시라면 복제 대신 cache miss 처리하고, 다른 서버에서 유료 생성을 자동 시작하지 않는다.
4. 실행 중 job·provider lease·API 키·사이트 세션은 서재 동기화로 복사하지 않는다. 대상 서버에서 필요한 공급자 연결을 안내한다. 사용자 설정과 실행 자격 증명을 구분한다.
5. 배포된 사용자 자료에 대응하지 못한 항목은 지원표에 구체적으로 남긴다. 재생성 캐시 제외를 핑계로 사용자 확정/교정 자료를 버리지 않는다.

**완료 검사:** 키 없는 fake provider/고정 fixture로 양방향 사용자 수정, 원본 revision 불일치, 중복 실행 방지, 비밀 미포함, 필요한 음성 자산 또는 cache miss 동작. 실제 공급자 호출은 W12다.

## 10. W07 — 최초 복제·대용량·숫자 진행률

**수정 출발점:** `services/{hosted-backup-service,hosted-backup-archive,backup-staging,backup-streams}.ts`, `routes/backups.ts`, peer routes, `ServerPeerSyncSettings.tsx`, `TaskProgressRing`, 기존 작업 상태/polling.

### W07a. snapshot과 초기 복제 상태

1. 현재의 복제 전후 watermark 비교는 자료가 바뀌면 전체 재시도를 요구한다. exporter가 **동일한 DB snapshot에서 읽은 자료와 대응 watermark**를 돌려주도록 보완한다. 기존 event commit 순서 보호와 객체 참조 보존을 함께 적용한다. 다운로드 내내 전역 write lock을 잡지 않는다.
2. snapshot 이후 변경은 일반 event로 이어받는다. export 준비/전송 사이 발생한 신규 작품·설정·주석이 누락되지 않는지 확인한다. snapshot과 cursor를 별개의 무관한 SELECT 결과로 묶지 않는다.
3. 대상의 빈 서재·초기 상태 기준을 restore commit 직전 다시 확인한다. 복제 시작 전뿐 아니라 전송 중 대상 설정이 저장되는 경우도 보존하거나 명시적으로 재시도시킨다. 원본·설정이 조용히 덮이는 성공은 금지한다.
4. 중단 상태/작업 ID는 서버에서 복구 가능해야 한다. 브라우저 재접속은 진행 상태를 다시 구독한다. 요청 연결 종료·취소·서버 종료의 의미를 구분해 UI를 닫았다는 이유만으로 완료 작업을 잃지 않게 한다.

### W07b. 확정 총량과 퍼센트

1. 기본 구현은 기존 ZIP exporter를 **서버 임시 파일로 스트리밍 준비**하고, 준비된 파일의 길이·hash·snapshot ID를 가진 인증된 전송 세션으로 제공한다. 기존 backup ticket/staging/reservation을 확장한다. 메모리에 전체 ZIP을 모으거나 별도 백업 포맷을 만들지 않는다.
2. 준비 중에는 `복제 준비 중`; 전송 중에는 `확인된 수신 bytes / 전체 archive bytes`의 **실제 숫자 %**와 바이트를 표시한다. 검증·DB 반영은 별도 단계로 보여 주고, 전송 100%를 전체 작업 완료라고 쓰지 않는다. 단계가 바뀌면 이전 퍼센트를 초기화한다.
3. 동일 snapshot/hash의 임시 archive가 유지되는 동안 Range/offset 재수신을 지원한다. 중단 offset·길이를 재검증하고 최종 hash 확인 뒤 복원한다. snapshot 만료/변경 시 부분 파일을 섞지 않고 새 전송을 시작한다.
4. 전송 세션은 인증 사용자·peer·프로필에 묶고 만료/취소 시 이번 작업의 파일만 정리한다. 준비 파일+수신 staging의 추가 디스크 비용을 실제 측정한다. ENOSPC에서 기존 서재는 보존한다.
5. 신규 작품/교체 전송도 같은 단계·byte 진행 상태를 공통 UI에 노출한다. DB commit 뒤에만 완료 표시한다.

### W07c. 완료 검사

- 작은 파일로 source 변경 중 bootstrap, target 설정 변경, 중간 연결 종료/서버 재시작, 전송 재개, session 만료, hash 오류, 취소 후 재시도, 만료된 snapshot을 먼저 검사한다.
- 이후 기존 529MiB fixture 또는 같은 목적의 1건을 사용해 **최초 복제와 이후 작품 전달/백업 복원** 중 아직 확인되지 않은 큰 파일 경계를 검증한다. 같은 fixture를 재사용하고 목적 없이 포맷별 대용량 조합을 늘리지 않는다.
- 입력/전송 바이트, 소요 시간, 메모리 표본의 대상 PID 범위, 최고 임시 공간, 잔여 파일, 수신 원본 hash를 기록한다. 이미 있는 Linux 대용량 가져오기 성공을 Windows 복제 성공으로 바꿔 쓰지 않는다.
- Windows WebView에서 중간 숫자 %, 재시도, 최종 완료를 확인한다. 작은 포맷별 검사와 대용량 1건을 분리한다.

## 11. W08 — 주소 변경·접속 모드·웹 호환

**수정 출발점:** `peer-reading-position-routes.ts`, `ServerPeerSyncSettings.tsx`, `src/platform/EmbeddedServerSharing.tsx`, `scripts/desktop/embedded-{sharing,tunnel}.mjs`, `src/services/remote/remote-sync-transport.ts`, `src/sync/local-outbox-sync-service.ts`, `src/main.tsx`, `src/repositories/reader-runtime.ts`, `src/app/runtime/app-runtime.ts`, 기존 원격 연결 UI.

1. 주소 변경은 기존 peer 재인증의 확장으로 처리한다. 새 주소에서 로그인→server ID/기능 확인→성공한 경우만 URL·암호화 session을 교체한다. peer ID·cursor·bootstrap/충돌 기록을 유지한다. 실패하면 기존 연결을 그대로 둔다.
2. 다른 server ID라면 주소 변경으로 처리하지 않는다. 대상 서버 선택/초기 복제의 별도 흐름을 안내한다. 백업에서 복원한 다른 서버, 서로 다른 계정, 로그인 redirect를 테스트한다. 비밀은 URL/QR/로그에 넣지 않는다.
3. Quick Tunnel 재시작 후 새 주소를 입력해 복구할 수 있게 한다. 새 주소 자동 발견 서비스는 이번 범위에 만들지 않는다. 공유 기본값은 Quick Tunnel 선택이며 자동 공개가 아니다.
4. `서버 서재 열기`와 `이 PC에 보관하고 동기화`의 실제 저장 위치를 공통 화면에서 분명히 표시하고 선택한 동작에 연결한다. 직접 열기는 선택한 서버의 Remote repositories·수집기·provider를 사용하고, 동기화 모드는 내장 서버를 계속 정본으로 사용한다. 전환 시 endpoint/session/cache를 함께 바꾸며 화면만 다른 서버로 표시하지 않는다. 연결 해제는 서재 삭제가 아니다.
5. 빈 대상 최초 복제는 빠른 경로로 유지한다. 양쪽에 이미 자료가 있으면 먼저 양쪽 snapshot/기준점으로 inspection을 만들고 `추가/동일/충돌`을 보여 준다. 없는 작품은 기존 전송, 같은 ID·같은 콘텐츠는 주석/설정의 기준 비교, 같은 ID·다른 콘텐츠는 W05 해결을 사용한다. 서로 다른 ID 작품은 기본적으로 별도 작품으로 보존하며 제목만 보고 합치지 않는다. 충돌 선택·자료 반영과 시작 cursor가 일관되게 저장된 뒤 증분 실행을 켠다. 임의 `startFromNow`로 이전 자료를 누락시키지 않는다. 두 서재에 서로 다른 책/같은 책의 다른 메모가 있는 첫 연결을 필수 검사한다.
6. 현재 LAN/Tailscale 직접 공유와 peer URL 허용 범위는 다르다. 이번 범위에서는 비 loopback HTTP를 무조건 허용하는 방식으로 맞추지 않는다. 서버 간 동기화에 사용 가능한 HTTPS 주소와 필요한 설정을 안내하고, LAN HTTP 공유 선택 시 동기화 주소로 그대로 쓸 수 있는 것처럼 표시하지 않는다.
7. 순수 웹은 기존 Remote UI/동기화 client를 사용한다. 같은 PC의 별도 브라우저와 허용된 서로 다른 origin에서 로그인·snapshot·event·asset·세션 만료를 확인한다. 기존 브라우저 로컬 모드의 실제 outbox를 사용해 오프라인 수정→재연결도 검사한다. 작품 추가 시 event만 보내고 원본이 전달되지 않는 등 누락이 있으면 W02의 공통 전송 계약을 기존 web adapter에 연결한다. 데스크톱용 IDB 정본을 추가하지 않는다. HTTPS 웹의 mixed content/CORS/cookie 실패를 명확하게 안내하고 전역 CORS 허용으로 우회하지 않는다.
8. 두 데스크톱 역할의 서버 A/C가 중앙 서버 B를 사용하는 흐름을 같은 PC의 독립 프로필 3개로 검사한다. 각 서재의 상대 하나 정책을 유지하면서 A→B→C의 원래 event ID, 중복 제거와 충돌 전파를 확인한다. 새 메시 동기화 프로토콜은 만들지 않는다.

**완료 검사:** 동일 서버의 URL 변경/잘못된 ID/실패 rollback, cursor 보존, 자료가 있는 양쪽의 첫 연결, 접속 모드 전환, 공유 재시작, 두 서버+브라우저 outbox, 3서버 중계. 실제 타 기기 접속은 제외한다.

**후속 선택 기능:** Tailscale 설치·로그인 자동화, 상태/API 통합, 앱 계정 없는 자동 페어링, 서로 다른 book ID의 자동 병합, 다중 상대/메시 연결은 이번 필수 목록 밖이다. 현재는 주소/설정 안내와 기존 네트워크 사용을 완성한다.

## 12. W09 — 기존 로컬 자료 직접 이전

**수정 출발점:** [로컬 백업 매핑 조사](2026-09-24-local-backup-mapping-audit.md), `src/storage/indexeddb-backup-repository.ts`, `apps/server/src/services/local-backup-converter.ts`, 기존 staging/restore/inspection, `src/features/backup/useBackupController.ts`.

1. 실제 배포된 로컬 스키마와 export 가능한 행을 기준으로 fixture를 추가한다. 개발용 보관 브랜치의 모든 중간 스키마를 지원 대상으로 늘리지 않는다. 사용자 자료가 필요하면 익명화된 fixture/필요 항목을 명시한다.
2. 지원 확대 순서는 책장·소속/공유 설정 → 텍스트/문서 anchor·듣기/만화 프로필 → 여러 revision/추가 회차/source_part → 사용자 AI/TTS 수정·폰트/독서 기록이다. 각 묶음은 기존 매핑표에 필드·참조·충돌 정책을 적고 converter를 확장한다.
3. 복원 대상에서 새 ID가 필요한 경우 기존 copy 재매핑을 사용한다. 과거 revision 원본과 현재 source를 구분하고 anchor를 검증한다. 미지원 비어 있지 않은 행은 계속 전체 inspection에서 알린다. 무손실 이전에 필요한 사용자 자료를 조용히 버리지 않는다.
4. 기존 v1 ZIP에는 outbox가 없다. ZIP 복원으로 미전송 기록을 복구했다고 주장하지 않는다. 살아 있는 로컬 프로필을 옮기는 경로에서는 쓰기/동기화를 잠시 멈추고 현재 사용자 상태·미전송 사건을 읽어 최종 서버로 가져가는 최소 호환 export를 추가한다. 기존 remote endpoint의 미전송 사건을 새 peer에 무조건 재생하지 말고, 상태 보존·기존 상대와의 처리 여부를 기록한다.
5. 기존 v1 ZIP의 256MiB 제한을 수치만 올리지 않는다. 제한보다 큰 실제 기존 프로필 이전이 필요하면 기존 서버 청크 업로드로 작품/자산을 나누어 전달하는 일회성 경로를 사용한다. 중간 native 저장 제품은 만들지 않는다. 이미 생성된 ZIP에 없는 데이터는 복원 불가로 안내한다.
6. 기존 프로필/원본 ZIP은 보존하고, 대상의 작품 수·원본 hash·참조·위치·주석을 확인한 뒤 전환한다. 원격 PDF의 과거 IndexedDB 전용 주석이 발견되면 book/page/revision을 검증해 기존 서버 API로 1회 복사한다. 재실행해도 중복되지 않아야 한다.
7. 작은 fixture로 skip/replace/copy, 객체 오류·DB rollback·프로세스 종료 후 재시도를 검증한다. 256MiB 근처 기존 ZIP의 메모리·임시 공간은 한 번 측정한다. OS 파일/저장 대화상자 검사는 W11에 묶는다.

**완료 기준:** 배포 스키마의 사용자 소유 필드별 보존 결과와 남은 제한이 표로 닫혀 있어야 한다. 모든 가능한 과거 ZIP의 호환성을 추측해 선언하지 않는다.

## 13. W10 — 작업 복구와 실패 경계

**수정 출발점:** `scripts/desktop/embedded-{server,recovery,sharing,tunnel}.mjs`, `smoke-embedded-{recovery,app,large-import}.mjs`, `src-tauri/src/embedded_server.rs`, 기존 import/provider job·upload cleanup·object store.

| 흐름                                         | 시험 방법                                                   | 합격 조건                                                              |
| -------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| 업로드/가져오기 처리 중 launcher/worker 종료 | 독립 테스트 프로필에서 처리 단계 확인 후 해당 소유 PID 종료 | 재시작 후 재개 또는 명시적 재시도, 완료 원본 보존, 작품 중복 없음      |
| 백업/복원/peer 전달 중 종료                  | 객체 publish 전후·DB commit 전후 작은 failpoint             | 자료와 cursor 일치, 미참조 임시 파일 회수, 재실행 안전                 |
| 공유 중 launcher 종료                        | Quick Tunnel/직접 listener 가동 후 종료                     | 소유 공유 프로세스 정리, 재실행 시 이전 공개 상태를 잘못 복원하지 않음 |
| 디스크 부족                                  | upload·object publish·archive 준비/수신·DB 실패 주입        | 오류 표시, 기존 서재 보존, 준비 공간 회수 후 재시도                    |
| 절전/연결 장기 단절                          | 시간 이동/연결 차단과 프로세스 상태를 제어                  | peer가 offline→재연결, 중복 job 없음, 로컬 읽기 유지                   |
| 종료 지연                                    | 종료 단계별 시간/PID 로그                                   | 남은 작업을 설명하고 안전하게 종료/재시도, 무조건 제한 시간 확대 금지  |

현재 확인된 포트 충돌·기본 프로필 복구·합성 공유 단절은 재구현하지 않는다. 이전 Windows 종료 지연 1건은 원인이 확정되지 않았다. 위 실제 작업 중 종료 검사에서 재현되면 해당 단계만 수정한다. OS 전원 장애 전체를 SIGKILL 하나로 검증했다고 하지 않는다.

**완료 검사:** 작은 실패 주입으로 위 경계를 먼저 닫고, 최종 Windows 실제 앱에서 대표 가져오기/복제 도중 종료 한 흐름을 추가한다. 테스트는 임시 프로필만 대상으로 하고 운영 서비스/서재를 중지하지 않는다.

## 14. W11 — 설치·업데이트·배포

**수정 출발점:** `scripts/desktop/build-embedded-{runtime,app,installer}.mjs`, `embedded-inventory.mjs`, `smoke-embedded-installer.ps1`, `src-tauri/` 설치 설정, `.github/workflows/desktop-embedded.yml`, `third_party/` 고지, `apps/server/src/db/migrate.ts`.

1. 기존 성공은 개발 도구 PATH를 제거한 Windows CI와 설치 후보다. 깨끗한 Windows VM에서 Docker/Node/Python/DB가 없고 필요한 VC/WebView 구성이 없는 최초 설치를 검사한다. 사용자 수동 설치 없이 준비되어야 한다. 온라인 최초 준비가 필요하면 정확히 안내하고, 준비 후 인터넷 없는 로컬 읽기를 확인한다.
2. 마지막 후보 데이터 프로필 복사본→새 후보 업데이트→migration→서재·주석·설정·peer cursor 확인을 자동화한다. PostgreSQL major/신규 schema를 옛 실행 파일로 여는 차단과 실패 시 데이터 보존을 확인한다. 기존 migration ledger/lock을 재사용한다.
3. 한글·공백 경로, 중복 실행, 업데이트 시 실행 파일/사용자 자료 분리, 제거 시 데이터 보존을 확인한다. OS 열기/저장 대화상자와 실제 저장된 백업 ZIP은 Windows VM에서 검사한다. Playwright file input/저장 대역 성공과 구분한다.
4. 동봉 Node/PostgreSQL/Redis/Cygwin/cloudflared/수집기/Chromium 등의 실제 버전·출처·hash·고지·요구되는 대응 소스 배포 방법을 inventory와 릴리즈 폴더에 맞춘다. 재배포 조건 판단은 해당 버전의 공식 라이선스 자료로 확인한다. 확인하지 않은 법적 준수를 선언하지 않는다.
5. 최종 installer/압축 배포물의 전체 bytes, 해제 runtime, 브라우저 몫, 첫/재시작 시간·유휴/대표 작업 메모리를 기록한다. 과거 129MB 후보와 수집기 포함 276MB 후보를 최신 빌드 크기로 재사용하지 않는다. 이번 작업에서 단일 EXE 압축이나 다른 OS 지원을 추가하지 않는다.
6. `.github/workflows/desktop-embedded.yml`의 path filter에 최종 peer UI/contracts 등 변경이 포함되는지 확인한다. 최종 관련 코드로 Windows 앱 회귀를 한 번 묶고, installer 검사는 `build_installer=true`로 수행한다. 실제 배포/운영 교체는 검토 가능한 산출물·제한을 갖춘 뒤 기존 배포 지시에 따라 진행한다.

**환경이 없는 경우:** 구현 가능한 검사 스크립트와 정확한 VM 절차를 작성하고 `환경 대기`로 기록한다. 기존 Windows runner 성공을 clean VM 성공으로 대체하지 않는다. 실제 다른 기기 접속 시험은 여전히 제외다.

## 15. W12 — 자격 증명이 필요한 검증

다음은 물리 타 기기 검증과 다르며 전체 남은 목록에 유지한다. 워커는 필요한 환경을 일찍 알리고 다른 독립 작업을 계속한다. 키/계정 부재를 이유로 이미 연결된 기능을 다시 만들지 않는다.

| 항목                      | 필요한 것                               | 확인할 결과                                                                   |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| 수집기 실제 사이트 로그인 | 사용자가 제공한 테스트 계정/직접 로그인 | remote-frame 로그인, 재실행 후 세션 유지·해제, 허용된 작은 본문/metadata 수집 |
| AI·TTS 실호출             | 해당 공급자 테스트 키·사용 허용         | 선택 서버에서 실행, 결과/오디오 저장·재생·실패/취소, native 중복 실행 없음    |
| 고정 Cloudflare 터널      | 준비된 테스트 tunnel token/hostname     | 인증된 웹/API·asset 접근, 해제/재시작, 토큰 미저장·미노출                     |
| Tailscale HTTPS 안내      | 테스트용 기존 네트워크/HTTPS 주소       | 같은 환경에서 주소/인증/복구 안내가 실제 경로와 일치                          |

사용자 계정 비밀을 증거 artifact·문서에 넣지 않는다. Windows 소리 출력은 API bytes 성공과 별개로 기록한다. 외부 서비스 장애는 합성 fixture의 회귀와 구분한다.

## 16. 실행 순서와 할당량 관리

### 권장 순서

1. **W01 → W02a**: 원본 교체 한 흐름을 끝내고 보존·동시 변경을 검증한다.
2. **W03 → W04 → W05**: 일상적인 주석/설정 변경 때문에 동기화가 막히지 않게 하고, 실제 충돌 해결까지 잇는다.
3. **W02b/W02c → W06**: 여러 번 변경·포맷·기존 사용자 자료 범위를 마친다. W03의 원본 교체 교차 검사도 여기서 완료한다.
4. **W07 → W08**: 최초 복제·대용량·진행률·주소 변경·브라우저/중앙 서버 사용을 마친다.
5. **W09 → W10 → W11**: 이전·복구·설치/업데이트를 마친다. 필요한 W12 환경은 그 전에 확보하고 제공된 범위에서 실행한다.

한 워커가 위 순서를 이어서 처리할 수 있다. 작업을 나누면 `W01~W08 동기화`, `W09 이전`, `W10~W11 런타임/배포`가 소유 범위다. 공통 backup/import/migration 파일을 동시에 수정하지 않도록 인계한다. W09는 W02/W03의 계약이 확정된 뒤 연결한다.

### 필요한 검사 명령

repo root에서 변경한 단위에 필요한 파일만 선택한다. 다음은 기존 검사 출발점이며 매번 전부 실행하는 목록이 아니다.

```bash
node node_modules/vitest/vitest.mjs run apps/server/test/peer-reading-position.integration.test.ts
node node_modules/vitest/vitest.mjs run apps/server/src/routes/sync/sync-contract-matrix.test.ts apps/server/src/routes/sync.test.ts
node node_modules/vitest/vitest.mjs run apps/server/src/services/book-revision/reader-state-restore.integration.test.ts
node node_modules/vitest/vitest.mjs run apps/server/test/local-backup-converter.test.ts apps/server/test/local-backup-converter.integration.test.ts
node node_modules/vitest/vitest.mjs run src/features/reader-settings/ServerPeerSyncSettings.test.tsx
node --test scripts/desktop/embedded-sharing.test.mjs scripts/desktop/embedded-tunnel.test.mjs
corepack pnpm typecheck:server
corepack pnpm typecheck:web
git diff --check
```

실제 DB 검사는 기존 `startPostgresIntegrationHarness`를 사용한다. `POSTGRES_BIN_DIR` 또는 **일회용 테스트 DB만** 가리키는 `NOVELDESK_TEST_DATABASE_URL`/`POSTGRES_TEST_URL`을 사용할 수 있다. 운영 DB를 지정하지 않는다. harness 환경이 없어 skip되면 성공 수에 포함하지 않는다. 개발 검사의 Docker 사용 여부와 사용자 배포물의 Docker 불필요 조건은 별개다.

Windows 최종 후보는 현재 코드를 올린 ref에서 다음 workflow를 사용한다. 코드가 바뀌지 않은 동일 실패의 반복 실행보다 원인 확인을 먼저 한다.

```bash
gh workflow run desktop-embedded.yml --ref feat/desktop-embedded-selfhost -f build_installer=true
```

## 17. 워커에게 전달할 지시문

> `/home/koho5155/Docker_Services/.worktrees/moya-desktop-selfhost`의 `feat/desktop-embedded-selfhost`에서 `docs/platforms/2026-09-24-desktop-remaining-work-plan.md`를 최신 남은 작업 기준으로 읽고 구현하라. 현재 HEAD와 사용자 변경을 보존하라. 기본 내장 서버·수집기·새 작품 전달을 다시 만들지 말고 공통 self-host 코드를 재사용하라. 첫 단위는 W01의 최소 공통 계약과 W02a의 원본 교체다. 실제 두 DB에서 상대 주석/독서 위치 보존·동시 수정 충돌·재시도까지 확인한 뒤 W03~W05로 진행하고, 문서의 순서대로 남은 작업을 계속한다. 단계별 결과/미검증 조건을 상태표에 기록하라. 물리 타 기기 검증은 제외하며 키·VM이 없으면 해당 항목을 환경 대기로 기록하고 가능한 다른 단위를 계속하라. 숫자 %는 실제 총량에 근거하고, cursor를 건너뛰거나 자료를 지워 검사를 통과시키지 마라. 최종 완료 보고는 구현 완료/검증 완료/환경 대기를 구분하라.

## 18. 진행 기록

아래 상태는 이 계획 작성 시점이다. 항목별 완료 검사를 통과한 경우에만 갱신한다.

| 작업    | 상태                                                                                                         | commit·검사·제한                                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01     | 최소 기능 협상·변경 기준·영속 충돌 기록 구현, 나머지 기능별 계약 진행 중                                     | `f448df9`; 미지원 사건과 cursor 보존/재시작 검사 통과. W03~W06의 writer·event·asset 표와 충돌 해결은 남음                                                                                                                                                                                                                                                      |
| W02a    | TXT/Markdown 한 차례 원본 교체 구현, 나머지 포맷은 남음                                                      | `604a980` 이후 보완. 실제 독립 2 DB/HTTP에서 import worker 원본 교체, 대상 독서 위치·메모·제목 보존, 재전송·원본 누락 복구·동시 교체 충돌·revision 고정 다운로드·수신 기준 변경 거부·commit 직전 실패 rollback 통과. 과거 원본 객체 GC와 전체 백업 포함 검사 통과                                                                                              |
| W02b    | TXT/Markdown 원본을 오프라인 중 2회 교체한 경우 기존/빈 대상의 최신 snapshot 따라잡기 통과, 일반 경우는 남음 | 원래 사건 ID를 유지하고 전체 사건을 적용한 뒤 cursor 전진. source/target revision 연결·번호·hash를 확인하고 수신 receipt를 content commit에 기록. 빈 대상·기존 대상과 양방향 2 DB 검사 통과. 원격 수신 사건을 같은 peer에 되보내지 않도록 출처 기록. 중간 독서 상태 변경·32회 초과 변경은 cursor를 유지하고 중단하며, W03/W05의 재매핑·사용자 해결 경로가 필요 |
| W02c    | 이미지 시리즈 회차 추가, EPUB 교체, 주석 없는 PDF 교체 통과; 문서 주석 충돌 해결은 남음                      | 실제 import worker의 image_archive 활성 document_page/source_part, EPUB resource, PDF 원본 bytes·hash와 대상 표지·독서 위치·메모 보존을 독립 2 DB/HTTP에서 검사. 백업 객체 저장 코드를 재사용하고 대상의 콘텐츠 자산만 교체. PDF/이미지 페이지 hash가 바뀌어 기존 문서 주석이 어긋나면 cursor·원본·주석을 보존하고 충돌 기록. W03/W05의 주석 재매핑·해결 필요  |
| W03     | 주석 4종 peer 왕복·충돌 차단까지 구현; 나머지 W03 항목 진행 필요 | `3776dce`. 서버 API writer가 기록한 북마크·하이라이트·메모·PDF 문서 주석에 원본 revision, 기준/목표 항목 hash를 포함. 공통 push에서 본문과 목표 hash를 확인하고, 독립 2 DB/HTTP로 생성·수정·삭제·시계 차이·동시 수정 차단·재전송, PDF 페이지 hash 검사를 통과. `peer-reading-position.integration.test.ts` 11건, 문서 주석 테스트 1건, 서버·웹 타입 검사 통과. 듣기 위치·문서 텍스트 순서·만화 프로필·발화 규칙·독서 기록, 과거 버전 사건의 동일 상태 인식, 실제 타 기기/W11 최종 검사는 남음 |
| W04~W08 | 후속 구현 필요 | 작품 정보/표지/책장/설정, 휴지통·충돌 해결, AI/TTS, 최초 복제 숫자 퍼센트·재개, 웹·주소 변경·3서버 검사는 아직 완료로 표시하지 않음 |
| W09     | 기본 ZIP 변환 완료, 확장/복구 남음                                                                           | [C0/C1 기록](2026-09-24-local-backup-mapping-audit.md)                                                                                                                                                                                                                                                                                                         |
| W10     | 기본 복구 통과, 작업 중 장애 경계 남음                                                                       | [기능 지원표](2026-09-24-desktop-feature-support.md)                                                                                                                                                                                                                                                                                                           |
| W11     | 설치 후보 통과, 최종 업데이트/clean VM/재배포 정리 남음                                                      | [기존 인계](2026-09-24-desktop-next-work-handoff.md)                                                                                                                                                                                                                                                                                                           |
| W12     | 환경/자격 증명에 따라 검증 대기                                                                              | mock·공개 metadata 검증과 구분                                                                                                                                                                                                                                                                                                                                 |

**이번 작업의 최종 보고 기준:** 물리 타 기기 검증 제외 조건을 적고, 위 구현·자동 검증의 실제 결과와 환경 대기 항목을 모두 나열한다. W12나 clean VM이 남으면 그 사실을 밝히고 일반 배포까지 전부 검증 완료라고 표현하지 않는다.
