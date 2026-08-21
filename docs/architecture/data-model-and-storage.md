# 데이터 모델과 저장소

Status: current
Last verified: 2026-08-04

## Hosted original-source download boundary (2026-08-04)

- `book_objects` and MinIO remain the authority for the exact uploaded TXT/Markdown/EPUB/PDF/archive bytes. The
  application does not encrypt, transcode or repackage this source object.
- `GET /api/books/:bookId/source` resolves only an active book owned by the configured user and remains behind the
  server exposure/Bearer-auth policy. Public deployments still require HTTPS; plaintext-at-rest source storage does
  not make the route anonymous.
- Full and single-range responses stream the S3-compatible object body through Fastify with the original content type,
  filename, byte length and source hash. The server no longer assembles the complete source in a Buffer for download.
- Library and chapter-detail actions save the returned bytes under the stored source filename. Trash hides the route,
  and permanent purge retains the existing reference check before deleting the shared object row and MinIO key.

## Native compact speaker workflow extension (2026-07-13)

- Native workflow schema v3 persists logical job identity, job type and contract fingerprint separately from provider
  input. Compact speaker jobs accept only `native-structured-json-batch-v1`, never an embedded/single rich request.
- Each packet unit keeps a stable ID, packet fingerprint, request hash, status, attempt and claim fence. Successful
  unit prompts are removed during compaction; output hash and bounded provider execution metadata remain. Restart
  requeues only the interrupted unit and stale claims cannot commit late results.
- Review converts unfinished units to resumable cancelled state while preserving only the provider input required to
  continue. Approval restores those units to the queue; final cancellation removes their request bodies. Completed
  logical windows and their aggregate checkpoints are not replayed.
- `NativeSpeakerWorkflowArtifactPayloadV1` stages only canonical labels, sequence records, risk routes, dependency IDs,
  accepted provenance drafts and bounded batch metadata. Source text, prompt and secret values are not copied into the
  staged payload.
- Promotion uses one IndexedDB transaction for generated segments, sequence decisions, one L3 artifact dependency and
  active/superseded accepted provenance. Correction overlap and manual review replace the same paragraph scope, so a
  retry cannot leave labels and provenance at different revisions.

## Reader product W3 library extension (2026-07-13)

- IndexedDB v23 adds indexed `shelves`, `shelf_memberships` and `library_operation_receipts`; `Novel` stores
  normalized application metadata and active cover references separately from immutable source metadata.
- Cover images are decoded and bounded before storage. Logical cover assets reference hash-deduplicated Blob rows;
  pull-side binary caching never emits a second sync event.
- PostgreSQL 0019 adds matching metadata columns, private `book_assets`, shelves/memberships and operation receipts.
  Hosted cover bytes live in object storage and catalog queries can filter by shelf with bounded cursor results.
- Shelf updates/deletes and additive membership events are versioned sync entities. Cover mutations push binary after
  accepted metadata events and pull the server cover into the local asset cache.
- Local and Hosted backups include metadata, cover bytes, shelves and membership. Generated thumbnails, search and
  pagination caches remain excluded.

## Reader product W1 local asset/lifecycle extension (2026-07-13)

- IndexedDB schema v20 adds `book_assets` for logical revision-scoped asset metadata and
  `book_asset_blobs` for hash-deduplicated physical Blob storage.
- Browser import passes the existing worker-side `File` into source staging without another text or
  `ArrayBuffer` copy. Source activation is fenced by the same content revision activation transaction;
  failed/cancelled imports remove staged refs and unreferenced Blobs.
- `Novel.sourceAssetId` and denormalized provenance/size/type/hash fields support fast catalog and book-info
  rendering. The asset record remains authoritative for download.
- `Novel.deletedAt`, `deletedByDeviceId`, and `metadataRevision` represent soft-delete lifecycle. Normal
  catalog queries exclude deleted books. Restore only clears lifecycle metadata; purge alone cascades child
  rows and asset refs, deleting a physical Blob only when no logical asset references it.
- Source assets and trash state are durable user data. They are backup/sync inputs, unlike generated audio,
  search indexes, and pagination caches.
- PostgreSQL 0017 adds `metadata_revision`, `deleted_at`, and `deleted_by_device_id` to `library_books` with
  partial active/trash indexes. Existing `book_objects` remain the physical source store and active content
  revisions retain source identity. Hosted purge removes the object row and S3 object only when no book references
  it; lifecycle sync events prevent older metadata updates from silently reviving a trashed book.
- IndexedDB v21 adds `backup_restore_runs`. Local backups contain allowlisted durable stores and source Blobs in a
  versioned ZIP, while provider secrets, auth tokens, raw jobs, generated audio and search/pagination caches are
  excluded. Restore validates every path/hash/size before one read-write transaction, rebuilds paragraph search,
  and records completed/failed run status. Copy conflicts rekey book/content/annotation identities while sharing
  content-addressed physical source Blobs.
- Hosted backups serialize allowlisted book/user tables plus referenced `book_objects` bytes. Export snapshots the
  database at repeatable-read, streams ZIP entries without assembling the final archive in the browser, and restore
  applies skip/replace/copy in one PostgreSQL transaction. Provider secrets, request/job logs, generated audio and
  derived indexes remain excluded.
- Legacy local books can bind a byte-identical user-reselected original after raw hash verification. If the original is
  unavailable, a UTF-8 `canonical_reconstruction` is generated from the active revision's chapter/paragraph pages and
  never represented as an original source.
