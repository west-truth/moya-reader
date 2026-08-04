# 대용량 파일 처리와 크로스 디바이스 동기화 설계

Status: partially implemented living design
Last verified: 2026-07-06

2026-07-07 update: Docker hosted E2E is verified. `pnpm check:hosted:e2e` passed with Docker Desktop running, including Compose build/startup, hosted live smoke, and default volume teardown. The root `.dockerignore` now excludes local dependency/build artifacts from Docker contexts, and `pnpm check:hosted` verifies those exclusions so workstation `node_modules`, `dist`, or Tauri build output cannot break container builds.

## 목적

초기 MVP는 데스크톱 실행 파일에서 작은 TXT/Markdown 파일을 빠르게 읽는 데 초점을 맞춘 구조였다. 이후 Web Worker import, IndexedDB `paragraph_pages`, repository boundary, virtualized reader DOM, hosted server API, Docker Compose 기반이 추가되었다. 그래도 큰 파일에서 남는 렉 위험은 파일 입수, 파싱, 저장 일부가 아직 "전체 데이터를 한 번에" 처리하는 데서 온다.

이 문서는 다음 두 가지를 동시에 만족하는 방향을 정리한다.

- 기존 Tauri exe는 오프라인 로컬 리더로 계속 동작한다.
- 웹 서버로 호스팅하면 PC/모바일 브라우저에서 같은 책, 읽은 위치, 북마크, 메모를 동기화할 수 있다.

## 현재 구현 현황과 남은 병목

현재 로컬 import/reader 흐름은 다음과 같다.

```text
File input
  -> BrowserImportService
  -> import-worker receives File
  -> worker file.arrayBuffer()
  -> parseNovelFile()에서 전체 디코딩/정규화/해시/화 분리/문단 분리
  -> worker saveImportedNovel() page batch write
  -> paragraph_pages + page-backed paragraph refs를 IndexedDB에 저장
  -> reader는 화면 주변 paragraph page만 sparse cache에 적재
  -> reader DOM은 @tanstack/react-virtual로 가상화
```

문제 지점:

- `file.arrayBuffer()`가 파일 전체를 worker 메모리에 올린다.
- v8에서 `Novel.rawText`, `Novel.normalizedText`, `Chapter.normalizedText`는 metadata-only 빈 문자열로 저장한다. `paragraph_pages`가 본문 정본이며 `paragraphs` store는 `pageIndex`가 있는 lightweight ref만 저장한다.
- 로컬 worker import는 import 전용 parser 결과를 `saveParsedNovelImport()`에 넘긴다. 서버 worker도 import 전용 parser 결과를 rekey wrapper로 감싼 뒤 page batch를 insert한다. import chapter source는 sync/async iterable을 모두 받을 수 있어 다음 streaming parser가 chapter paragraphs를 async로 내보낼 수 있다. page 저장은 batch iterator로 진행되어 전체 `ParagraphPage[]`나 전체 `ParsedNovel.paragraphs` 배열을 먼저 만들지 않지만, 현재 parser는 여전히 파일 buffer와 normalized chapter body를 page batch가 소비될 때까지 들고 있다.
- `getChapters()`, page-backed `getParagraphs()`, child entity reads, paragraph page reads는 index/page 기반으로 바뀌었지만 `getNovels()`는 책장 전체 목록이라 전체 store를 읽는다.
- 리더 DOM은 가상화되었지만, 대용량 fixture와 실제 브라우저 screenshot 검증은 더 필요하다.
- 본문 검색은 repository data source 기반으로 책 전체 capped result를 반환한다. Hosted server search는 `paragraph_search` row table과 `pg_trgm` index/backfill을 사용해 paragraph lookup, chapter search, and book search가 `paragraph_pages` JSON lateral scan을 피하고, SQL LIKE wildcard를 escape하며 reader policy cap을 적용한다. Local IndexedDB v9 search도 `paragraph_search` object store와 `chapterId_paragraphIndex` cursor를 사용해 page JSON array scan을 피하고, 오래된 데이터에 대해서만 page cursor/legacy cursor fallback을 사용한다.

따라서 큰 파일 최적화는 "파일을 나눠서 보내자" 하나로 해결되지 않는다. 수신, 파싱, 저장, 조회, 렌더링 경계를 모두 chunk/page 단위로 바꿔야 한다.

## 권장 결론

먼저 로컬 대용량 처리 구조를 고친 뒤, 같은 저장소 계약 위에 서버 동기화를 얹는다.

