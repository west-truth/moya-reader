# C0: 로컬 백업을 서버 서재로 옮기기 전 데이터 계약 조사

작성: 2026-09-24. **변환 구현 전 조사 기록**이다. 현재 로컬 ZIP을 서버 복원에 직접 넣을 수 없다.

## 확인한 입력

- `IndexedDbBackupRepository.exportBackup()`이 만드는 `noveldesk-backup` v1 ZIP을 사용한다. `stores/<store>.json`, `assets/<storageKey>.bin`, `manifest.json`으로 구성된다. 압축 전 256 MiB, ZIP entry 500개 제한이 있다.
- `src/storage/indexeddb-backup-repository.test.ts`의 TXT 가져오기 fixture와 같은 합성 소스로 실제 로컬 ZIP을 생성해 row key를 확인했다. 비어 있지 않은 항목은 `novels`, `book_content_revisions`, `book_content_chapters`, `book_content_paragraph_pages`, `book_content_domain_heads`, `book_assets`, source blob이었다. 활성 revision을 쓰는 신규 가져오기에서는 legacy `chapters`/`paragraph_pages`가 비어 있다.
- 서버 ZIP parser는 `manifest.backend === 'hosted'`와 `hosted/tables/<table>.json`, `hosted/book_objects.json`을 요구한다. 같은 format/version 표기만으로 호환되지 않는다. 서버 복원은 PostgreSQL row와 객체 저장소를 대상으로 한다.

## 필드별 변환의 기준

| 로컬 항목 | 서버 대상 | 필요한 변환·검사 |
| --- | --- | --- |
| `novels` | `library_books` | `id`, 제목, 파일명, format, author 등 camelCase 필드를 snake_case로 변환한다. `rawText`/`normalizedText`를 행에 그대로 넣지 않는다. `rawTextHash`와 `normalizedTextHash`, 총 회차·문단 수를 실제 원본/페이지와 대조한다. `sourceAssetId`는 `book_objects` 참조로, `activeContentRevisionId`는 revision 행 생성 뒤 연결한다. `lastRead*`는 `reading_positions`와 중복 여부를 검증한다. |
| `book_content_revisions` | `book_content_revisions` | 로컬 `id`, `novelId`, `sourceHash`, `normalizedHash`, 상태를 서버의 `book_id`, `source_object_id`, `source_raw_text_hash`, `normalized_text_hash`, `revision_number`, `status`로 매핑한다. 서버의 활성 revision 유일성/트리거를 확인해야 한다. 로컬 `expected`/`actual` 카운트는 검증 입력이며 서버 행에 복사하지 않는다. |
| `book_content_chapters`, `book_content_paragraph_pages` | `chapters`, `paragraph_pages` | `contentRevisionId`가 활성 revision과 일치하는 행만 선택한다. `storageId`는 IndexedDB 저장 키이고 서버 `id`가 아니다. chapter의 `novelId`→`book_id`, `index`→`chapter_index`, page의 `paragraphs` JSON과 해시·범위를 유지한다. 서버 `paragraph_search`는 복원 후 기존 재구축 함수로 만든다. |
| `book_content_paragraphs`, `book_content_domain_heads` | 파생 인덱스/검증 | 페이지 안 문단의 ID·내용과 별도 paragraph row가 일치하는지 확인한다. domain head는 revision 선택 검증용이며 같은 이름의 서버 백업 테이블은 없다. |
| legacy `chapters`, `paragraphs`, `paragraph_pages` | `chapters`, `paragraph_pages` | 활성 revision이 없는 오래된 책에만 사용한다. 활성 revision 자료와 중복 삽입하지 않는다. legacy 책의 revision ID 생성 규칙과 anchor 보존 정책을 먼저 고정한다. |
| `book_assets` 및 `assets/*.bin` | `book_objects`, `book_assets`, 객체 저장소 | `kind=source`는 `book_objects`와 `library_books.object_id`로, 표지/EPUB resource/문서 page는 `book_assets`로 보낸다. 서버 `book_assets.kind`는 source를 허용하지 않는다. blob SHA-256·길이·content type을 ZIP manifest와 row 모두에 대조하고, 서버 storage key를 새로 할당한다. `source_part`와 여러 revision 원본의 규칙은 별도 확정이 필요하다. |
| `reading_positions` 및 `novels.lastRead*` | `reading_positions` | 로컬 `novelId`→`book_id`, 사용자 ID는 대상 서버 사용자로, `offsetInParagraph`/`chapterProgress`/`scrollTop`/`updatedAt`을 변환한다. 로컬 `anchor` 전체에 대응하는 서버 컬럼이 없으므로 페이지/문단 anchor 재구성의 검증 없이는 무손실이라고 할 수 없다. |
| `bookmarks`, `highlights`, `notes` | 같은 이름의 서버 테이블 | 소유자 ID를 대상 사용자로 붙이고 book/chapter/paragraph ID 참조를 검증한다. 서버 soft delete와 timestamp, 로컬 문서 anchor/추가 필드가 있으면 조용히 버리지 않는다. |
| `settings` 중 공유 설정, `shelves`, `shelf_memberships`, `library_operation_receipts` | `reader_settings`, `shelves`, `shelf_memberships`, `library_operation_receipts` | 로컬 백업 자체가 기기 전용 설정을 제외한다. 공유 설정은 서버의 단일 JSON으로 변환하고, shelf 이름 유일성·기존 항목 충돌과 receipt의 중복 명령을 검사한다. |
| `segments`, `characters`, `character_relations`, `voice_profiles`, `voice_casting_states`, `corrections` | `labeled_segments`, `characters`, `character_relations`, `voice_profiles`, `voice_casting_states`, `user_corrections` | 각각의 column 변환·revision fence·참조 ID·중복 정책 확인이 필요하다. 이름이 비슷한 행을 통째로 삽입하면 안 된다. |
| `user_fonts`, `reading_session_events` 및 blob | 서버 같은 이름의 테이블과 객체 저장소 | 폰트 blob은 서버 객체로 옮긴 뒤 content hash와 참조를 맞춘다. 세션의 book ID·operation ID 중복을 검증한다. |