- IndexedDB v22 adds `chapter_structure_drafts`, `chapter_structure_receipts`, and `chapter_structure_review`.
  Drafts retain commands and bounded impact summaries rather than another full book body. Receipts point at previous
  and activated content revisions; the existing revision-scoped chapter/page stores are the rollback source.
  Unmapped user corrections are retained as review records, while reproducible labeled segments are invalidated.

## Reader product W2 Hosted structure extension (2026-07-13)

- PostgreSQL 0018 adds per-user `chapter_structure_drafts`, versioned snapshot receipts and durable review items.
- Preview pins the active content revision and original source object. Apply and rollback create a new
  `book_content_revisions` row and activate it with an expected-active-revision CAS inside one transaction.
- Chapter replacement is differential: surviving chapter IDs are updated, new IDs are inserted and only removed IDs
  are deleted. This avoids cascading unrelated chapter analysis/TTS data during a local structure edit.
- Paragraph identity remaps reading positions, bookmarks, highlights, notes, labeled segments, user corrections,
  label-mutation operation/invalidation/reanalysis rows and Character Graph evidence. Unmapped user-authored rows are
  copied into chapter-structure review payloads rather than silently discarded.
- Structurally affected TTS audio rows become stale with bounded GC eligibility. Active AI jobs/workflows are
  cancelled, affected review/context/render data becomes obsolete, and the active Character Graph is cleared for
  review. A `book_imported` snapshot signal makes connected clients refetch the new chapter/page snapshot.
- Hosted backup includes structure receipts and review items; drafts remain temporary and are excluded.

## Domain Types

위치: `packages/contracts/src/domain.ts`, frontend re-export `src/domain/types.ts`

주요 모델:

- `Novel`
- `Chapter`
- `Paragraph`
- `ReaderSettings`
- `Bookmark`
- `ReaderHighlight`
- `ReaderNote`
- `Character`
- `VoiceProfile`
- `LabeledSegment`
- `UserCorrection`
- `ParsedNovel`
- `BookFormat`
- `ReaderAnchor`
- `ReaderDocumentSection`
- `ReaderDocumentBlock`
- `ReaderDocumentBlockPage`

W0부터 `Novel.format`은 신규 TXT/Markdown import에서 기록되며 기존 row와 remote snapshot 호환을 위해
optional이다. `ReadingPosition.anchor`도 optional compatibility field다. 기존 paragraph 위치는
`reader-document-repository.ts`의 adapter로 section/block anchor에 투영한다. EPUB block 저장과 anchor
dual-write는 W6 범위이며 현재 IndexedDB schema는 아직 바꾸지 않았다.

Domain type 호환을 위해 `Novel.rawText`, `Novel.normalizedText`, `Chapter.normalizedText` 필드는 남아 있다. IndexedDB 저장 경계에서는 이 큰 문자열 필드를 빈 문자열로 저장하고, 실제 reader 본문은 `paragraph_pages`에서 읽는다. `paragraphs` store는 legacy API 호환을 위한 lightweight ref로 유지하며 신규 저장에서는 본문을 중복 저장하지 않는다.

## IndexedDB

위치: `src/storage/reader-database.ts`

```text
DB_NAME: noveldesk-reader
DB_VERSION: 22
```

Stores:

```text
novels
chapters
paragraphs
paragraph_pages
paragraph_search
book_content_revisions
book_content_chapters
book_content_paragraphs
book_content_paragraph_pages
book_content_paragraph_search
book_content_domain_heads
bookmarks
highlights
notes
settings
segments
characters
character_relations
voice_profiles
corrections
devices
reading_positions
sync_outbox
sync_tombstones
sync_state
id_migration_runs
id_mappings
id_migration_stage
id_migration_quarantine
native_analysis_workflows
native_analysis_workflow_descriptors
native_analysis_staging
native_analysis_provenance
```

Indexes:

- `novels`: `updatedAt`, `title`
- `chapters`: `novelId`
- `paragraphs`: `novelId`, `chapterId`, `chapterId_index`
- `paragraph_search`: `novelId`, `chapterId`, `paragraphId`, `chapterId_paragraphIndex`
- `bookmarks`: `novelId`, `chapterId`
- `highlights`: `novelId`, `chapterId`, `paragraphId`
- `notes`: `novelId`, `chapterId`
- `segments`: `novelId`, `chapterId`
- `characters`: `novelId`
- `character_relations`: `novelId`, `sourceCharacterId`, `targetCharacterId`
- `voice_profiles`: `novelId`, `novelId_role`
- `corrections`: `novelId`, `chapterId`
- `devices`: `updatedAt`
- `reading_positions`: `novelId`, `chapterId`, `updatedAt`
- `sync_outbox`: `status`, `createdAt`; records also carry `localSequence` for queue order.
- `sync_tombstones`: `entityType`, `entityId`, `novelId`, `deletedAt`
- `sync_state`: none
- `native_analysis_workflows`: `novelId`, unique `workflowId`
- `native_analysis_workflow_descriptors`: `novelId`, unique `workflowId`, `contentRevisionId`
- `native_analysis_staging`: `novelId`, `workflowId`, `jobId`, `status`, unique workflow/job/output hash
- `native_analysis_provenance`: `novelId`, `workflowId`, `jobId`, unique artifact and workflow/job/fence promotion identities

## IndexedDB v13 ID/hash migration