순서가 중요하다. 서버부터 붙이면 웹 호스팅은 가능해도 큰 파일을 한 번에 JSON으로 주고받는 구조가 남아서 같은 병목이 서버/브라우저 양쪽으로 번진다.

권장 방향:

1. Import pipeline을 Web Worker 또는 Tauri Rust command로 이동한다. 현재 browser import는 Web Worker로 이동했다.
2. 파일을 stream/chunk 단위로 디코딩하고, 파서가 incremental result를 내보내게 한다.
3. 저장소를 manifest + chapter metadata + paragraph/page chunk 구조로 바꾼다.
4. 조회는 IndexedDB index cursor 또는 서버 pagination/range API로 한다. 현재 주요 child reads와 server reader APIs는 이 방향을 따른다.
5. 리더는 virtualized paragraph/page rendering으로 현재 화면 주변만 DOM에 올린다. 현재 scroll reader는 sparse page cache와 virtual DOM을 사용한다.
6. 서버 동기화는 content-addressed file hash와 sync event log를 기준으로 붙인다. 현재 API push/pull, supported local apply, remote `book_imported` cache hydration, local/server tombstone 경로, sync event revision metadata 저장/pull 경로는 있다. remote `book_imported` hydration은 page batch stream 경로를 우선 사용해 클라이언트가 서버 책 전체 `paragraphPages` 배열을 한 번에 만들지 않아도 된다. AI/TTS snapshot 그룹은 서버 snapshot 적용과 선택 로컬 필드 병합 UI가 있으며, 일반 reader entity-level merge UI와 full conflict UI는 남아 있다.

## 로컬 대용량 처리 설계

### 1. Import Job

파일 가져오기는 즉시 `ParsedNovel` 전체를 반환하지 말고 job으로 처리한다.

```ts
type ImportJobStatus =
  | 'queued'
  | 'reading'
  | 'decoding'
  | 'splitting_chapters'
  | 'writing'
  | 'ready'
  | 'failed';

interface ImportProgress {
  jobId: string;
  status: ImportJobStatus;
  bytesRead: number;
  totalBytes: number;
  chaptersDetected: number;
  paragraphsWritten: number;
  message?: string;
}
```

브라우저/WebView에서는 `File.stream()` + `TextDecoderStream` 또는 Web Worker를 사용한다. Tauri exe에서는 Rust command가 파일을 stream으로 읽고, frontend에는 progress event만 보낸다.

원칙:

- UI thread에서 전체 파일 파싱 금지.
- import 진행 중 취소 가능.
- 저장은 500~2000 paragraphs 정도의 batch transaction으로 나누기.
- import 완료 전에도 detected chapter 목록 정도는 점진 표시 가능.

### 2. 저장 모델 v2

`Novel`에 전체 원문을 넣지 않는다. `Novel`은 manifest metadata만 가진다.

```ts
interface NovelManifest {
  id: string;
  title: string;
  author?: string;
  sourceFileName: string;
  sourceSizeBytes: number;
  sourceEncoding?: EncodingMode;
  rawTextHash: string;
  normalizedTextHash: string;
  textStorageMode: 'local-file' | 'idb-pages' | 'server-object';
  localFilePath?: string;
  objectKey?: string;
  totalChapters: number;
  totalCharacters: number;
  totalParagraphs: number;
  createdAt: string;
  updatedAt: string;
}

interface ChapterMeta {
  id: string;
  novelId: string;
  index: number;
  title: string;
  textHash: string;
  rawStartOffset: number;
  rawEndOffset: number;
  characterCount: number;
  paragraphCount: number;
  pageCount: number;
}

interface ParagraphPage {
  id: string;
  novelId: string;
  chapterId: string;
  pageIndex: number;
  startParagraphIndex: number;
  endParagraphIndex: number;
  textBytes?: Uint8Array;
  paragraphs: Paragraph[];
  textHash: string;
}
```

IndexedDB store 제안:

```text
novels
chapters           index: novelId, [novelId+index]
paragraph_pages    index: chapterId, [chapterId+pageIndex]
bookmarks          index: novelId, chapterId
notes              index: novelId, chapterId
reading_positions  key: novelId
sync_outbox        index: status, createdAt; localSequence for queue order
```

중요 변경:

- `getAll()` 후 필터링 금지.
- `chapterId` index cursor로 필요한 page만 읽는다.
- `Paragraph` 개별 row를 수만 개 저장하는 대신 page 단위 저장을 기본값으로 한다.
- Hosted server search index는 `paragraph_search` table로 구현되어 import 시 page batch와 함께 채워지고 migration이 기존 `paragraph_pages`에서 backfill한다. Local search index도 v9 `paragraph_search` object store로 구현되어 local import, parser-import save, remote snapshot hydration, and v9 migration이 row를 채운다. Local chapter search는 `chapterId_paragraphIndex` cursor와 early limit을 사용하고, search rows가 없는 legacy chapter만 page cursor fallback을 사용한다.