## 현재 서버 백업 경계의 빈 곳

서버 DB에 테이블이 있어도 `HOSTED_BACKUP_TABLES`에 없으면 기존 서버 ZIP 복원은 그 행을 운반하지 않는다. 로컬 백업이 담는 `listening_positions`, `document_annotations`, `document_text_order_overrides`, `comic_profiles`, `spoken_text_rules`가 대표 사례다. `document_*`의 일부는 기기 캐시/파생 자료라 재생성 가능할 수 있지만, 사용자의 주석·읽던 위치·수정한 텍스트 순서는 그런 가정으로 버릴 수 없다.

로컬의 `native_analysis_provenance`, `label_mutation_receipts`, `label_mutation_invalidations`, `label_reanalysis_plans`, `character_*_v2`, `chapter_structure_*`, speaker attribution/workflow, temporal memory 자료는 서버의 동명 또는 유사 테이블과 필드 계약을 아직 확인하지 못했다. 첫 변환기에서 이름만 보고 복사하지 않는다. 해당 row가 있는 ZIP은 항목별 지원/미지원 진단을 보여 주고 원본 ZIP을 보존해야 한다.

`BACKUP_JSON_STORES`에는 sync outbox가 없다. 이미 만들어진 로컬 v1 ZIP에 **미전송 변경 기록은 들어 있지 않다.** 기존 ZIP으로 이 정보를 복원할 수 있다고 표시하지 않는다. 실사용 중인 로컬 서재를 이전할 때는 동결 시점의 별도 상태 추출 또는 사용자에게 확인 가능한 제한이 필요하다.

## C1 착수 조건

1. 최소 TXT/EPUB/PDF/만화 fixture의 row, 원본 blob, 문서 anchor와 개인화 항목을 각각 만들고 각 값의 서버 열 매핑을 검사한다. 위 TXT fixture만으로 나머지 format을 승인하지 않는다.
2. 서버 백업 staging에 누락된 사용자 소유 테이블을 더할지, 이전 전용 staging을 둘지 결정한다. 둘 다 기존 서버 복원 원자성·참조 검증·원본 보존을 유지해야 한다.
3. 지원하지 않는 항목이 있는 ZIP을 부분 성공으로 보고하지 않는다. 명시적인 사전 inspection, skip/replace/copy, 같은 ZIP 재실행의 중복 정책을 정한 뒤 변환한다.