IndexedDB v13 adds only four small migration metadata stores in `onupgradeneeded`. It does not rewrite book content in the version-change transaction. After the database opens, `runIdV2MigrationsInDatabase()` migrates legacy parser-v1 books one at a time under an IndexedDB lease:

1. Derive the parser-v2 novel/chapter/paragraph/page IDs and tagged SHA-256 hashes.
2. Persist book-scoped mappings and transformed/rollback records in bounded batches.
3. Verify content counts, ownership, page continuity, hashes, and reader/AI/TTS/sync anchors.
4. Activate all transformed stores and remove the visible v1 rows in one transaction. Rollback copies remain in migration staging for one compatibility generation.

Interrupted `staging` and `ready` runs resume from their persisted checkpoint. Invalid or unverifiable data quarantines only that book and leaves its v1 rows readable. A migrated `sending` outbox row is reset to `pending` without losing sequence or attempt metadata. Existing v2 books and non-parser legacy IDs continue through the normal v11/v12 dual-read paths. Reader references may contain a mixture of v1 IDs and already-canonical v2 IDs; the mapping registry accepts a verified v2 target as a self-anchor instead of quarantining the book.

`openReaderDb()` intentionally waits for pending v13 book cutovers before returning, so callers never observe a partially rekeyed graph. Source rows are loaded in one readonly bulk transaction, while plan construction yields between chapter, paragraph, page, and rollback-manifest batches. Staging also yields between bounded write batches. Lease renewal is time-based and is forced immediately before atomic cutover. A transient storage/lease failure is deferred rather than quarantining valid data, and an expired cross-tab lease can be taken over.

`getIdV2MigrationProgress()` and `subscribeIdV2MigrationProgress()` are public exports of `src/storage/db.ts`; importing and subscribing does not open IndexedDB. Bootstrap code can therefore subscribe before calling `openReaderDb()` or awaiting its first repository read and show migration progress instead of a blank startup. The current task intentionally does not connect this contract to App/UI code.

`resolveCanonicalNovelIdentity(sourceFileName, normalizedTextHash)` uses the v13 identity mapping so importing the same file resolves to the migrated canonical book. Book-scoped workflow and upload-resume localStorage keys are moved after activation and moved back on a safe rollback.

## IndexedDB v14 native analysis promotion

IndexedDB v14 adds native workflow fence, staged output, and promotion provenance stores. A provider checkpoint is not written directly to canonical Character Graph or labeled segment stores. The promotion transaction rechecks the active content revision, workflow fence and plan hash, graph and correction fingerprints, planned paragraph IDs, and output hash before changing canonical rows.

Graph promotion preserves user-confirmed characters. Label-window promotion replaces only planned paragraphs, preserves sibling windows and user-corrected segments, then deterministically renumbers the chapter. Canonical rows, one sync outbox event, staged status, and provenance commit in the same transaction. A second output for the same workflow job fence is rejected, while replaying the already-promoted artifact returns its existing provenance without another outbox event. Book deletion and pulled `book_deleted` events clear all three native stores with the rest of the book-scoped data.

## IndexedDB v15 native workflow descriptor

IndexedDB v15 adds `native_analysis_workflow_descriptors` as the authoritative browser-side companion to the Rust journal. It stores workflow/novel/content-revision identity, the complete deterministic plan, plan hash, non-secret provider/model/options and a descriptor fingerprint. Identical retries are idempotent; descriptor drift for an existing workflow is rejected.

Provider secret values are never accepted by this store and descriptors are not written to sync outbox. Native restore reopens the exact content revision and verifies the descriptor before rebuilding a provider request or promoting a checkpoint. Local and pulled book deletion remove descriptors in the same book-data transaction as the remaining native analysis stores.

## IndexedDB v16 reader anchor quarantine

IndexedDB v16 adds `reader_anchor_quarantine` for same-id content replacement. The replacement planner pins the previous content revision, builds old/new child indexes, and remaps only chapter-index plus paragraph-index plus canonical text-hash matches. Unmatched reading positions, bookmarks, highlights, notes, and anchor mutations leave active stores and retain their original payload and revision provenance in quarantine. Chapter-only legacy anchors are not treated as exact.

## IndexedDB v18 Character Graph v2

IndexedDB v18 adds normalized stores for character facts, mentions, directional address terms,
speech traits, relation facts, evidence, merge candidates, ID redirects, and identity-operation
receipts. Empty v2 knowledge is lazily backfilled from legacy characters/relations; generic references
become candidate mentions instead of global aliases. Observation saves derive exact-match review
candidates, while merge/split commands replace graph knowledge, canonical graph, affected segments,
voice profiles, sync events, redirects, invalidation and receipt in one transaction.

Hosted PostgreSQL migration `0013_character_graph_v2_facts_and_redirects.sql` mirrors these aggregates
with hot-query indexes and legacy backfill. Hosted reads remain dual-read and identity commands use the
same provider-neutral planner as IndexedDB.

## IndexedDB v25 / PostgreSQL 0022 speaker attribution inventory

Speaker attribution derived data is separate from canonical Character Graph and accepted labels. IndexedDB v25 adds
`speaker_source_manifests`, chapter inventory metadata, scene/span/dialogue-burst, mention, provisional/ephemeral
entity and address-event stores. A chapter rebuild deletes and replaces every row for the same content revision and
chapter in one transaction. A revision invalidation removes only these reproducible rows. Book purge and backup
replace cleanup include all speaker stores so derived rows cannot outlive their source book.

