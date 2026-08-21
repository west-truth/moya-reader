# 현재 아키텍처

Reader sentence pagination - 2026-08-21: TXT/EPUB Reader는 스크롤과 문장 단위 페이지만 노출한다. TTS와
조판은 text-core 문장 경계를 공유하고 page fragment는 원본 paragraph offset을 유지한다. 스크롤/페이지는
첫 가시 문장 anchor로 전환하며, page map은 IndexedDB v34의 device-local 파생 cache에 최근 24 layout만
보관한다. `screen_turn`은 저장값 입력 마이그레이션으로만 남는다.

Reader automatic flow polish - 2026-08-22: 기본 `자동` 모드는 연속 스크롤에서 화면 이동 입력이 들어오면
마지막으로 완전히 보인 문장 다음 anchor를 페이지 첫 문장으로 사용하고, 페이지에서 wheel/세로 swipe가
들어오면 같은 content frame의 연속 스크롤로 복원한다. 두 viewport는 warm 상태를 유지하고 교체 전 anchor를
복원해 역방향 이동과 몰입형/mobile resize의 빈 frame을 피한다. 화 첫 화면은 모든 flow에서 화수와 제목을
표시한다. 연속 스크롤의 화 끝은 280ms idle 뒤 새 wheel/touch 입력을 요구하며, 입력량에 비례한 최대 32px
pull feedback은 scroll position·progress·page map을 변경하지 않는 일시적 transform이다.

Reader W4 playback boundary - 2026-07-13: TTS 설정은 기존 `ReaderSettings` JSON의 전역값과 책별 sparse
override로 저장되며 secret/audio cache와 분리된다. source-preserving sentence planner와 playback runner가
system/Hosted/native 경로의 queue, pause, timer와 다음 화 전환을 공유한다. 브라우저 음성/HTML audio는 provider
실행 이후의 playback adapter이고 Media Session은 metadata/action만 받는 platform adapter다. resume record는
content revision과 settings/voice fingerprint가 맞을 때만 사용하는 기기 로컬 convenience state다.

Status: current
Last verified: 2026-08-01 (platform shell/window subset)

## 요약

현재 앱은 React/Vite 웹 앱을 기준 제품으로 두고 Tauri v2 desktop/mobile shell을 플랫폼 adapter로 씌운 구조다. 일반 reader/import/storage 흐름은 브라우저 API 중심이며, Tauri local provider 모드만 secure-store와 AI/TTS command boundary를 사용한다.

Android shell은 Tauri v2 + shared React/core + local-first로 확정했다. 생성된 Gradle project, Keystore/provider,
SAF와 background TTS adapter가 저장소에 포함되어 있으며 Android 15 emulator alpha까지 확인했다. signed
APK/AAB와 물리 기기 release gate는 남아 있다. 개발자 준비와 build는
[네이티브 빌드 가이드](../platforms/native-build-guide-ko.md)를 따른다.

```text
React App
  -> domain parser/types/hash
  -> IndexedDB storage
  -> provider runtime
     -> Mock AI provider
     -> System TTS provider
     -> Remote hosted provider client
     -> Tauri native provider adapter
        -> app command composition
        -> platform secret store
        -> timeout-bound HTTP
        -> AI/TTS provider bridges
```

## Runtime

```text
src/main.tsx
  -> src/App.tsx
    -> src/domain/parser.ts
    -> src/storage/db.ts
    -> src/providers/reader-provider-runtime.ts
    -> src/providers/ai.ts
    -> src/providers/tts.ts
```

## Tauri Shell

위치: `src-tauri/`

- `src-tauri/src/lib.rs`는 app, secret, HTTP, AI, TTS module을 선언하고 `app::run`만 공개하는 8줄 composition root다.
- `src-tauri/src/app.rs`는 secret set/status/delete/test, structured JSON AI, TTS synthesize/voice-list command만 등록한다.
- `src-tauri/src/provider_secrets.rs`는 desktop OS keyring과 Android Keystore plugin을 분기하며 secret plaintext getter를 JS command로 공개하지 않는다.
- `src-tauri/src/provider_http.rs`는 timeout, safe network error, non-secret provider option 검사를 공유한다.
- `src-tauri/src/ai/`와 `src-tauri/src/tts/`는 command contract, bridge, provider adapter를 분리한다.
- frontend dist는 `../dist`.
- window title은 `모야 - 텍스트 및 만화 뷰어`.
- 기본 크기: `1280x820`.
- 최소 크기: `720x640`.
- bundle target: `nsis`.
- capability는 `core:default`만 허용하고 Android secret plugin을 JS capability에 직접 노출하지 않는다.
- filesystem/dialog/shell 권한은 아직 없다.
- frontend provider adapter는 `@tauri-apps/api/core`의 `invoke()`로 위 command만 호출한다. UI component는 provider SDK나 secret resolver를 직접 호출하지 않는다.