### 3. Reader Rendering

현재 화 전체 문단을 렌더링하지 않는다.

권장 방식:

- `ChapterReaderDataSource`가 `loadPage(chapterId, pageIndex)`를 제공한다.
- reader는 현재 scroll 위치 주변 page만 메모리에 유지한다. 현재 React reader cache는 paragraph index `Map`으로 유지되어 page load마다 chapter 길이만큼 sparse array를 복사하지 않는다.
- DOM은 virtual list로 화면 주변 문단만 렌더링한다.
- progress는 `chapterId + paragraphIndex + offsetInParagraph`를 기준으로 저장한다. `scrollTop`은 기기/폰트/화면 크기마다 달라 보조값으로만 쓴다.

```ts
interface ReadingPosition {
  novelId: string;
  chapterId: string;
  paragraphId?: string;
  paragraphIndex?: number;
  offsetInParagraph?: number;
  chapterProgress: number;
  deviceId: string;
  updatedAt: string;
}
```

### 4. 캐싱 정책

로컬 앱과 웹 모두 같은 개념을 쓴다.

```text
Memory LRU cache
  - current chapter pages
  - previous/next chapter metadata

Persistent cache
  - IndexedDB paragraph_pages
  - downloaded server manifests
  - sync_outbox
```

캐시 기본값:

- 메모리: 현재 chapter 주변 10~30 pages.
- IndexedDB: 사용자가 가져온 책은 전체 보관.
- 서버에서 내려받은 책은 최근 읽은 책 N권 또는 사용자가 "오프라인 보관"한 책만 전체 보관.

## 서버 동기화 설계

### 제품 모드

```text
Local-only mode
  - 현재 exe와 동일하게 오프라인 동작
  - 모든 책/위치/메모는 로컬 저장소에만 있음
  - 로그인 필요 없음

Connected mode
  - 서버 계정에 로그인
  - 업로드한 책, 읽은 위치, 북마크, 메모, 설정을 동기화
  - exe/web/future apk가 같은 API 사용
  - 네트워크가 없으면 local outbox에 쌓고 나중에 sync
```

### 서버 구성

TypeScript 생태계를 유지하려면 API 서버는 Node.js + Fastify가 적합하다. DB는 PostgreSQL, 원문 파일은 S3 호환 object storage를 쓴다. Docker Compose 개발/자가호스팅 환경에서는 MinIO를 붙인다.

```text
web
  - Vite build 정적 파일
  - Nginx 또는 Caddy

api
  - Fastify HTTP API
  - auth, library, upload, sync endpoint
  - 현재 self-host 보호는 `READER_AUTH_TOKEN` bearer token으로 켤 수 있고, full account/session UI는 이후 단계로 둔다.
  - `/ready` readiness는 Postgres, Redis/BullMQ queue, S3/MinIO bucket 접근을 확인한다.
  - reader mutation API는 malformed payload를 DB write 전에 400으로 거절하고, reading-position/bookmark/highlight/note direct write는 요청한 book/chapter가 현재 사용자 라이브러리에 있을 때만 적용한다. Bookmark/highlight/note upsert 충돌은 같은 user/book row에만 적용하며, sync payload의 nested book identity는 route `bookId`로 정규화한다.

worker
  - 업로드 완료 파일 파싱
  - chapter/paragraph page 생성
  - 향후 AI/TTS job 처리

postgres
  - user, device, manifest, chapter metadata, reading position, notes

minio
  - raw imported files
  - optional parsed paragraph page blobs

redis
  - background job queue
  - optional rate limit/session cache
```

### Docker Compose 구성

현재 `compose.yaml`, `deploy/web.Dockerfile`, `deploy/server.Dockerfile`, `deploy/nginx.conf`가 있다. 서비스 구성은 아래 형태다.