PostgreSQL `0022_speaker_attribution_pipeline.sql` mirrors the aggregate with typed hot-query columns plus JSONB
payloads. Child rows reference `speaker_chapter_inventories` with cascade deletion, and the Hosted store bulk-inserts
each row family inside the caller transaction. User/book/revision ownership is checked before writes. Both stores
reassemble the inventory and reject a row set whose aggregate fingerprint changed.

These stores contain source hashes, UTF-16 paragraph-local offsets, normalized mention surfaces and derived IDs, but
not duplicated span text, provider raw output, prompt text or secrets. Candidate Memory is rebuilt from current Graph
v2 data and these rows; it is not another durable graph. Same-revision provisional rows can be read across chapters
and coalesced by source surface for candidate memory, while canonical promotion still requires independent span
evidence or a user action.

## IndexedDB v26 / PostgreSQL 0023 temporal character memory

Temporal memory is layered above the C2 inventory without creating another canonical character graph. IndexedDB v26
adds `temporal_address_events`, `temporal_relation_edges`, and `character_temporal_snapshots`. Event and edge writes are
append-only: an existing ID is accepted only when its fingerprint matches. Superseding rows identify the prior event or
edge, while active reads hide rejected and superseded revisions. Chapter snapshots are reproducible derived rows and are
replaced atomically by content revision and chapter.

PostgreSQL `0023_temporal_character_memory.sql` mirrors these boundaries with ownership-scoped event, edge, interval,
scene, and reader-mode indexes. The Hosted service uses the same active-revision resolver and atomically replaces a
chapter's snapshots. Derived temporal rows remain outside normal sync. They contain normalized address surfaces and
hashes but no span text, provider response, prompt, or secret.

## PostgreSQL 0014 provider capability snapshots

Migration 0014 adds deduplicated `provider_capability_snapshots`, active-versioned
`provider_confidence_calibrations`, nullable legacy-compatible capability/task/admission copies on
`analysis_input_revisions`, and provider-job snapshot links. New input revisions always materialize a
safe snapshot; old rows synthesize conservative snapshots on read. Secret values and raw provider payloads
are not part of these records.

Reader remap/quarantine, exact outbox pending-count recalculation, content head activation, previous revision supersession, and `book_imported` enqueue commit in one transaction guarded by the base content revision and sync sequence. Exact reader mutations already marked `sent` are re-enqueued with a fresh event ID/sequence so hosted replacement can restore them; `sending` mutations are quarantined and replaced instead of mutating a possibly deduplicated event ID. Remote hydration keeps the newer reading position by `updatedAt`. Book deletion removes quarantine records. Recovery UI for inspecting or restoring quarantined reader data is not implemented yet.

Hosted replacement takes an exclusive book-row lock, quarantines active reader rows, and clears them before revision activation. Sync push takes a shared lock before anchor validation, so a concurrent push either commits before replacement and is then quarantined or observes the activated revision. Reader events created before that activation are rejected as stale; a local exact remap uses a fresh revision timestamp and can restore the row afterward.

## Hosted PostgreSQL ID/hash migration

`0004_id_hash_v2_expand.sql` is an expand-only schema migration. It adds contract columns, resumable run/checkpoint tables, v1-to-v2 alias tables, rollback material, and quarantine tables without performing a data rewrite during API/worker startup. The migration also expands the legacy monolithic `identity_contract_metadata` shape before referencing its new `status` column.

The deliberate `server:id-v2-migrate` CLI runs provider/global-sync and book backfills. Its identity adapter delegates to the shared `src/domain/identity` factories. A book run snapshots and verifies source text, stages aliases, rekeys the book graph in one PostgreSQL transaction, remaps relational and nested JSON/hash references, and quarantines stale TTS cache rows. Provider settings, encrypted provider secrets, and bookless sync events use a user-scoped resumable run. Queued/running import or provider work defers cutover and resumes the same run after work drains.

Rollback is allowed only while the activated database snapshot still matches the recorded state hash and no active work exists. It restores exact v1 rows and external upload/import references from `id_v2_migration_backups`; otherwise the command requires forward recovery. The identity metadata becomes `active` only after no legacy book/provider/sync contract rows remain.

## Current Repository Functions

현재 `db.ts`는 low-level IndexedDB 함수 단위 API를 export한다. UI/controller는 `LibraryQueries`, `ReaderQueries`, `ReaderCommands`, `AnnotationRepository`, `AnalysisArtifactRepository`, `NativeAnalysisWorkflowRepository`, `SyncRepository`, `BulkBookSource` 중 필요한 port만 사용한다. `ReaderRepository`는 목적별 port aggregate이며 local/remote 구현이 같은 reader query contract suite를 통과한다. Backend별 차이는 `capabilities`로 드러내고 unsupported mutation은 성공처럼 반환하지 않는다.

- import: `saveImportedNovel`
- novels: `getNovels`, `getNovel`, `patchNovelMetadata`, `deleteNovel`
- reading positions: `getReadingPosition`, `saveReadingPosition`, `clearReadingPosition`
- chapters: `getChapters`, `getChapter`
- paragraphs: page reads `getParagraphPage`, cancellable cursor page search `searchParagraphPage`, AbortSignal-aware bulk `iterateParagraphPages`; materialized list/search helpers are storage-internal or revision-pinned adapters only
- settings: `getSettings`, `saveSettings`
- bookmarks: `getBookmarks`, `saveBookmark`, `deleteBookmark`
- highlights: `getHighlights`, `saveHighlight`, `deleteHighlight`
- notes: `getNotes`, `saveNote`, `deleteNote`
- AI/TTS data: `getSegments`, `saveSegments`, `getCharacters`, `saveCharacters`, `getCharacterRelations`, `getVoiceProfiles`, `saveVoiceProfiles`, `getCorrections`, `saveCorrection`
- native analysis: promotion snapshot, workflow fence save, output stage/promote, promotion provenance list. IndexedDB repository methods lazy-load this implementation.
- sync: `listSyncOutbox`, `getSyncState`