이 상태는 웹 우선 전환에 유리하다. desktop은 현재 제품 shell에 가깝고, core behavior가 Tauri에 묶여 있지 않다.

## Browser API 의존

현재 frontend가 직접 쓰는 브라우저 기능:

- File input/drop.
- `file.arrayBuffer()`.
- IndexedDB.
- DOM scroll/selection.
- `window.speechSynthesis`.
- `TextDecoder`.

`src/platform/runtime.ts`는 runtime 종류와 별도로 `PlatformCapabilities`를 계산한다. Media Session,
Wake Lock과 orientation은 실제 browser API가 있을 때만 true이고, background audio·brightness·volume-key는
native adapter가 아직 없으므로 Tauri에서도 false다. native file save capability는 shell 존재만 나타내며
실제 file dialog adapter는 후속 wave에서 연결한다.

`packages/contracts/src/domain.ts`의 format-neutral section/block/anchor와
`src/repositories/reader-document-repository.ts` port는 TXT paragraph와 미래 EPUB이 같은 위치 계약을 쓰기
위한 W0 기반이다. 현재 Reader hot path는 계속 paragraph page를 사용하며 W6 전까지 block adapter로
전환하지 않는다.

파일 import와 storage는 service/repository 경계로 분리되어 있고, AI/TTS는 browser, hosted, native provider runtime 경계를 가진다. 여전히 `App.tsx`가 일부 playback orchestration과 local/native analysis action을 직접 가진다.

Reader W1 storage uses focused `BookAssetRepository` and `LibraryCatalogRepository` ports. IndexedDB v20 keeps
exact source Blobs behind logical asset metadata and activates them with content revisions. Catalog deletion is a
lifecycle update; only explicit purge removes content, annotations and unreferenced source Blobs. PostgreSQL 0017
and remote adapters expose existing `book_objects` as source assets and implement active/trash/restore/purge plus
versioned lifecycle sync events. IndexedDB v21 adds a lazy-loaded `BackupRepository` that validates and restores a
versioned ZIP atomically; zip.js remains outside the initial Reader chunk. Remote mode implements the same
`BackupRepository` port through Hosted `/api/backups/*`: PostgreSQL snapshots and source objects are emitted as a
streamed ZIP, inspected server-side, then restored with per-book conflict policy in one database transaction. Source
objects are hash-checked and newly uploaded objects are removed on rollback. Backup payloads exclude provider secrets,
raw jobs, generated audio and derived search/pagination caches.

Manual chapter correction is isolated behind `ChapterStructureRepository`. A shared text-core command engine produces
deterministic chapter/paragraph projections without editing source bytes. The local adapter persists only bounded
draft/receipt/review metadata and activates the projection through the existing content-revision CAS transaction, so
reader anchors and durable AI artifacts use the same remap/quarantine boundary as content replacement. Hosted parity
uses the same differential revision/remap contract in Local and Hosted adapters.

Reader W3 keeps metadata/shelf mutations behind `LibraryCatalogRepository` and cover binary behind
`BookAssetRepository`. Local adapters use IndexedDB v23, Hosted adapters use PostgreSQL 0019 plus private object
storage, and the UI consumes one `LibraryManagementController`. Sync events carry metadata/shelf identities while
cover bytes transfer through the authenticated cover API. Backup adapters include durable metadata, cover and shelf
state without including derived thumbnail/search/pagination caches.

## Current Coupling

가장 큰 coupling은 `src/App.tsx`에 있다.

- view state
- file import
- parser 호출
- IndexedDB 호출
- reader progress 저장
- AI provider action 호출
- TTS playback orchestration
- bookmark/note/correction 저장

다음 리팩터링에서는 `App.tsx`를 route/view orchestration 중심으로 줄이고, import/storage/sync/TTS/AI는 service layer로 빼야 한다.

## Web Deployment Considerations

- IndexedDB는 origin-bound다. 도메인이나 Tauri origin이 바뀌면 기존 데이터 migration/export 전략이 필요하다.
- web deployment는 별도 CSP가 필요하다. desktop CSP와 서버 API/TTS/AI endpoint 허용 정책을 섞으면 안 된다.
- provider secret은 client `VITE_` env로 노출하면 안 된다. 실제 AI/TTS API key는 서버나 local secure storage에서 다뤄야 한다.
- hosted external AI/TTS 호출은 구현된 provider가 enabled/configured이고 server-side secret이 있을 때만 worker/provider boundary에서 실행한다. plain browser local mode는 cloud provider secret 저장이나 직접 호출을 지원하지 않는다.