```yaml
services:
  web:
    build:
      context: .
      dockerfile: deploy/web.Dockerfile
    ports:
      - "8080:80"
    depends_on:
      - api

  api:
    build:
      context: .
      dockerfile: deploy/server.Dockerfile
    environment:
      DATABASE_URL: postgres://noveldesk:noveldesk@postgres:5432/noveldesk
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: noveldesk-uploads
      S3_ACCESS_KEY_ID: minio
      S3_SECRET_ACCESS_KEY: minio-password
      S3_FORCE_PATH_STYLE: "true"
    depends_on:
      - postgres
      - redis
      - minio

  worker:
    build:
      context: .
      dockerfile: deploy/server.Dockerfile
    command: pnpm --filter server worker
    environment:
      DATABASE_URL: postgres://noveldesk:noveldesk@postgres:5432/noveldesk
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: noveldesk-uploads
      S3_ACCESS_KEY_ID: minio
      S3_SECRET_ACCESS_KEY: minio-password
      S3_FORCE_PATH_STYLE: "true"
    depends_on:
      - api
      - postgres
      - redis
      - minio

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: noveldesk
      POSTGRES_PASSWORD: noveldesk
      POSTGRES_DB: noveldesk
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio-password
    volumes:
      - minio-data:/data
    ports:
      - "9001:9001"

volumes:
  postgres-data:
  minio-data:
```

## API 설계

### 업로드

큰 파일은 한 번에 JSON body로 보내지 않는다.

```http
POST /api/uploads/init
Content-Type: application/json

{
  "fileName": "novel.txt",
  "sizeBytes": 123456789,
  "contentType": "text/plain",
  "clientHashHint": "optional",
  "clientBookId": "optional local book id for attach uploads"
}
```

현재 서버는 `MAX_UPLOAD_BYTES`로 전체 업로드 크기를 제한한다. 기본값은 500MB다.

```http
GET /api/uploads/{uploadId}
```

업로드 상태 응답은 `uploadedBytes`, `receivedChunkIndexes`, `missingChunkIndexes`, `complete`, `importJobId`를 포함한다. 현재 hosted web import service는 같은 import attempt 안에서 chunk 전송 실패가 발생하면 이 상태 API를 다시 읽어 이미 서버가 받은 chunk는 건너뛰고 누락 chunk만 재시도한다. upload session metadata는 같은 파일 지문 기준으로 browser storage에 7일 TTL로 저장된다. 사용자가 같은 파일을 다시 선택하면 서버 session이 아직 `uploading` 상태인 경우 이어서 업로드하고, 이미 `queued/imported` 상태로 넘어간 경우에는 새 업로드를 만들지 않고 기존 import job을 계속 확인한다. import modal은 저장된 resume session을 표시하고, 사용자가 항목을 지우거나 active upload를 취소하면 서버 cancel API를 호출한 뒤 local resume metadata를 제거한다. 서버는 `STALE_UPLOAD_MAX_AGE_MS`보다 오래된 `uploading` session을 API 시작 시와 수동 prune API에서 `expired`로 바꾸고 chunk metadata/file을 정리한다.

일반 파일 import는 `ServerUploadImportService`를 사용하고, parsed/sample fallback 경로인 `RemoteReaderRepository.saveImportedNovel()`도 reconstructed TXT를 bounded chunks로 업로드한다. `clientBookId`가 전달된 upload session은 worker가 parsed book/chapter/paragraph id를 그 local book id 기준으로 다시 매핑해 materialize한다. 같은 book id를 다시 import할 때는 기존 chapter/page rows를 먼저 지운 뒤 새 rows를 넣어 stale page가 남지 않게 한다. Local connected mode에서는 저장된 sync API base URL 또는 `VITE_SYNC_API_BASE_URL`이 있는 경우 sync panel의 "서버 본문 연결" 액션이 IndexedDB의 chapter/page 텍스트를 UTF-8 TXT `File`로 재구성하고 `clientBookId=<local novel id>`로 업로드한 뒤 local outbox flush/pull을 실행한다. 사용자는 sync panel에서 self-host API URL을 입력해 `/ready` 연결 테스트를 하고 저장할 수 있으며, 저장 후 앱을 다시 불러와 같은 `LocalOutboxSyncService`/`LocalBookAttachService` 런타임을 구성한다. 이 재구성은 page-backed 본문을 chapter-wide paragraph array와 whole-chapter string으로 다시 합치지 않고, page/paragraph 순서대로 `File` parts에 추가한다. Page batch 사이에서 progress, cancel, browser yield를 처리해 큰 단일 화에서도 취소가 chapter 끝까지 밀리지 않게 한다. 이 경로는 기존 읽기 위치/북마크/메모 sync event가 같은 book id에 붙도록 하기 위한 attach 흐름이다. Attach 후 서버 parser가 chapter/paragraph id를 재생성한 경우 local remote snapshot hydration은 chapter/paragraph index와 실제 paragraph text의 canonical `integrityHash`를 사용해 local reader anchors와 unsent reader child outbox payload를 remap한다. 저장된 v1 FNV와 v2 tagged hash 문자열을 직접 비교하지 않으므로 동일 본문이면 contract 전환 중에도 매칭된다. 대형 파일을 하나의 chunk나 JSON body로 보내는 경로를 새로 만들면 안 된다.