## AI/TTS Storage Direction

기준 문서: [AI/TTS Provider, Job, Cache, Security 설계](ai-tts-provider-job-cache-security.md)

현재 구현된 저장소:

- Local IndexedDB: `segments`, `characters`, `character_relations`, `voice_profiles`, `corrections`, `native_analysis_workflows`, `native_analysis_staging`, `native_analysis_provenance`, `reader_anchor_quarantine`
- Repository contract: `listSegments`, `saveSegments`, `listCharacters`, `saveCharacters`, `listVoiceProfiles`, `saveVoiceProfiles`, `saveCorrection` and the native staging/promotion methods
- Hosted PostgreSQL: `characters`, `character_aliases`, `character_relations`, `analysis_runs`, `chapter_contexts`, `voice_profiles`, `labeled_segments`, `user_corrections`, `provider_jobs`, `tts_audio_cache`, `provider_settings`, `provider_secrets`
- Hosted API routes: characters, voice profiles, labeled segments, user corrections, provider job enqueue/status.
- Sync events: `voice_profiles_updated` replaces a book's voice profile collection, `user_correction_created` upserts a manual correction, `character_graph_updated` syncs generated/user-authored graph snapshots, and `chapter_segments_updated` syncs generated/user-authored chapter label snapshots. Audio cache rows are not synced.
- Hosted API routes also expose provider catalog, provider settings, provider secret set/delete/test/status, TTS voice discovery, and TTS cache resolve/audio boundaries; TTS job enqueue is guarded until a non-system synthesis provider is implemented, enabled, and configured.
- Remote repository/client: hosted characters/voice profiles/segments/corrections now persist through `RemoteApiClient`; provider catalog, provider settings, TTS cache resolve, and cached audio fetch are available on the remote client.
- Hosted provider settings UI: remote mode can load/save LLM labeling and TTS synthesis default provider, enabled provider subset, model override, and non-secret option JSON through `RemoteApiClient`. Provider secrets use a separate `ProviderControlClient` set/delete/test boundary, and browser state keeps only draft input plus returned status/fingerprint/last4 while the field is visible.
- Hosted worker: mock `chapter_segment_labeling` jobs persist generated characters, labeled segments, analysis run rows, and `library_books.analysis_status`.
- Hosted worker: `tts_synthesis` jobs for `openai-tts`, `elevenlabs`, `gemini-tts`, `gemini-vertex-tts`, `google-cloud-tts`, and `local-endpoint` reconstruct text from `labeled_segments` plus `paragraph_search`, verify `inputTextHash`, write audio objects, and upsert `tts_audio_cache`.
- Provider job route now records a budget estimate in `provider_jobs.progress`, includes prompt/schema version in the input hash, and rejects chapters over `AI_LABELING_MAX_INPUT_CHARACTERS` before enqueue.
- Gemini Vertex adapter foundation validates provider JSON before writing segments, so invalid offsets or malformed enum values fail at the provider boundary rather than corrupting storage.
- Local `saveSegments()` and `saveCharacters()` replace previous rows for the target chapter/book in one IndexedDB transaction so stale labels/characters do not survive a smaller or empty LLM/Mock result.
- Local `saveCharacters()` queues `character_graph_updated`, local `saveSegments()` queues `chapter_segments_updated`, local `saveVoiceProfiles()` queues `voice_profiles_updated`, and local `saveCorrection()` queues `user_correction_created`.
- Annotation and AI/TTS mutation commands accept an expected canonical resource revision. Local stores compare it in the same IndexedDB transaction as the data/tombstone/outbox write. Hosted routes compare it after acquiring the replacement-compatible book lock and keep the canonical write plus sync event in the same PostgreSQL transaction. A mismatch returns a resource conflict instead of overwriting newer state.
- Revision canonicalization sorts aggregate rows by id, hashes Character Graph characters and relations together, excludes storage-managed voice profile timestamps, parses correction JSON before hashing, and normalizes hosted annotation rows to client domain names and ISO timestamps.

현재 없는 저장소:

- Local `analysis_runs`
- Local provider job/cache stores
- Persistent local/hosted TTS audio prefetch store

다음 구현에서는 retry/cancel policy와 persistent TTS prefetch store 또는 bulk warmup policy를 붙인다. Provider settings 저장/API/UI는 이미 있으므로 계속 default provider, enabled provider subset, model override, non-secret provider options만 편집해야 한다. API형 LLM/TTS provider는 현재 job queue/worker 경계 위에 추가하고, UI가 provider별 request body를 직접 만들지 않게 유지한다.

## Known Limitations

Current v16 note: local storage maintains revision-scoped content, authoritative native workflow descriptors, native analysis staging/provenance, reader-anchor replacement quarantine, `paragraph_search` rows for paragraph lookup/body search, `voice_profiles` rows for TTS voice mapping, and `character_relations` rows for synced Character Graph relationships. Search uses the `chapterId_paragraphIndex` cursor first, then falls back to `paragraph_pages` cursor scan or legacy paragraph cursor only when search rows are absent.

