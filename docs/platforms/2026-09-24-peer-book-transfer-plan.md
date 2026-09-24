# D2: 최초 복제 이후 작품 전송

기존 self-host에 접속하는 모든 클라이언트는 같은 DB를 사용한다. 기존 이벤트 pull/push는 독립 서버에 원본·회차·자산을 생성하지 않는다. 아래 작업은 그 전송 경계를 추가하며 저장소·수집기·parser를 새로 만들지 않는다.

## D2a — 새 작품과 원본 전달

1. 기존 hosted 백업 exporter에 **한 작품의 콘텐츠만** 선택하는 내부 옵션을 추가한다. 동일 ZIP parser·해시 검증·객체 저장·복원 transaction을 재사용한다. 일반 전체 백업 동작은 유지한다.
2. 콘텐츠 범위는 작품 행·원본·자산·콘텐츠 revision·회차·문단·문서 페이지/텍스트다. 전역 설정·책장·폰트와 독서 위치·주석·AI 상태는 이 경로에 넣지 않는다. 독서 위치는 기존 이벤트 경로가 순서대로 적용한다.
3. 인증된 작품 archive 다운로드/업로드 경로를 추가한다. 업로드는 지정 작품 하나, 허용한 테이블과 자산만 받는다. 상대 서재의 전역 설정이나 다른 작품을 덮어쓸 수 없다.
4. `book_imported` 이벤트 앞에서 상대에 작품이 없으면 archive를 먼저 전달한다. 양방향에 같은 경로를 사용한다. 전달 후 기존 push와 cursor 저장을 사용한다. archive 복원 후 통신이 끊겨도 같은 콘텐츠를 확인하고 다시 진행하며 중복 작품을 만들지 않는다.
5. 기존 작품은 덮어쓰지 않는다. 같은 ID인데 원본·revision·회차가 다르면 기존 자료와 cursor를 보존하고 충돌로 중단한다. 원본 교체가 끝난 작품의 신규 전송은 다음 단계까지 명시적으로 거부한다.
6. 파일 전송은 스트리밍하며 기존 staging의 크기·디스크 공간·해시 검사를 사용한다. 서버 종료 시 전송을 취소한다. 파일 전송을 포함한 실행은 최대 1시간, JSON 제어 요청은 기존 10초 제한을 사용한다.

완료 검사: 실제 두 PostgreSQL/HTTP 서버에서 연결 후 새 작품 A→B 및 B→A, 원본 바이트·회차·검색 데이터, 이어지는 독서 위치, 전역 설정 보존, 동일 archive 재전송, 원본 누락/동일 ID 다른 콘텐츠의 실패와 cursor 보존. 기존 첫 복제와 독서 위치 검사를 함께 통과해야 한다.

## D2b 이후 — 별도 계약이 필요한 변경

다음 항목은 D2a에 포함하지 않으며 아래 검증 기록으로 완료 처리하지 않는다.

- 원본 교체: 이전 콘텐츠 revision 일치 조건과 독서 anchor 보존/재매핑을 확정한 후 기존 교체 코드를 재사용한다. 단순 backup replace로 기존 주석을 지우지 않는다.
- 작품 정보·주석: 기존 이벤트 적용기를 사용하되 원본 revision과 동일 시각 충돌을 확인한다.
- 삭제: 휴지통·복원과 영구 삭제를 구분하고 상대가 오프라인일 때의 자료 보존을 정한다.
- D2a의 새 작품 전달 성공을 위 항목이나 전체 서재 동기화 완료로 표기하지 않는다.

## D2a 구현·로컬 검증 기록