```http
PUT /api/uploads/{uploadId}/chunks/{chunkIndex}
Content-Type: application/octet-stream
```

chunk PUT은 upload session row를 lock한 뒤 `uploading` 상태에서만 chunk를 기록한다. `complete`가 같은 session을 queue 상태로 전환하는 동안 늦은 chunk가 끼어드는 것을 막는다.

```http
POST /api/uploads/{uploadId}/complete
```

완료 요청은 declared chunk count, 연속 index, 총 byte 수를 검증한 뒤 import job을 큐에 넣는다. BullMQ job id는 PostgreSQL `import_jobs.id`와 같게 넣고, worker 시작 시 DB에 남은 queued import job을 다시 enqueue한다. hosted web이 import job status를 polling할 때도 queued DB job이면 enqueue를 재시도해서, DB commit 이후 BullMQ enqueue가 일시 실패한 경우 worker 재시작 전에도 복구될 수 있게 한다. 완료 후 서버 worker가 파싱하고, chapter/page metadata를 batch insert하며, page batch가 끝날 때마다 `paragraphs_written`을 갱신하고, 마지막에 `book_imported` sync event를 만든다. 서버 worker는 아직 업로드 전체를 하나의 preallocated `Buffer`로 조립하지만, parser에 넘길 때는 정확히 맞는 backing store를 재사용하고 pooled/sliced buffer만 필요한 범위로 잘라 불필요한 `Uint8Array.from()` 전체 복사를 피한다. paragraph page 저장도 iterator batch로 진행해 전체 page 배열을 먼저 materialize하지 않는다.

```http
DELETE /api/uploads/{uploadId}
```

취소 요청은 아직 `uploading` 상태인 session만 lock해서 처리한다. 서버는 저장된 chunk row와 chunk file을 정리하고 session status를 `cancelled`로 바꾼다. 이미 import queue에 들어간 session은 취소하지 않고 409로 응답한다.

```http
POST /api/uploads/prune
```

prune 요청은 현재 사용자 기준으로 TTL이 지난 `uploading` session만 `expired`로 바꾼다. API 서버 시작 시에도 같은 helper를 사용자 제한 없이 한 번 실행해 self-host 장기 운영에서 방치된 chunk 파일이 계속 쌓이지 않게 한다.

### 책/화 조회

```http
GET /api/books
GET /api/books/{bookId}/manifest
GET /api/books/{bookId}/chapters
GET /api/chapters/{chapterId}/pages/{pageIndex}
GET /api/chapters/{chapterId}/pages?from=0&count=5
```

`manifest`는 빠르게 받고, 본문은 page 단위로 lazy load한다.

### 읽은 위치/동기화

```http
PATCH /api/books/{bookId}/reading-position

{
  "chapterId": "ch_...",
  "paragraphId": "p_...",
  "paragraphIndex": 120,
  "offsetInParagraph": 15,
  "chapterProgress": 0.42,
  "deviceId": "device_...",
  "updatedAt": "2026-07-04T11:20:00.000Z"
}
```

```http
DELETE /api/books/{bookId}/reading-position

{
  "deviceId": "device_...",
  "updatedAt": "2026-07-04T11:22:00.000Z"
}
```

```http
GET /api/sync?since=event_123
POST /api/sync/events
```

동기화 대상:

- books/manifests
- reading positions
- bookmarks
- notes
- reader settings
- voice profiles
- user corrections

Current implemented AI/TTS sync scope includes user-authored `voice_profiles_updated`, `user_correction_created`, and `user_correction_deleted` events plus generated `character_graph_updated` and `chapter_segments_updated` events. Hosted audio cache metadata intentionally stays in server/object storage rather than the sync event loop. The browser sync panel groups pending/failed AI/TTS rows by entity, explains the current materialization policy, fetches remote AI/TTS snapshots when a sync API client is configured, includes Character Graph relations through the hosted graph read route, compares them with the queued local payload through `src/sync/ai-tts-sync-diff.ts`, can apply the loaded server snapshot for voice/graph/segment groups through `src/sync/ai-tts-sync-apply.ts`, and can rewrite a merged local snapshot that starts from the server snapshot while preserving selected local fields/items for those same snapshot groups. User-correction deletion removes the correction hint row without rolling back already-materialized segment labels, and local tombstones prevent stale remote correction creates from resurrecting deleted hints.
- 향후 hosted audio cache reuse strategy and broader non-AI/TTS entity merge UI