- chapter, paragraph, paragraph page, bookmark, highlight, note, segment, character 조회는 IndexedDB index 기반으로 변경되었다.
- 새 import는 `paragraph_pages` store에 chapter별 paragraph page를 저장하고, `paragraphs` store에는 `pageIndex`가 포함된 lightweight ref만 저장한다.
- 새 import와 v7 migration은 `Novel.rawText`, `Novel.normalizedText`, `Chapter.normalizedText`를 metadata-only 빈 문자열로 만든다.
- v8 migration은 page-backed 기존 `paragraphs` row의 `text`를 비우고 page ref로 축소한다. `paragraph_pages`가 없는 오래된 데이터는 legacy fallback을 위해 보존한다.
- indexed `searchParagraphPage()`는 `paragraph_search.chapterId_paragraphIndex` cursor를 bounded row/text slice로 훑는다. 각 page는 opaque query-bound cursor를 반환하고 chapter 200/book 300 hard limit을 누적 적용한다. Abort 시 active IndexedDB transaction을 중단하며, `paragraph_search`가 없는 legacy chapter만 page cursor 또는 paragraph index cursor fallback을 사용한다.
- `getNovels`는 책장 전체 목록을 표시하기 위해 전체 `novels` store를 읽는다.
- import/save/progress/delete/bookmark/highlight/note/settings mutation은 data 변경과 local outbox insert를 같은 IndexedDB transaction에 묶는다.
- Resource-level stale-write CAS is implemented for direct annotation/correction and Character Graph/chapter segment/voice profile replacement paths. The protocol still permits an omitted expected revision for legacy/internal callers, and correction metadata plus its edited segment are not yet one compound atomic command.
- `VoiceProfile`은 local/hosted 저장과 repository boundary가 있다. 외부 provider secret은 profile에 저장하지 않고, provider id/model/voice id/options만 저장한다.
- `provider_secrets`는 hosted-only encrypted secret table이다. It is keyed by `user_id`, `scope`, `provider_id`, and `secret_name`, stores AES-GCM ciphertext/iv/auth tag/key version/fingerprint/last4, and is excluded from sync events and browser settings payloads.
- local corrections are exposed through `AnalysisArtifactRepository.listCorrections()` and its compatibility facade.
- provider job/cache/settings/secret table은 hosted schema에 있고 mock analysis job enqueue/status/worker plus OpenAI/Gemini/Claude adapter foundations까지 연결됐다. `provider_settings`는 user default/model/non-secret options만 저장하고, `provider_secrets` or env secret availability가 actual provider readiness를 결정한다. Remote mode add-on UI가 settings와 secret status를 분리해 편집한다. `tts_audio_cache`는 provider/audio metadata 컬럼, cache resolve route, `openai-tts`/`elevenlabs`/`gemini-tts`/`gemini-vertex-tts`/`google-cloud-tts`/`local-endpoint` synthesis worker write path, authenticated audio read route, reader cache playback path, active source-range highlight, and small in-memory next-segment/next-paragraph prefetch를 갖는다. Gemini Vertex TTS live smoke has passed; persistent/bulk prefetch store and other external provider live smokes remain pending.
- sync outbox는 local pending queue, configured server push/flush, cursor pull, remote event apply, remote `book_imported` manifest/chapter/page cache hydration까지 구현되어 있다. 각 local outbox event는 entity type/id, local sequence, updated/deleted timestamp, payload hash를 담은 optional `revision` metadata를 가진다. Hosted `sync_events`는 server push event뿐 아니라 direct hosted reader mutation과 server import가 생성한 이벤트에도 nullable `revision jsonb`를 저장하고 cursor pull response로 돌려준다. `reading_position_updated`, `settings_updated`, `book_updated`처럼 마지막 값이 전체 상태를 대표하는 event는 서버 push 전에 같은 entity의 이전 pending/failed row를 `sent` 처리해 최신값만 전송한다. `sync_tombstones`는 remote delete 이후 늦게 도착한 bookmark/highlight/note create/update가 로컬 캐시를 되살리는 것을 막는다. sync detail panel은 offline/failed/conflict 상태, outbox row, local revision label을 표시하지만, entity-level conflict resolution UI와 full merge UI는 아직 없다.
- reading position은 paragraph/offset 모델로 별도 저장되고 reader 복원의 primary source로 사용된다. 기존 `Novel.lastRead*` 호환 필드는 fallback과 책장 진행률 표시에 남아 있다.
- `rawStartOffset`/`rawEndOffset` 이름은 원본 byte offset처럼 보이지만 실제로는 normalized string offset에 가깝다.
- 신규 parser/content persistent IDs는 domain-separated SHA-256 기반 128-bit 계약을 사용한다. `hashSync`는 cosmetic/ephemeral ID와 v1 compatibility verification에만 남아 있으며, 아직 v2로 전환되지 않은 annotation/AI/TTS/sync 신규 writer는 후속 sync-contract slice에서 정리한다.
- `paragraphs` store는 아직 row 수 자체가 남아 있다. 본문 text 중복은 제거됐지만 paragraph id 직접 조회 호환을 위해 page ref row를 유지한다.

## Local IndexedDB Search