- 첫 Windows 실행 `35961633992` (`3de9fbf`)은 API 시작에서 실패했다. 운영 서버의 기존 ZIP parser를 새 경로가 중복 등록하는 조건을 로컬에서 `FST_ERR_CTP_ALREADY_PRESENT`로 재현했다. 기존 backup route처럼 새 route scope 안에서 inherited parser를 교체하고 통합 harness도 운영 parser 조건을 갖추도록 수정했다. 수집기 검증 프로필에서 API가 먼저 실패할 때 원인을 남기도록 CI 진단 로그 수집도 보완했다. 새 실행 결과를 확인하기 전 Windows 새 작품 전달 완료로 표시하지 않는다.
- `hosted-backup-service.ts`의 한 작품 선택 옵션과 `peer-book-content.ts`의 콘텐츠 범위 검사·신규 복원을 연결했다. 별도 ZIP 형식이나 저장소는 없다.
- 인증된 `/api/sync/book-content/:bookId` GET/POST를 사용하고 peer 실행기가 `book_imported` 앞에서 원본을 전달한다. 같은 ID의 기존 자료는 덮어쓰지 않는다. UI 안내·실행 제한 시간을 실제 범위에 맞췄다.
- 두 실제 DB/HTTP 서버의 작은 TXT A→B/B→A, 원본 바이트, 검색 데이터, 뒤따르는 독서 위치, 전역 설정 보존, 응답 유실을 가정한 cursor 재전송, archive 중복, 원본 누락→복구 후 재시도, 같은 ID 다른 원본의 거부를 검사했다. 가져오기 worker처럼 device ID가 없는 book revision 이벤트도 사용했다.
- 전역 설정·책장·독서 위치·북마크·다른 작품 회차·허용하지 않은 자산을 archive에 넣으면 DB 접근 전에 거부하는 6개 검사도 통과했다. 기존 백업·동기화를 포함한 관련 45개 검사와 서버·웹 타입 검사를 통과했다.
- Windows 검사에는 실제 source 서버 가져오기 worker로 새 TXT를 추가한 뒤 native 공통 UI에서 동기화하고 대상 원본 바이트를 확인하는 흐름을 추가했다. 결과는 실행 완료 후 기록한다. 다른 형식의 증분 전달·대용량·물리 타 기기는 아직 검증하지 않았다.

### 변경 번호와 commit 순서 보완

- 새 작품 경로 검토 중 기존 공통 pull에도 있던 누락을 재현했다. transaction A가 낮은 sequence를 받은 채 commit하지 않고 B의 높은 sequence만 먼저 commit되면, SELECT가 B만 반환하고 cursor가 A를 영구히 건너뛴다.
- `pull-query.ts`에서 짧은 transaction의 `SHARE` table lock을 얻은 후 별도 SELECT로 목록을 읽는다. 진행 중인 event writer가 먼저 끝나므로 반환한 cursor 이전 사건이 나중에 나타나지 않는다. 동시 pull끼리는 공유할 수 있고, 잠금 대기는 2초로 제한해 오래 걸리는 writer 앞에서는 실패 후 다시 시도한다. 일반 클라이언트 pull, peer outbound와 초기 연결/복제 watermark에 같은 경계를 적용했다.
- 실제 PostgreSQL에서 commit 순서를 뒤집은 검사로 수정 전 누락과 수정 후 두 사건 수신을 확인했다. 새 작품·복구를 포함한 통합 5개와 기존 sync 단위 23개가 통과했다. 대규모 동시 writer 부하 검사는 별도이며 이 수정으로 전체 동기화 기능 완료를 주장하지 않는다.

### D2b 재사용 경계 조사

- 기존 원본 교체는 `book-revision/service.ts`의 `prepareBookReplacement` → 콘텐츠 교체 → `restoreExactAnchoredReaderState` → `finalizeBookReplacement`를 사용한다. 관련 검사 출발점은 `book-revision/reader-state-restore.integration.test.ts`다.
- 다음 구현은 상대와 마지막으로 같았던 content revision을 확인한 뒤 이 경계를 사용해야 한다. 현재 `book_imported`의 payload는 book ID만 있으므로 이전 revision을 증명하는 계약을 먼저 추가한다. 같은 ID라는 이유만으로 수신 서버의 다른 원본을 교체하지 않는다.
- archive 범위를 기존 작품에 넓히기 전, 과거 revision이 참조하는 source object까지 보존되는지 확인한다. 현 exporter는 현재 catalog의 source object만 수집한다. 새 작품 전달은 initial revision만 허용하므로 이 조건을 건드리지 않는다.