## 충돌 처리

읽은 위치:

- 같은 책에서 가장 최신 `updatedAt`을 기본 채택한다.
- 서버는 직접 reading-position PATCH/DELETE와 sync event push 모두에서 기존 `updated_at` 또는 최신 `reading_position_deleted` event보다 오래된 위치 변경을 저장하거나 event log에 남기지 않는다.
- 단, 현재 기기에서 읽는 중이면 서버 위치가 더 최신이어도 즉시 점프하지 않고 "다른 기기 위치로 이동" 액션을 띄운다.

북마크/메모:

- append-only event로 저장한다.
- 삭제도 tombstone event로 동기화한다.
- 서버는 bookmark/highlight/note row를 물리 삭제하지 않고 `deleted_at` tombstone으로 보존하며, active list API는 tombstone을 제외한다.
- 서버 sync push는 기존 entity timestamp보다 오래된 create/update/delete event를 event log에 넣지 않는다.
- 서버 book content가 아직 없는 local-only book의 reading position/bookmark/highlight/note child event도 event log에 넣기 전에 reject한다. Local connected attach는 server import가 완료된 뒤 failed/pending outbox를 다시 flush해야 하며, pre-attach child event를 "accepted but not materialized" 상태로 만들면 안 된다. `LocalOutboxSyncService`는 이 pre-attach 실패 메시지를 가진 failed row가 있으면 다음 flush에서 push 전에 pull/cache를 먼저 실행하고, `cacheRemoteBookSnapshotStream()`은 old local child-id index와 remote snapshot child-id index를 비교해 `reading_position_updated`, `bookmark_created`, `highlight_created`, `note_created`, `note_updated` payload를 안전하게 remap한다. 서버 `/api/sync/events`도 reader child anchor가 현재 서버 `chapters`/`paragraph_search`에 속하는지 검증해 stale chapter/paragraph id가 event log에 들어가지 않게 한다.

설정:

- 필드별 last-write-wins.
- 기기별 설정과 계정 공통 설정을 분리할 수 있게 `scope: account | device`를 둔다.

책 파일:

- `normalizedTextHash` 또는 raw file hash로 중복 업로드를 방지한다.
- 같은 파일이면 서버 object는 하나만 두고 user library row만 추가한다.

## 클라이언트 저장소 추상화

UI가 IndexedDB/서버/Tauri 파일 시스템을 직접 알면 안 된다. repository interface를 둔다.

실제 web boundary는 `LibraryQueries`, `ReaderQueries`, `ReaderCommands`, `AnnotationRepository`, `AnalysisArtifactRepository`, `SyncRepository`, `BulkBookSource`로 나뉜다. `ReaderRepository`는 기존 호출부를 위한 intersection compatibility facade다. Reader는 bounded page query와 cancellable cursor search를 사용하고, TTS 같은 dense consumer는 `iterateParagraphPages({ chapterId, signal })` AsyncIterable을 우선한다. 원격 bulk source는 한 번에 최대 20 page를 fetch하고 page별로 yield하므로 paragraph N+1을 만들지 않는다.

Local/remote reader query adapters share one contract suite. Search cursor는 scope/target/query와 누적 result count를 묶고 chapter 200/book 300 hard limit을 적용한다. IndexedDB scan은 row/text budget과 active transaction abort를 사용하며 remote transport는 같은 signal을 fetch까지 전달한다.

구현체:

```text
LocalIndexedDbRepository
TauriSqliteRepository
RemoteReaderRepository
CachedRemoteRepository
LocalBookAttachService
```

`ReaderRuntime`은 local mode에서 저장된 sync API base URL 또는 `VITE_SYNC_API_BASE_URL`이 있을 때 `LocalOutboxSyncService`와 `LocalBookAttachService`를 함께 만든다. Sync panel의 서버 연결 섹션은 API URL을 정규화하고 `/ready`로 테스트한 뒤 `localStorage`에 저장한다. 런타임 서비스는 module startup에서 만들어지므로 URL 저장 후 앱을 다시 불러와 새 서버 경계로 재구성한다. `LocalBookAttachService`는 repository에서 chapter/page 텍스트를 읽어 server upload service로 넘기는 add-on 경계이며, UI component가 upload API나 LLM/TTS provider를 직접 호출하지 않는 원칙과 같은 이유로 별도 서비스로 둔다. Page-backed local books are rebuilt in page order into `File` parts, avoiding an extra whole-chapter text join before upload.