Local IndexedDB storage now maintains a `paragraph_search` object store next to `paragraph_pages`. Rows are keyed by page id plus paragraph index and store `paragraphId`, `chapterId`, `pageIndex`, `paragraphIndex`, lowercased text, and the original paragraph payload.

`getParagraph()` checks `paragraph_search` before falling back to the legacy `paragraphs` ref plus page lookup. `searchParagraphPage()` scans the `chapterId_paragraphIndex` cursor first, so chapter/body search no longer expands every `paragraph_pages.paragraphs` JSON array when search rows are available. A page scans at most 256 rows or 2MiB of indexed text, yields between cursor slices, and aborts its active transaction through the caller signal. The page cursor and legacy paragraph cursor remain compatibility fallback paths for older data.

Lifecycle coverage:

- v9 migration backfills `paragraph_search` from existing `paragraph_pages`.
- local import, import-ready parser save, and remote snapshot hydration write rows in the same page-batch path as `paragraph_pages`.
- cancelled imports, cancelled replacement restore, completed replacement cleanup, remote cache refresh, remote book delete, and local book delete remove stale search rows by `novelId`.

## Hosted PostgreSQL Search

Hosted server imports store reader body pages in `paragraph_pages` and also maintain a `paragraph_search` table. Each row is keyed by page id plus paragraph index and stores paragraph id, book id, chapter id, page index, paragraph index, original paragraph JSON, and lowercased text. Migration performs a one-time backfill from existing `paragraph_pages` only when `paragraph_search` is empty; new imports upsert it while page batches are written.

Search routes use this table:

- `/api/paragraphs/:paragraphId`
- `/api/books/:bookId/search`
- `/api/chapters/:chapterId/search`

`pg_trgm` backs the `text_lower` GIN index so hosted searches avoid repeatedly expanding `paragraph_pages.paragraphs` JSON for every query. Legacy `limit` requests still return the existing paragraph array. New `pageSize` requests use chapter/book keyset cursors bound to scope, target, and normalized query, return `nextCursor`/`capped` diagnostics, and enforce the same 200/300 cumulative hard limits. `RemoteSearchTransport` passes the caller `AbortSignal` to fetch and validates the paginated response before the repository sees it.

## Hosted Analysis And Replacement Revisions

PostgreSQL migration `0006_analysis_revisions_book_replacement.sql` introduces the hosted revision lifecycle:

- `book_content_revisions` owns immutable source object/raw/normalized hash provenance. A replacement target starts as `preparing`; one partial unique index permits only one `active` revision per book.
- `character_graph_revisions` pins each graph snapshot to a content revision. Its `source_input_revision_id` and `source_artifact_id` foreign keys are added after the cyclic analysis tables exist.
- `analysis_input_revisions` is update-guarded and pins content/fence, source object/hashes, graph revision/fingerprint/snapshot, correction fingerprint/snapshot, request profile/prompt/schema, provider/model/options fingerprint, window paragraph ids/text hashes, Episode Context, and optional TTS voice/render spec.
- provider results enter `analysis_staging_artifacts`; a promotion transaction locks the book, rechecks expected content/graph/fence/corrections, writes canonical entities and provenance, marks the artifact promoted, and completes the attempt-fenced job.
- `analysis_episode_contexts` is keyed by workflow/chapter/window sequence. The next window receives the prior active context; the final window is marked as the chapter aggregate and also updates `chapter_contexts`.
- `book_replacement_runs` and `book_revision_quarantine` retain invalidation/remap evidence. Generated graph/segments/context/cache/run/artifact state is stale or quarantined, queued/running work is fence-cancelled, and only unique exact paragraph/hash anchored user-confirmed data is remapped.

Replacement activation is a single transaction: old active content becomes `superseded`, target `preparing` becomes `active`, and `library_books` advances its content pointer, graph pointer, revision number, and fence only when the expected old pointer/fence still match. A stale worker therefore cannot promote over replacement content.

## Speaker Workflow Lineage

IndexedDB v27 and PostgreSQL migration `0024_speaker_workflow_lineage.sql` add derived compact-speaker state:

- immutable per-window `speaker_sequence_decisions` merged without deleting sibling windows;
- `speaker_artifact_dependencies` with monotonic active-to-stale transitions and explicit L0-L4 scope;
- reader-time-bounded `speaker_identity_edges` and `speaker_voice_identities`;
- native workflow descriptor/journal contract fingerprints for restart-safe rich/compact separation.

These rows do not duplicate source text and are excluded from normal sync. Review promotion recreates staging
dependencies against the promoted artifact and retires the source lineage. Speaker/listener/type corrections stale
speaker and voice levels; emotion/prosody-only edits stale only voice delivery. Book purge removes all derived rows,
while user corrections, canonical labels/graph and pinned voice profiles remain owned by their existing stores.

IndexedDB v28 and PostgreSQL migration `0025_accepted_speaker_provenance.sql` add an artifact-versioned
`accepted_speaker_provenance` sidecar for promoted labels. Each row pins segment/source-span/scene/burst order,
`speakerEntityId`, legacy canonical `speakerId`, source manifest, optional packet/snapshot/sequence decision and the
promotion artifact. Scoped promotion supersedes only active rows for the promoted paragraphs and keeps earlier rows as
history. Automatic and manual review promotion use the same contract; an emotion-only review preserves the prior
speaker entity, while an actual speaker edit resolves through the pinned canonical graph mapping. These rows contain
no source text and are excluded from normal sync. Local/native can regenerate them from pinned compact inputs, while
Hosted persists them in the promotion transaction. This is the identity input for S8; importance, trait and pool
assignment are not stored here.

## Next Storage Direction

v13 storage includes metadata-only novel/chapter rows, revision-scoped `paragraph_pages`/`paragraph_search`, page-backed paragraph refs, reader/AI/TTS data, lease-protected sync outbox, and resumable ID/hash migration metadata. The next identity step is PostgreSQL backfill plus a versioned v1/v2 sync translation contract; the next storage cleanup is replacing the remaining legacy `paragraphs` ref rows when the repository boundary no longer needs them.

```text
novels           metadata only
chapters         chapter metadata only
paragraph_pages  page-sized text chunks
paragraph_search direct paragraph lookup/search rows
reading_positions
sync_outbox
sync_tombstones
devices
sync_state
```

UI는 `src/storage/db.ts`를 직접 호출하지 말고 `ReaderRepository` interface 뒤에서 읽어야 한다.

## S8 Voice Casting Storage

IndexedDB v29 adds `voice_casting_states`. One row per book stores a revisioned workspace split into user-authored
artifacts and rebuildable derived artifacts. Save uses storage-revision CAS and enqueues `voice_casting_updated` in the
same transaction. Accepted utterance source remains anchored to the active content/provenance stores; narrator/system
rows are not castable entities.

PostgreSQL migration `0026_voice_casting.sql` adds the matching `voice_casting_states` row with
`user_authored_payload`, `derived_payload`, `state_payload`, content revision and storage revision. Hosted API writes
take the book lock and expected revision before replacing the row. TTS reads join the active content revision and reject
stale or provider-incompatible assignments.

Sync transports only user-created pools, pinned overrides and user trait evidence. A remote update clears Hosted
derived/state to staging and marks Local workspaces stale; neither side reuses an old automatic assignment before
recompute. Provider secrets and generated audio are outside this payload.

Local exact backup includes voice casting plus the accepted speaker/temporal/workflow lineage needed to reproduce its
binding. Local copy omits immutable speaker-derived and voice-casting rows. Hosted backup archives the user projection,
but restore intentionally replaces derived/state with empty staging data against the restored active source; Hosted
copy omits voice casting. All import/export paths reject secret-like keys and values.

The current workspace/source API projects a complete target book. This is acceptable for the product's practical
20MB-or-smaller text scope; chapter cursor/paged projection is a later optimization only if measured usage shows a
browser or server memory problem.

## PDF reading-order user data

IndexedDB v32 adds `document_text_order_overrides`, uniquely indexed by `(bookId, pageIndex)`. The row stores source
block fingerprints, user order, explicit exclusions and source revision/page provenance. It is user-authored projection
data: original PDF bytes and rebuildable `document_text_blocks` stay unchanged. Normal reads/search/TTS apply the row;
annotation remap and OCR quality checks request raw blocks. Exact backup includes the store, while Hosted sync and Cloud
Vault remain intentionally unclaimed until their merge/event contracts are added.

IndexedDB v33 adds `document_thumbnail_cache`. Each deterministic `(bookId, pageIndex)` row contains a small derived
Blob, page hash, renderer fingerprint, dimensions and last-access time. It is bounded to 5,000 rows or 64MiB per book,
invalidates on source/renderer changes and participates in book deletion. It is deliberately absent from exact backup
and all sync payloads because it can be regenerated from the preserved source. PDF and image-archive renderers have
different fingerprints but share this store and eviction fence. Archive page identity includes the source and embedded
asset, allowing a cache hit before full image decode. Explicit whole-document preparation writes the same rows
sequentially for PDF and image archives and preserves completed rows after cancellation or isolated page failure.

## Reader page-map cache

IndexedDB v34 adds `reader_page_maps` for TXT/EPUB reflowable pagination. A row is keyed by content revision,
chapter, viewport/layout fingerprint and renderer version, and stores only original-offset page boundaries plus LRU
timestamps. The cache keeps the most recent 24 layouts. It is derived device-local data: backup, Cloud Vault, Hosted
sync and server migrations deliberately exclude it, and a renderer/layout change simply builds a new row.

## Current Tests

Current storage tests cover v4/v7/v11/v12 -> v13 upgrade, interrupted migration resume, atomic cutover, rollback safety, active/expired lease behavior, hash quarantine, cross-book FNV collision isolation, mixed v1/v2 anchors, all reader/AI/TTS/sync reference groups, revision heads, stale outbox lease reset, and actual same-file canonical reimport. The default suite uses bounded fixtures and the exact-20MiB single-chapter migration is an opt-in gate with total-time, heartbeat-gap, and heap-growth budgets.

`src/test/storage.test.ts`는 `fake-indexeddb`를 사용해 다음을 확인한다.

- chapter/paragraph/bookmark/highlight 조회가 object store 전체 `getAll()` 스캔 없이 동작한다.
- novel/chapter metadata 저장, v7 large text cleanup, v8 paragraph ref cleanup이 동작한다.
- paragraph page 저장/단일 조회, `paragraph_search` cursor chapter/book search, page ref fallback 기반 paragraph 단일 조회가 동작한다.
- novel 삭제 시 index 기반 child record 삭제가 동작한다.
- reading position이 `reading_positions`에 저장되고 로컬 sync outbox에 mutation event가 쌓인다.
- remote delete tombstone 이후 stale bookmark/highlight/note event가 로컬 항목을 되살리지 않는다.