exe는 기본적으로 `LocalIndexedDbRepository` 또는 `TauriSqliteRepository`를 쓰고, 로그인 시 `CachedRemoteRepository` 또는 같은 attach/sync service 조합이 서버와 동기화한다. 웹은 `CachedRemoteRepository`를 기본으로 쓰되, IndexedDB cache를 가진다.

## 구현 단계

### Phase 1: 로컬 대용량 안정화

- legacy `paragraphs` store text 의존 제거 계획 수립.
- `getChapters/getParagraphs`를 IndexedDB index cursor 기반으로 변경.
- import를 Web Worker로 이동.
- import progress UI 추가.
- paragraph page 저장소 도입.
- reader virtual list 적용.

성공 기준:

- 50~100MB TXT import 중 UI가 멈추지 않는다.
- import 진행률과 취소 버튼이 동작한다.
- reader 진입 시 현재 화면 주변만 렌더링한다.
- chapter 전환이 파일 크기와 거의 무관하게 일정하다.

반복 검증용 large TXT fixture는 저장소에 커밋하지 않고 아래 명령으로 생성한다. `fixtures/generated/`는 git에서 무시한다.

```bash
pnpm fixture:large -- --mb=50 --output=fixtures/generated/large-novel.txt
```

### Phase 2: Sync-ready local schema

- `reading_positions`, `sync_outbox`, `devices` store 추가.
- 읽은 위치를 `scrollTop` 중심에서 `chapterId + paragraphIndex + offset` 중심으로 변경.
- 북마크/메모/설정 변경을 event 형태로 저장.
- 서버가 없어도 outbox가 로컬에서 정상 동작하게 만든다.

### Phase 3: 서버/웹 호스팅

- 루트 Vite 웹 앱을 `deploy/web.Dockerfile`에서 remote backend mode로 빌드하고 nginx가 정적 호스팅 및 `/api` 프록시를 담당하게 구성.
- `apps/server` Fastify API 추가.
- PostgreSQL migration 추가.
- chunk upload API와 worker import pipeline 추가.
- import 큐잉 전 chunk count, 연속 index, 총 byte 검증.
- import job stage/count/message progress 저장 및 조회 API 추가.
- Docker Compose 및 `.env.example` 추가.
- Local connected mode에서 기존 IndexedDB 책을 서버 book content로 attach하는 sync panel 액션 추가.

### Phase 4: 로컬 connected mode

Status update - 2026-07-06: local connected mode now refreshes mounted React state after a successful background/manual sync pull. `LocalOutboxSyncService.flushPending()` pushes local outbox rows, pulls server events, hydrates remote `book_imported` snapshots, applies supported remote events to IndexedDB, and pulls attached-book snapshots before retrying pre-attach child rows so rekeyed server chapter/paragraph ids can be remapped into local reader anchors and queued reader child events. `App.tsx` rereads settings, library, selected book, chapters, annotations, reading position, Character Graph/voice profiles, and current chapter segments so server manifest/book/position/annotation changes appear without waiting for a reload. The repository reread boundary is isolated in `src/sync/local-connected-refresh.ts` and covered by `src/test/local-connected-refresh.test.ts`, including stale selected-book and stale current-chapter cleanup so synced AI/TTS labels are not reused after the open chapter is removed remotely. Connected provider preflight now flushes local state before enqueue/cache resolve, checks that the selected target is still active after refresh, then compares server book `normalizedTextHash` and requested chapter `textHash` against the local IndexedDB metadata; hosted TTS prefetch uses the same silent attach/hash guard instead of bypassing attachment checks.

- 서버 URL 설정 UI: implemented. Sync panel에서 API URL 입력, `/ready` 테스트, bearer token 저장, 저장 후 reload를 지원한다.
- 서버 manifest pull/cache: implemented. `LocalOutboxSyncService`가 pull cursor 이후 remote events를 적용하고, `book_imported` snapshot은 page batch stream 우선으로 local IndexedDB cache를 갱신한다.
- desktop/mobile shell connected provider runtime: implemented. 저장된 self-host API URL이 있으면 browser/Tauri desktop/Tauri mobile 모두 server provider runtime을 우선 사용하고, native secure-store provider bridge는 서버 client가 없을 때만 local fallback으로 쓴다.
- desktop shell attach/sync 액션: implemented. 같은 sync panel에서 서버 본문 연결, local outbox flush/pull, connected provider attach/hash guard를 사용한다. 현재 Tauri CSP는 user-entered self-host HTTP/HTTPS API 연결을 허용한다.
- 읽은 위치/북마크/하이라이트/메모 background sync: implemented with guardrails. 서버 book content가 없거나 attach 후 chapter/paragraph id가 바뀐 경우 pre-attach child rows는 reject/retry/remap 경로를 탄다.
- 고정 문서 주석 sync: implemented for the v2 event path. Page/text/region annotation update/delete는 로컬
  row·tombstone·outbox를 원자적으로 기록하고, 서버가 book/page ownership과 timestamp conflict를 검증한 뒤
  `document_annotations`에 current state를 반영한다. Pull은 canonical anchor를 검증하고 최신 이벤트만
  적용한다. PDF/page image, OCR/search index와 TTS binary는 event payload에서 제외한다.

### Phase 5: 모바일 준비

Status update - 2026-07-06: provider execution for APK/mobile shells supports both connected-server and Android direct-native paths. When the mobile shell has a self-host sync API URL, `resolveProviderExecutionRuntime()` selects the server provider runtime, so provider settings, encrypted provider secrets, job enqueue/poll, voice discovery, and TTS cache stay on the self-host API/worker side. Without a server provider client, Tauri Android can use the native secure provider runtime: Rust registers `ProviderSecretStorePlugin`, and the synced Kotlin plugin stores provider secrets with Android Keystore + AES-GCM. Android direct mode still excludes file-path based Vertex credentials, and the native JSON command rejects Android `gemini-vertex` execution directly until a document-picker/content-URI credential import flow exists. Workstation APK completion still requires Android SDK/NDK and generated `src-tauri/gen/android`.

- 같은 React reader core를 모바일 Web/PWA에서 먼저 검증.
- APK는 Tauri v2 mobile shell을 사용하며 공개된 Gradle/Rust source를 공통 React reader와 함께 빌드한다.
- 모바일은 local IndexedDB offline reader를 기본값으로 두고, server library/attach/sync는 사용자가 선택한다.

## 하지 말아야 할 것

- 큰 파일을 API JSON body로 통째로 보내기.
- 서버에서 파싱한 전체 본문을 한 응답으로 내려주기.
- `getAll()` 후 클라이언트 필터링 유지.
- `Novel` row에 원문 전체를 계속 저장.
- 현재 화의 모든 문단을 DOM에 렌더링.
- 동기화 충돌을 단순히 silent overwrite로 처리.

## 다음 구현 권장 작업

가장 먼저 해야 할 코드는 서버가 아니라 로컬 대용량 안정화다.

1. IndexedDB 조회를 index cursor로 바꾼다.
2. import를 Worker로 이동한다.
3. `Novel`/`Chapter` 대형 텍스트 필드, legacy paragraph text 중복, local IndexedDB batch write는 v7/v8 이후 축소되었으므로, 다음은 streaming parser/page writer를 붙인다.
4. reader를 virtualized rendering으로 바꾼다.
5. 그 다음 Docker Compose 기반 서버를 붙인다.

## 2026-08-01 PDF reading-order override sync boundary

Connected sync uses `document_text_order_override_updated/deleted` v2 events for page-level reading-order corrections.
The payload is bounded to the page hash, source revision id, ordered/excluded immutable block fingerprints and
timestamps. Source PDF/image bytes, native/OCR text, search indexes and thumbnails never enter this event path.

Local save/reset updates the override, tombstone and outbox atomically. Pull resolves by latest timestamp and retains a
page-aware deletion tombstone. Contract translation rekeys the entity from translated book id plus page index. Hosted
validation requires an existing owned page with the same hash before migration 0029 current-state persistence.

## 2026-08-01 Compose queue durability and interrupted-import recovery

- Redis now uses AOF `everysec` persistence on the `redis-data` volume. PostgreSQL remains the canonical import/job
  state; Redis durability reduces queue loss but does not replace database reconciliation.
- A running import touches `import_jobs.updated_at` every 30 seconds. The worker periodically changes a `processing`
  job back to `queued` only when its upload is still queued and the heartbeat is older than
  `IMPORT_RUNNING_STALE_MS` (default five minutes), then publishes the same database job id to BullMQ.
- The parsed book write remains transactional. Source/embedded objects written before a crash can be overwritten by
  the deterministic retry; broader orphan-object GC remains a separate storage-maintenance concern.
- API and worker share `server-data` for resumable chunks and receive explicit graceful stop windows. All base Compose
  services use restart policies, so a host reboot no longer starts only the worker without its dependencies.
