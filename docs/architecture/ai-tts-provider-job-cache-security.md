# AI/TTS Provider, Job, Cache, Security Architecture

2026-07-13 speaker provider safety update: generation policy와 요청별 output budget은 non-secret shared contract로
계산한다. Provider settings/catalog는 더 이상 `temperature=0.2`를 기본 생성하지 않는다. Incomplete 응답은
adapter process 안에서 partial hash, repetition score, parsed item count와 failure class를 계산한 뒤 원문을
버린다. API/job progress에는 allowlist를 다시 적용하며 prompt, partial response, chain-of-thought와 provider
error body는 저장하지 않는다. Gemini candidate token과 thought token은 별도 숫자 필드로만 기록한다.

2026-07-12 Gemini live feedback update: Gemini AI Studio v2 labeling의 response schema와 parser가
`evidence_codes`를 non-empty로 동일하게 강제한다. Gemini Interactions TTS parser는 legacy
`mimeType`과 현재 `steps[].content[].mime_type/data`를 모두 지원하되 audio MIME이 붙은 base64만
허용한다. Server catalog는 Gemini TTS의 기본 format을 WAV로 게시하며 Hosted playback, 등록-ID
neutral sample과 smoke runner는 hardcoded MP3가 아니라 capability format을 사용한다. AI Studio
40문단 structural run과 Gemini WAV live synthesis가 통과했지만 raw provider response와 audio는
보존하지 않았다. 이는 whole-book 의미 품질이나 청취 검증을 대신하지 않는다.

2026-07-11 provider attempt recovery update: Migration `0010` makes the PostgreSQL attempt row authoritative for generation, renewable 60-second lease, heartbeat, dispatch boundary, normalized outcome and billing state, reconciliation timing, and bounded usage/cost columns. Progress and canonical persistence require the current attempt generation, lease owner/token hash, unexpired lease, and logical-job pointer. Provider dispatch is marked immediately before each external `provider.*()` call. A 30-second non-overlap worker pass safely requeues only expired pre-dispatch attempts; dispatching/in-flight loss becomes `outcome_unknown` plus `billed_possible` and requires an explicit user retry. Cancellation or lease loss quarantines late results before canonical writes. API/workflow responses expose safe outcome/billing metadata but never lease owner/token hash, idempotency hash, provider request body, or secrets. Provider-specific request-status lookup, confirmed cost, and live idempotency support remain capability/live-evidence work.

2026-07-11 review recovery update: Migration `0009` adds operational promotion attempt/error/due-time and short-lived reconcile lease metadata to durable review artifacts. The worker claims at most 20 due `approved`/`promoting`/pending-advancement `promoted` rows with `FOR UPDATE SKIP LOCKED`, reuses the existing fenced promotion core, and applies bounded exponential backoff only to transient/conflict failures. Stale fences become `obsolete`; invalid candidates and exhausted retries stop automatically. Stored error data is a normalized code only, never an exception body, provider response, source text, or secret. The UI distinguishes retry waiting from blocked promotion and its manual retry replays stored promotion without another provider request.

2026-07-11 Analysis Review Workspace update: Hosted review artifacts now include bounded character options from the pinned graph snapshot and render in the AI add-on with target source, read-only halo, candidate segments, speaker/listener/emotion/prosody editing, deterministic validation/quality evidence, draft save, reject, and workflow resume monitoring. The UI never receives provider secrets or raw provider bodies. Because edited review fields are not yet materialized as scoped `UserCorrection` provenance, `editing` artifacts cannot be approved in the product UI until the v3 R2 compound label mutation bridge is implemented; unchanged valid `open` candidates may still be approved through the existing fenced promotion path.

2026-07-11 durable review update: Hosted invalid pinned labeling output is stored as a normalized `analysis_review_artifacts` row with immutable input/staging lineage, validation/quality evidence, redacted provider execution metadata, content/graph/correction fences, and optimistic `review_revision`. User draft/reject/approve mutations append `analysis_review_decisions`; arbitrary candidate fields are discarded before persistence. An editing or rejected review fences automatic repair before the provider call and inside promotion. Approval revalidates the normalized candidate, locks the source fences and parent job, and atomically promotes only the target paragraphs while invalidating dependent Episode Context. The failed parent is marked manual-review promoted, repair children are cancelled or superseded, and the workflow resumes from the next dependent window. Stale fences make the review obsolete. A background approved/promoting reconciler, shared review workspace, and Native parity remain later Phase 3 slices.

Status: AI/TTS v3 provider, review, voice, render lifecycle implemented; R8 evidence in progress
Last verified: 2026-07-12

## Current Implementation Note - 2026-07-07

- `src/providers/tts-render-spec.ts` defines the provider-neutral `TTSRenderSpec`, segment anchor normalization, identity material, and `renderSpecHash`.
- `src/providers/provider-jobs.ts`, `src/providers/provider-settings-ui.ts`, and `apps/server/src/providers/server-provider-catalog.ts` expose and consume non-secret TTS render/provider option metadata through provider catalog capabilities. The catalog distinguishes per-character `voice_profile` option placement from provider default/request placement, the hosted settings panel renders provider default/request controls from that metadata, hosted voice-profile rows render/save `voice_profile` controls from the same metadata, and `local-endpoint` remains a custom non-secret option surface for local model engines.
- TTS provider catalog model metadata now carries `maxInputCharacters` and `maxInputSegments`. These budgets can be overridden with global or provider-specific server env, are enforced before cache-miss job creation, and are re-checked in the worker against the server-reconstructed text before calling a provider.
- `src/providers/hosted-tts-playback.ts` builds raw-text-free cache resolve requests with render specs from exact labeled segment anchors and hosted voice profiles.
- `/api/chapters/:chapterId/tts-cache/resolve` normalizes optional client render specs, validates them against the request/chapter/voice metadata, rewrites provider option hashes on the server, and includes `renderSpecHash` in cache/job identity.
- `provider-job-service.ts` validates persisted render specs and hashes, checks render segment anchors against stored `labeled_segments`, reconstructs text from `paragraph_search`, and passes render spec speed/tone/emotion/format into the synthesis provider.
- Reader playback highlights the current TTS source range inline, prefetches the next hosted TTS segment or next paragraph's first segment into an in-memory audio cache, and can warm the current chapter, current+nearby chapter window, or whole book's hosted TTS cache on demand. The nearby warmup window is current chapter plus up to two following chapters and remains capped at 32 cacheable segments; whole-book warmup runs as cancellable chapter batches. `src/providers/tts-playback-session.ts` owns pure playback-session helpers for active ranges, prefetch target selection, voice-profile composition, and system fallback speech input; `src/providers/tts-playback-session-runner.ts` owns paragraph/playable traversal, hosted-first playback handoff, next-paragraph prefetch selection, and system fallback callback wiring behind injected functions; `src/providers/hosted-tts-playback-runner.ts` owns injected hosted playback/prefetch cache resolve, job polling, audio fetch, and play orchestration; `src/providers/hosted-tts-warmup-runner.ts` owns injected warmup cache resolve/job polling orchestration; `src/providers/hosted-tts-background-warmup-runner.ts` owns injected whole-book/background warmup batching; `src/providers/browser-audio-session.ts` owns browser audio element/object URL lifecycle. `apps/server/src/providers/tts-provider-smoke.ts` provides a server-only dry/live TTS provider smoke runner. Gemini Vertex TTS live smoke has passed; non-Vertex/cloud provider live smokes remain pending.
- `src/providers/label-correction-review.ts` builds the low-confidence/unknown/multi-candidate review queue and applies manual speaker/emotion label corrections before they are saved as scoped `UserCorrection` rows.
- `src/providers/character-graph-review.ts` builds the browser-side pre-merge review for completed bundle-analysis `discoveredGraph` snapshots. It normalizes graph metadata, flags likely duplicates and low-confidence candidates against existing characters, filters user-excluded discovered candidates, and drops relations that reference excluded candidates before the hosted merge job is enqueued.
- AI/TTS metadata sync now covers user-authored `voice_profiles_updated`, `user_correction_created`, `user_correction_deleted`, and generated `character_graph_updated`/`chapter_segments_updated` snapshots. Correction deletes remove the hint row without reverting already-materialized segment labels, and local tombstones prevent stale remote correction creates from resurrecting deleted hints. Generated graph sync preserves existing user-confirmed character fields, generated segment sync preserves existing user-corrected labels, hosted audio cache entries remain out of the sync event loop, and the sync panel has separate entity-group visibility plus remote/local snapshot preview, server-snapshot apply, and selected-local-field merge for pending/failed voice/graph/segment AI/TTS metadata rows.
- Provider secrets now have a separate BYO-key boundary. Hosted mode stores user-provided secrets in encrypted `provider_secrets`, provider catalog/settings responses return only `ProviderSecretStatus`, and workers resolve `user_encrypted` secrets before env fallback without placing plaintext into settings, job progress, sync payloads, logs, or toasts.
- `VoiceProfile.providerOptions` remains a non-secret provider option surface, so it is guarded at every persistence/sync/use boundary. Hosted voice-profile save, hosted TTS cache resolve, local IndexedDB `saveVoiceProfiles()`, local remote-sync apply, and server sync materialization reject secret-like keys or values before options are stored or used.
- Hosted self-host BYO settings now preserve user-selected LLM/TTS providers without requiring an env allowlist. Env defaults still seed initial settings, but UI-saved settings plus encrypted user secrets are enough for provider job readiness when the provider is implemented and configured.
- Local connected mode uses the configured self-host API as the same server provider runtime. `syncApiClient` can back provider settings, encrypted secret set/delete/test, provider job enqueue/poll, voice discovery, and TTS cache resolve/fetch while local reading data remains in IndexedDB. Server provider jobs first verify that the local book/chapter body has been attached to the self-host server, flush local changes before enqueue, stop if that refresh changes the active book/chapter, and refresh connected state after success; server TTS playback/warmup performs the same attach guard and flushes pending AI/TTS metadata before cache resolve, while prefetch stays quiet and skips work while local AI/TTS metadata is pending. Direct browser-to-cloud provider calls remain disallowed.
- Tauri native local mode uses the same settings/secret UI contract but stores OpenAI/Gemini API/Claude API keys and desktop Gemini Vertex credential paths in platform secure storage. Desktop uses OS `keyring`; Android uses `ProviderSecretStorePlugin` with Android Keystore + AES-GCM for API-key providers. Android direct local mode filters out Gemini Vertex `credential_path` providers and the Android Rust commands reject `credential_path` set/test/status as unsupported until a document-picker/content-URI credential import flow is added. Current-chapter labeling, label repair, bundle character analysis, and reviewed Character Graph merge run through `desktop_ai_generate_json`; React receives generated labels/graph data and safe job metadata, not secret plaintext. `desktop_ai_generate_json` and `desktop_tts_synthesize` both reject secret-like provider options inside Rust before any provider call. Native Gemini API / AI Studio keeps API keys out of generated URLs by using the `x-goog-api-key` request header.
- Tauri native local mode also uses the same secret boundary for `openai-tts` and `elevenlabs`. React saves only non-secret TTS defaults/options and per-character `VoiceProfile` rows; `desktop_tts_synthesize` reads the API key inside Rust, rejects secret-like provider options, performs one-shot synthesis, and returns audio bytes for `BrowserAudioSession` playback. Hosted TTS cache resolve/warmup remains server-only.
- Tauri mobile/APK connected provider execution uses the server runtime when a self-host sync API URL exists, so an APK shell can use server-side encrypted provider secrets, provider jobs, voice discovery, and TTS cache without storing cloud provider keys on the device. Direct on-device Android API-key storage/execution now has a native secure-store boundary: React uses the same provider UI, Rust command handlers register `ProviderSecretStorePlugin` on Android, the plugin stores encrypted secrets with Android Keystore + AES-GCM, and status source is reported as `android_secure_store`. The plugin is intentionally not granted direct JS capability permissions; React talks to the Tauri commands, which return only status/result metadata. APK completion is still blocked in this workstation by missing Android SDK/NDK and missing generated `src-tauri/gen/android`, not by the provider secret adapter itself.

2026-08-01 offline recovery update: Android WorkManager reads only app-private native render manifests and decrypts the
matching provider secret from the same Keystore-backed store in memory. A narrow JNI entrypoint passes the secret to
the existing Rust provider/cache boundary; Kotlin does not send provider HTTP requests or persist plaintext credentials.
Cache-only requests never schedule recovery. Each Worker run is connected/battery/storage constrained, capped at three
items and stops stable credential/configuration failures instead of retrying indefinitely. Physical process-death and
device-reboot evidence remains required before treating this as release-complete.

- Gemini Vertex LLM labeling has passed an explicit server-side live smoke for `gemini-3.1-flash-lite` with `chapter-labeling-v1-strict-tts`. Direct Tauri local Vertex execution is implemented through Rust OAuth JWT bearer auth and the Vertex `generateContent` REST endpoint; the desktop live coverage now includes storing the local credential path through `provider_secret_set`, verifying redacted status, and running `desktop_ai_generate_json` from the OS secure-store value before restoring the previous credential. `pnpm check:desktop-vertex-contract -- --live` additionally runs the desktop `DesktopStructuredJsonAIProvider` wrapper through the same strict TTS chapter-labeling prompt/schema, parser, and validator with a live Vertex response.

이 문서는 모야의 AI 기반 스마트 TTS 목표와 현재 provider/job/cache 보안 경계를 정리한다. 기본 리더는 계속
조용한 텍스트뷰어로 유지하고, AI 분석과 캐릭터별 TTS는 add-on workflow로 둔다.

## 목표

스마트 TTS는 다음 흐름을 목표로 한다.

```text
chapter/pages
  -> bundle character analysis
  -> Character Graph merge
  -> chapter segment labeling
  -> validation/repair
  -> user correction merge
  -> voice profile mapping
  -> grouped TTS synthesis
  -> audio cache
  -> playback queue + active segment highlight
```

성공 기준은 화자 자동 판별 100%가 아니다. LLM이 confidence와 후보를 남기고, 사용자가 낮은 confidence 구간을 빠르게 고치며, 보정값이 이후 분석과 음성 매핑에 반영되는 구조가 핵심이다.

## Provider Layer

현재 코드 foundation:

- `src/providers/provider-registry.ts`: provider id 기반 registry.
- `src/providers/provider-control-client.ts`: browser UI boundary for provider secret set/delete/test/status and hosted voice discovery. Remote mode calls the server API; native Tauri mode calls secure-store commands backed by desktop `keyring` or Android Keystore.
- `src/providers/desktop-structured-json-provider.ts`: desktop AI provider wrapper that reuses chapter labeling, repair, bundle analysis, and graph merge request profiles, then sends `{ providerId, modelId, prompt, responseSchema, jsonSchemaName, providerOptions }` to Tauri.
- `src/providers/desktop-tts-provider.ts`: desktop TTS bridge that sends provider id/model/text/voice/style/non-secret options to Tauri and decodes returned audio; it does not accept or return provider API keys.
- `src/providers/reader-provider-runtime.ts`: 기본 local mock/system provider를 registry 뒤로 이동.
- `src/providers/provider-jobs.ts`: provider capability, job, budget estimate, audio cache item 타입.
- `src/providers/tts-cache.ts`: provider/model/voice/options/text hash 기반 TTS cache key helper.
- `src/providers/browser-audio-session.ts`: hosted cached-audio playback adapter for browser audio elements, object URL cleanup, pause/resume, and stop completion.
- `src/providers/tts-playback.ts`: paragraph/segment/character/voice profile을 playback queue로 해석하는 resolver.
- `src/providers/tts-playback-session.ts`: active TTS highlight range, next hosted prefetch target, session phase type, playback voice profile composition, and system fallback speech input helper.
- `src/providers/tts-playback-session-runner.ts`: injected paragraph/playable traversal runner for hosted-first playback, next-paragraph prefetch selection, and system fallback callback wiring. UI control state still lives in `App.tsx`.
- `src/providers/hosted-tts-playback.ts`: labeled segment anchor와 hosted voice profile로 raw-text-free TTS cache resolve request를 만드는 browser helper.
- `src/providers/hosted-tts-warmup.ts`: current/nearby/whole-book chapter paragraphs에서 raw-text-free hosted TTS cache warmup request를 bounded or unbounded/deduped 목록으로 만드는 browser helper.
- `src/providers/hosted-tts-warmup-runner.ts`: injected warmup queue runner that resolves cache requests, polls cache-miss jobs, reports status, and summarizes partial failures without importing the remote client or provider adapters.
- `src/providers/hosted-tts-background-warmup-runner.ts`: injected chapter-batch runner for whole-book/background hosted TTS warmup. It loads chapter sources batch-by-batch, yields between batches, aggregates queue summaries, and preserves abort/source-failure state.
- `src/providers/label-correction-review.ts`: current label set에서 low-confidence, `unknown`, and multi-candidate segments를 review queue로 만들고 manual speaker/emotion correction을 적용하는 browser helper.
- `src/providers/character-graph-review.ts`: completed bundle-analysis graph에서 discovered character candidate를 review/filter하고, excluded candidate를 참조하는 relation을 merge payload에서 제거하는 browser helper.
- `src/providers/ai.ts`: 현재 `MockAIProvider`.
- `src/providers/tts.ts`: 현재 `SystemTTSProvider`와 cache 가능한 합성 provider를 위한 `TTSSynthesisProvider` contract.
- `apps/server/src/routes/ai.ts`: hosted characters, voice profiles, labeled segments, user corrections persistence API.
- `apps/server/src/db/schema.sql`: hosted AI/TTS tables and `library_books.analysis_status`.
- `src/services/remote/remote-api-client.ts`: hosted AI data client methods.
- `src/repositories/remote-reader-repository.ts`: remote AI data persistence through repository boundary.
- `apps/server/src/queue.ts`: separate provider BullMQ queue helpers.
- `apps/server/src/services/provider-job-service.ts`: server-side provider worker service for chapter labeling, repair, Character Graph merge, and TTS synthesis.
- `apps/server/src/worker.ts`: import worker and provider worker run in the same worker process.
- `src/providers/chapter-labeling-contract.ts`: provider-neutral chapter labeling schema/JSON validation/mapping boundary.
- `src/providers/chapter-labeling-payload.ts`: provider-neutral chapter labeling prompt payload builder. It keeps paragraph anchors, known characters, previous episode context, and user corrections in one request-input module so prompt/profile experiments do not require provider adapter changes.
- `src/providers/chapter-labeling-request-profile.ts`: swappable prompt/schema request profile boundary. It defaults to paragraph-complete `chapter-labeling-v2-strict-tts`, retains v1 profiles for compatibility, builds provider-neutral requests, strips profile-only options before provider API calls, and keeps profile metadata available for job hashes, provider catalog, settings UI, and analysis runs. `chapter-label-repair-request-profile.ts` similarly defaults to bounded `chapter-label-repair-v2-patch` while preserving pinned v1 repair.
- `src/providers/chapter-labeling-validator.ts`: app-side chapter label validator. It checks source anchors, segment text hashes, overlap, speaker ids, segment types, confidence, and narrator-fallback gaps before hosted generated segments are stored.
- `src/providers/chapter-label-repair-request-profile.ts`: provider-neutral repair request profile boundary. It sends original paragraph anchors, existing labels, validator issues, known characters, previous context, and user corrections through the same stored chapter labeling response schema.
- `src/providers/character-graph-contract.ts`: provider-neutral Character Graph merge schema/parser/mapper. It validates novel id, duplicate character ids, relation endpoints, and confidence bounds before provider output can become internal graph data.
- `src/providers/character-graph-request-profile.ts`: swappable Character Graph merge request profile boundary. It builds prompts from existing/discovered graphs, source context, and user corrections, strips graph profile keys from provider API options, and keeps `character-graph-merge-v1` separate from the current chapter-labeling UI dropdown because graph merge is a dedicated book-level job.
- `src/providers/character-graph-snapshot.ts`: graph snapshot normalization boundary used by hosted route/worker code; untrusted snapshots do not get to create user-confirmed characters.
- `apps/server/src/providers/server-ai-config.ts`: server-only provider env, model, budget, and credential-path settings.
- `apps/server/src/providers/server-provider-settings.ts`: hosted per-user provider defaults, enabled-provider narrowing, model overrides, and non-secret option settings.
- `apps/server/src/providers/server-provider-secrets.ts`: hosted AES-256-GCM provider secret store, env fallback resolver, catalog status overlay, and worker secret resolver.
- `apps/server/src/providers/server-provider-catalog.ts`: server-visible provider catalog without secret values.
- `apps/server/src/providers/provider-error-classification.ts`: classifies provider failures as auth, quota, missing config, schema, retryable network, content too large, unsupported, cancelled, or unknown while returning safe messages that do not preserve provider response bodies.
- `apps/server/src/providers/provider-smoke.ts`: server-only dry/live AI provider smoke runner. Dry-run reports sanitized readiness plus the effective request profile; `--profile` overrides the chapter-labeling request profile for one run; live mode makes one small labeling request.
- `apps/server/src/providers/tts-provider-smoke.ts`: server-only dry/live TTS provider smoke runner. Dry-run reports sanitized readiness, effective render/style controls, and provider option keys only; live mode makes one short synthesis request and returns audio metadata only. `--speed`, `--pitch`, `--tone`, `--emotion`, and repeated `--option key=value` can exercise provider-specific TTS controls without exposing option values.
- `apps/server/src/providers/server-structured-json-provider.ts`: common server-only structured JSON AI provider wrapper, schema conversion, option cleanup, and safe JSON POST helper.
- `apps/server/src/providers/openai-ai-provider.ts`: OpenAI chat completions structured-output adapter.
- `apps/server/src/providers/gemini-ai-studio-provider.ts`: Gemini API / AI Studio structured-output adapter through the Google Gen AI SDK.
- `apps/server/src/providers/gemini-vertex-ai-provider.ts`: Gemini Vertex and Gemini Enterprise Agent Platform adapters using schema-constrained JSON output through the Google Gen AI SDK.
- `apps/server/src/providers/anthropic-ai-provider.ts`: Claude Messages structured-output adapter.
- `apps/server/src/providers/openai-tts-provider.ts`: OpenAI Speech API adapter for cacheable server-side TTS synthesis.
- `apps/server/src/providers/elevenlabs-tts-provider.ts`: ElevenLabs REST adapter for cacheable server-side TTS synthesis.
- `apps/server/src/providers/gemini-tts-provider.ts`: Gemini API TTS Interactions adapter for cacheable server-side TTS synthesis.
- `apps/server/src/providers/gemini-vertex-tts-provider.ts`: Gemini Vertex TTS adapter through the Google Gen AI SDK. It shares Vertex credential discovery with the LLM adapter, requests audio with `models.generateContent()` speech config, wraps returned PCM in WAV for browser playback, and rejects empty audio.
- `apps/server/src/providers/google-cloud-tts-provider.ts`: Google Cloud Text-to-Speech Gemini TTS adapter for cacheable server-side TTS synthesis.
- `apps/server/src/providers/local-endpoint-tts-provider.ts`: local HTTP endpoint adapter for user-managed local/sidecar TTS models, including `/voices` discovery for the v1 local endpoint contract.
- `apps/server/src/providers/server-tts-provider-factory.ts`: server-only TTS provider factory for implemented synthesis providers.
- `src/providers/provider-settings-ui.ts`: browser-side draft/validation helper for hosted provider settings. It shapes non-secret settings payloads and rejects secret-like option JSON before sending to the server.
- `src-tauri/src/lib.rs`: native provider secret commands, secure local OpenAI/Gemini API/Gemini Vertex/Claude API structured JSON command, and secure local OpenAI/ElevenLabs/local-endpoint TTS synthesis commands. It reads secrets internally from the platform secure store, resolves Vertex service-account credential file paths or single-JSON credential directories only inside Rust, validates local endpoint URLs as HTTP(S) secrets, and returns only generated JSON text, TTS audio metadata/bytes, voice lists, or sanitized errors.
- `scripts/desktop-vertex-contract-smoke.ts`: explicit live Vertex smoke for the desktop structured JSON provider contract. It does not read secrets into React; it uses the desktop wrapper's prompt/schema/parser path and the app validator with sanitized output only.

UI는 provider 구현체를 직접 생성하거나 provider별 request body를 조립하지 않는다. UI가 알 수 있는 값은 provider id, model id, job id, voice profile id, status/result 정도로 제한한다.

Provider category:

```text
LLM providers:
  mock
  openai
  gemini-ai-studio
  gemini-vertex
  gemini-agent-platform
  anthropic
  local-llm

TTS providers:
  system
  local-endpoint
  openai-tts
  elevenlabs
  gemini-tts
  gemini-vertex-tts
  google-cloud-tts
```

모델명은 코드에 고정하지 않는다. OpenAI, Gemini, Vertex, Claude, ElevenLabs 모두 모델과 옵션이 빠르게 바뀌므로 `ProviderModelConfig` 또는 서버 설정에서 주입한다.

## LLM Provider Contract

공통 내부 API는 provider별 API 모양과 분리한다.

```ts
analyzeCharacterBundle(input): Promise<BundleAnalysisResult>
mergeCharacterGraph(input): Promise<CharacterGraph>
labelChapterSegments(input): Promise<ChapterLabelingResult>
validateOrRepairChapterLabels(input): Promise<ChapterLabelingResult>
summarizeEpisodeContext(input): Promise<EpisodeContextSummary>
```

Provider별 adapter는 이 내부 schema를 만족해야 한다.

- OpenAI: Structured Outputs와 prompt caching 친화적 prompt layout을 사용한다.
- Gemini AI Studio: API key 기반 adapter. 브라우저 직접 호출 금지.
- Gemini Vertex / Agent Platform: service account 또는 ADC 기반 server/secure local adapter.
- Claude: structured output 또는 strict tool/schema 경로를 adapter 안에서 처리한다.
- Local LLM: localhost endpoint 또는 sidecar adapter. UI가 endpoint별 payload를 몰라야 한다.

Provider secret contract:

- `provider_settings` stores default provider, enabled subset, model overrides, request profile ids, and non-secret provider options only.
- `provider_secrets` stores one encrypted user secret per `user_id/scope/provider_id/secret_name`. Secret names are currently `api_key`, `access_token`, `credential_path`, and `endpoint_url`.
- Hosted encryption uses AES-256-GCM. `PROVIDER_SECRET_ENCRYPTION_KEY` is used when present; otherwise a personal self-host key file is created under `SERVER_DATA_DIR`. Losing that key file makes stored provider keys unrecoverable.
- Secret status responses may include `configured`, `source`, `last4`, `fingerprint`, and `updatedAt`, but never secret plaintext. `credential_path` status intentionally omits `last4` and `fingerprint` so local filesystem path hints are not reflected back to React.
- Resolver precedence is `UI stored encrypted secret > env secret > missing`. API and worker code use the same resolver so UI-saved keys can run actual provider jobs.
- Plain browser local mode does not store cloud API keys or call cloud providers directly. Tauri native local mode uses secure-store commands for set/delete/test/status, first-party OpenAI/Gemini API/Claude API current-chapter labeling, label repair, bundle analysis, graph merge, and OpenAI/ElevenLabs/local-endpoint TTS synthesis. Desktop native mode additionally supports Gemini Vertex `credential_path` service-account labeling. Android native mode supports API-key providers and local-endpoint TTS endpoint URLs for this slice. Additional local provider execution must stay behind the same secure local boundary.
- Gemini Vertex LLM service-account execution is available in desktop local mode through the secure Tauri command boundary and in connected/server mode through the hosted worker. Gemini Agent Platform service-account execution is still server/connected-mode only until a matching secure-local adapter is implemented.

AI request modularization rule:

- Prompt text, response schema, parser, mapper, and provider-option stripping live in request profile modules under `src/providers/*request-profile.ts`.
- Provider adapters only receive `{ modelId, prompt, responseSchema, jsonSchemaName, providerOptions }` and return JSON text.
- Adding a prompt experiment means adding a new request profile id, not editing React UI or provider-specific SDK code.
- Generic `requestProfileId` values from settings may be shared across LLM tasks. Task-specific profile keys such as `graphRequestProfileId` or `repairRequestProfileId` are the only keys that should hard-fail when unsupported.
- Request profile id, prompt version, schema version, provider id, model id, input hash, and sanitized provider options must be part of any hosted job idempotency/progress metadata before results are persisted.

입력 원칙:

- 원문은 normalized paragraph text 기준으로 보낸다.
- LLM 결과는 원문을 재작성하지 않는다.
- segment anchor는 `chapterId`, `paragraphId`, `startOffset`, `endOffset`, `segmentTextHash`를 사용한다.
- `speakerId`는 `narrator`, `system`, `unknown`, 또는 Character Graph의 character id만 허용한다.
- confidence, evidence, candidate speakers는 항상 저장한다.

## TTS Provider Contract

TTS는 system playback과 cloud synthesis를 분리한다.

```text
SystemTTSProvider:
  브라우저/OS Web Speech 기반 fallback.
  오디오 파일 캐시 없음.

LocalTTSProvider:
  사용자가 설치한 로컬 모델/sidecar/localhost API.
  providerOptions로 endpoint/model/style을 격리.

CloudTTSProvider:
  OpenAI, ElevenLabs 같은 API형 TTS.
  서버 worker 또는 secure local adapter에서만 호출.
  audio cache 필수.
```

Local TTS Endpoint v1:

```text
GET /health
GET /voices
POST /synthesize
```

`/voices` may return either an array or `{ "voices": [...] }`. Each voice should provide `id` or `voiceId`, and can include `label`/`name` plus `lang`/`language`. Hosted voice-profile UI can refresh this list and assign a discovered voice id to narrator/unknown/system/character profiles. Arbitrary model archive upload/install remains out of v1.

캐릭터별 `VoiceProfile`은 내부 voice profile과 provider voice id를 분리한다.

필수 필드:

- `role`: narrator, character, system, unknown
- `providerId`
- `providerVoiceId`
- `providerModel`
- `label`
- `language`
- `speed`
- `pitch`
- `tone`
- `emotionPolicy`
- `providerOptions`
- `isUserSelected`

Provider가 지원하지 않는 옵션은 adapter가 무시하거나 capability로 불가 상태를 반환한다. UI는 option이 실제 반영됐는지 provider status/result로만 알 수 있다.

## Job Boundary

외부 LLM/TTS 호출은 즉시 UI request 안에서 끝내지 않는다. hosted mode는 서버 job으로 처리한다.

```text
analysis_jobs
  character_bundle_analysis
  character_graph_merge
  chapter_segment_labeling
  chapter_label_validation
  chapter_label_repair

tts_jobs
  tts_synthesis
  tts_prefetch
```

Job requirements:

- idempotency key: provider id, model id, input hash, prompt/schema version, correction revision.
- status: queued, running, succeeded, failed, cancelled.
- progress: chapter count, segment count, cache hit count, message.
- retry: 429/503/temporary network errors only.
- hard fail: auth, quota, invalid schema, content too large, missing provider config.
- cancel: queued/running job can be cancelled; DB cancellation is recorded before best-effort BullMQ removal, workers monitor cancellation while provider calls are active and abort provider `AbortSignal`s, and generated DB persistence locks the provider job row before writing side effects.
- budget guard: estimated token/character/audio seconds before enqueue.

Provider failures are classified through the shared classifier before they are shown by smoke runners or stored on `provider_jobs`. Job rows keep `error_code=provider_error_<category>` and progress stores `errorCategory`/`retryable`; `error_message` is a safe category-level message rather than the raw external provider response.

현재 `apps/server/src/queue.ts`에는 import queue와 분리된 provider queue가 있다. Hosted mode는 `POST /api/books/:bookId/analysis-jobs`로 `character_bundle_analysis`, `chapter_segment_labeling`, `chapter_label_repair`, 또는 `character_graph_merge` job을 enqueue하고, `GET /api/provider-jobs/:jobId`로 상태를 읽으며, `POST /api/provider-jobs/:jobId/cancel`로 queued/running job을 취소한다. Cancel route는 `provider_jobs` row를 먼저 `cancelled`로 마킹하고 그 뒤 가능한 경우 BullMQ queued entry를 제거한다. Worker는 취소된 job을 시작하지 않고, running 전환 직후와 provider 호출 전후에 `cancelled` 상태를 다시 확인한다. Active provider call 중에는 worker가 DB 취소 상태를 짧은 주기로 monitor하고, 감지 시 provider input의 `AbortSignal`을 abort한다. Fetch 기반 OpenAI/Anthropic/TTS adapters receive that signal, and current Gemini SDK calls receive it through `GenerateContentConfig.abortSignal`. Generated DB persistence는 transaction 시작 시 provider job row를 `for update`로 잠그고 취소 여부를 다시 확인한 뒤에만 진행된다. Route는 provider/model/request profile/prompt/schema/chapter-or-bundle/provider option hash로 idempotency input hash를 만든다. Bundle analysis job은 chapter 없이 선택된 `chapterIds`, chapter text hash/updatedAt/count, existing graph fingerprint, source context hash, future/global correction hash, provider/model/profile/schema/options hash를 input hash에 포함하고, raw paragraph text는 job progress에 저장하지 않는다. Repair job은 저장된 segment fingerprint도 hash에 포함한다. Graph merge job은 chapter 없이 book metadata, existing graph fingerprint, discovered graph hash, source context hash, future/global correction hash, provider/model/profile/schema/options hash를 input hash에 포함한다. `AI_LABELING_MAX_INPUT_CHARACTERS`를 넘는 chapter 또는 bundle은 enqueue 전에 거절한다. Worker는 `provider_jobs` row를 읽고 bundle/chapter paragraph text, `characters`, 직전 `chapter_contexts`, 적용 가능한 `user_corrections`를 provider-neutral payload로 넘긴다. `character_bundle_analysis` worker는 `AIProvider.analyzeCharacterBundle()` 결과를 `analysis_runs.metadata`와 job progress에 `discoveredGraph`/`bundleSummaryForNext`로 저장하고 canonical graph table은 덮지 않는다. Provider labeling 결과는 `chapter-labeling-validator.ts`를 통과해야 하며, labeling error가 있으면 기본적으로 job을 failed로 끝내고 기존 generated `labeled_segments`는 건드리지 않는다. `AI_LABELING_AUTO_REPAIR=true` 또는 hosted provider option `autoRepairOnValidationFailure=true`가 명시된 labeling job은 invalid provider output을 저장하지 않고 `chapter-label-repair-v1` profile로 repair pass를 한 번 시도하며, repaired output이 validator를 통과할 때만 저장한다. 이 경로는 provider 호출이 한 번 늘 수 있으므로 opt-in이다. `chapter_label_repair` worker는 현재 저장된 labels를 먼저 validate하고, issue가 있으면 `chapter-label-repair-v1` request profile과 optional `repairChapterLabels()` provider method를 사용해 complete corrected JSON을 받은 뒤 다시 validate한다. 검증을 통과한 labeling/repair 결과만 server AI provider factory 뒤에서 `characters`, `labeled_segments`, `analysis_runs`, `chapter_contexts`, `library_books.analysis_status`를 갱신한다. Hosted `character_graph_merge` worker는 existing graph, discovered graph, source context, user corrections를 `AIProvider.mergeCharacterGraph()`에 넘기고, 반환 graph snapshot을 검증한 뒤 `characters`, `character_aliases`, `character_relations`, `analysis_runs`, `library_books.analysis_status`를 같은 transaction policy로 갱신한다. `analysis_runs.prompt_version`과 metadata에는 request profile id/schema version/bundle discovered graph/validation summary 또는 graph merge count가 남고, repair metadata에는 input validation summary와 repaired 여부가 남는다. job progress에는 context count, validation summary 또는 graph count, provider options가 유지되어 재시도 때 profile id를 잃지 않는다.

`AIProvider.mergeCharacterGraph()`와 `character-graph-merge-v1` profile은 provider-neutral request/response boundary와 hosted `character_graph_merge` route/worker/storage transaction에 연결됐다. Graph merge input hash에는 existing graph fingerprint, discovered graph fingerprint, source context fingerprint, future/global user correction fingerprint, provider id/model/profile/schema/provider options hash가 들어간다. Storage write는 generated output이 user-confirmed character fields를 직접 덮지 않는 `upsertCharacters()` 정책을 유지하고, aliases/relations를 transaction 안에서 갱신한다. `GET /api/providers`는 OpenAI, Gemini AI Studio, Gemini Vertex, Gemini Agent Platform, Claude, system/cloud/local TTS provider의 enabled/implemented/secretConfigured 상태와 model id만 노출하며 secret 값과 credential path는 반환하지 않는다. `pnpm server:provider-smoke`도 request profile id/prompt version/schema version을 sanitized summary로 보여주고 `--profile`로 한 번의 smoke run에만 profile을 주입할 수 있다.

현재 기본 enabled provider는 `mock`이다. OpenAI/Gemini AI Studio/Gemini Vertex/Gemini Agent Platform/Anthropic adapter는 구현되어 있지만, hosted 실제 호출은 `AI_PROVIDER_ENABLED`, provider별 model env, and server-side env/encrypted user secret이 모두 명시된 경우에만 worker에서 실행된다. Hosted `provider_settings`는 default provider, enabled provider subset, model override, request profile id, non-secret provider options만 저장한다. Hosted `provider_secrets` 또는 env secret 상태가 provider availability를 결정하며, UI 저장 secret이 env secret보다 우선한다. AI/TTS add-on UI는 remote mode에서 catalog/settings/secret status를 불러와 settings와 BYO secret set/delete/test를 분리하고, secret-like option JSON은 client preflight와 server validation 양쪽에서 거절한다. Analysis enqueue route는 요청 provider/model이 없으면 saved `llm_labeling` default/model을 사용하고, provider secret이 없으면 job을 만들기 전에 거절한다. `AI_LABELING_REQUEST_PROFILE` 또는 provider option `requestProfileId` can switch the chapter-labeling prompt/schema request profile; supported labeling profiles are listed in provider catalog and shown as a hosted LLM settings dropdown. Current labeling profile ids are `chapter-labeling-v1` for the default prompt and `chapter-labeling-v1-strict-tts` for stricter non-overlap, exact-offset, uncertainty, deterministic segment id, and TTS emotion guidance. `character-bundle-analysis-v1` and `character-graph-merge-v1` are used by dedicated book-level jobs and are not shown in the current labeling dropdown. Bundle analysis receives selected chapters, existing graph, previous bundle summary, and user corrections; graph merge receives existing graph, discovered graph, source context, and user corrections. Repair uses `chapter-label-repair-v1`; it strips repair/profile-only options before Gemini/OpenAI/Claude request config and ignores ordinary labeling `requestProfileId` values unless they explicitly name a supported repair profile. Unsupported explicit repair, bundle, or graph profiles are rejected before provider calls. `autoRepairOnValidationFailure` is stored as a non-secret hosted/desktop provider option and is stripped before provider API config is assembled. Hosted AI 분석 버튼은 server job을 enqueue/poll하고 완료 후 저장된 labels/characters/voice profiles를 다시 읽는다. Hosted AI add-on은 현재 화 `chapter_label_repair` job, 현재 화부터 최대 3화의 `character_bundle_analysis` job, 완료된 job progress의 `discoveredGraph`/`sourceContext`를 넘기는 `character_graph_merge` job을 실행할 수 있다. Desktop AI add-on uses the same buttons when running in Tauri local mode: labeling and repair validate output before IndexedDB persistence, bundle analysis stores a local candidate graph in job state, and graph merge persists characters/relations through `ReaderRepository.saveCharacterGraph()`. The same add-on now exposes a label review queue for low-confidence, `unknown`, and multi-candidate segments; manual corrections can update speaker and emotion labels and save scoped `UserCorrection` rows. Hosted LLM settings UI는 `autoRepairOnValidationFailure` 전용 체크박스를 제공한다. Gemini Vertex LLM and Gemini Vertex TTS live smoke passed; OpenAI/Gemini AI Studio/Gemini Agent Platform/Anthropic live smoke, non-Vertex external TTS live smoke, and Google Cloud TTS REST permission/auth verification remain pending.

`POST /api/chapters/:chapterId/tts-cache/resolve`는 raw text를 받지 않고 `providerId`, optional `providerModel`, optional `providerVersion`, `voiceProfileId`, `speakerId`, non-empty `segmentIds`, `inputTextHash`, optional non-secret `providerOptions`, optional `audioCharacters`, optional `force`를 받는다. Route는 non-system TTS provider가 enabled/implemented/secretConfigured 상태인지 확인한 뒤 provider catalog model budget의 max input characters/segments를 적용하고, saved `tts_synthesis` setting의 enabled subset, model override, provider options를 적용한다. Request `providerModel`과 `providerOptions`는 saved 값보다 우선한다. 그 뒤 server-side TTS cache key를 계산하고 `tts_audio_cache` hit를 반환하거나 cache miss에서 `tts_synthesis` provider job을 enqueue한다. 현재 server synthesis 구현은 `openai-tts`, `elevenlabs`, `gemini-tts`, `gemini-vertex-tts`, `google-cloud-tts`, `local-endpoint`에 열려 있다. Worker는 `tts_synthesis` job에서 stale persisted voice profile/provider options에 secret-like 값이 없는지 다시 검사하고, `labeled_segments`와 `paragraph_search`를 조합해 서버 저장소의 텍스트를 재구성하며, `inputTextHash`와 worker-side budget 검증이 통과할 때만 provider를 호출한 뒤 S3/MinIO object와 `tts_audio_cache` row를 쓴다. Reader hosted playback은 선택된 hosted TTS provider의 non-system voice profile이 지정된 labeled segment에서만 cache resolve를 만들고, cache hit 또는 job 성공 후 authenticated audio route에서 blob을 받아 재생한다. 라벨 없는 gap, system voice, secret-like provider options, 실패한 hosted call은 system TTS fallback으로 처리한다. Clipped overlap은 playable source range를 보존해 원문 hash와 segment anchor를 안전하게 만든다. Reader는 현재 TTS source range를 inline highlight하고 다음 segment 또는 다음 문단의 첫 hosted TTS audio를 in-memory cache로 prefetch한다. TTS add-on은 사용자가 요청할 때 현재 화 또는 현재+다음 2화 window에서 전체 최대 32개 cacheable segment를 raw text 없이 순차 resolve/poll해 cache를 미리 준비하거나, 책 전체를 cancellable chapter batch로 훑으며 cache를 준비한다. `pnpm server:tts-smoke` runner는 실제 provider/API를 연결하기 전에 readiness, speed/pitch/tone/emotion, non-secret provider option keys, and 최소 합성 경로를 점검할 수 있게 한다. Gemini Vertex TTS live smoke passed; other external TTS live smokes remain pending.

## Storage Boundary

현재 local IndexedDB에는 `segments`, `characters`, `voice_profiles`, `corrections`가 있다. Hosted PostgreSQL에는 AI/TTS 저장소 foundation이 추가됐다.

추가된 hosted 저장소:

```text
analysis_runs
characters
character_aliases
character_relations
chapter_contexts
labeled_segments
voice_profiles
user_corrections
provider_jobs
tts_audio_cache
provider_settings
provider_secrets
```

아직 남은 저장소/서비스:

```text
local provider_jobs / tts_audio_cache stores
repository-level correction list/read API
generated graph/segment sync metadata for AI/TTS
```

Remote mode의 `RemoteReaderRepository.listSegments/saveSegments/listCharacters/saveCharacters/listVoiceProfiles/saveVoiceProfiles/saveCorrection/deleteCorrection`는 이제 hosted API를 호출한다. `RemoteApiClient.listProviders/getProviderSettings/saveProviderSettings/enqueueAnalysisJob/getProviderJob/cancelProviderJob/resolveTTSCache/fetchTTSCacheAudio`는 hosted provider catalog, provider settings, analysis jobs, provider job status/cancellation, TTS cache resolve, cached audio read 경계를 호출한다. `ProviderControlClient`는 provider secret set/delete/test/status와 hosted TTS voice discovery를 별도 경계로 호출한다. Reader playback은 이 client를 통해 cache hit/job/audio fetch를 처리한다. User-authored `voice_profiles` and `user_corrections` now emit create/delete sync events for cross-device pull/push. Generated `characters`, `character_relations`, and `labeled_segments` also flow through the sync event log as `character_graph_updated` and `chapter_segments_updated`; hosted audio cache records stay in server/object storage and are not copied through sync. Provider secrets are not sync events.
The sync boundary treats `voice_profiles_updated` as a whole-book collection snapshot and rejects stale or malformed snapshots before event-log insertion. `user_correction_created` stores the correction hint and, when the referenced hosted segment exists, applies speaker/emotion changes to `labeled_segments` in the same server transaction. `user_correction_deleted` removes the hint row, records deletion revision metadata, and leaves segment labels as they are because corrections are hints rather than label rollback operations. `character_graph_updated` supports patch/replace modes, rejects malformed character/relation payloads, preserves user-confirmed character fields, and stores relations when present. `chapter_segments_updated` validates chapter ownership, paragraph anchors, offset ranges, segment text hashes, and overlap before materializing; generated snapshots delete/update only non-user-corrected rows.
The browser sync panel summarizes unsent AI/TTS metadata rows separately from ordinary reading-position/annotation rows, including event-family counts, local revision labels, queued targets, latest AI/TTS sync error, entity-group policy cards, remote/local snapshot preview summaries, server-snapshot apply for voice/graph/segment groups, selected-local-field merge for those same snapshot groups, and one-row or one-group discard actions. `src/sync/ai-tts-remote-snapshot.ts` loads server-side voice profiles, corrections, Character Graph characters/relations, or chapter segments through the same remote API client used for sync/hosted mode, `src/sync/ai-tts-sync-diff.ts` normalizes the local outbox payloads and compares them to those remote snapshots for field-level added/removed/changed summaries, and `src/sync/ai-tts-sync-apply.ts` builds local apply events for full server snapshots plus merged snapshots where selected local fields/items are overlaid on the server snapshot and saved back as a fresh local outbox event. User correction groups can be retried, discarded, or deleted through `user_correction_deleted`; selected-field merge remains limited to snapshot-style voice/graph/segment groups.

Local `saveSegments()`와 `saveCharacters()`는 각각 같은 chapter/book의 기존 row를 트랜잭션 안에서 교체한다. LLM/Mock 결과의 segment/character 수가 줄거나 0개가 되어도 stale metadata가 reader/TTS resolver에 남지 않게 하기 위한 경계다.

Hosted characters, voice profiles, and labeled segments also use replace semantics, but unchanged ids are upserted before stale ids are deleted inside a transaction. This keeps existing character ids stable so `voice_profiles.character_id` links are not detached during ordinary analysis refreshes.

Parser/reimport invalidation:

- segment는 `segmentTextHash`와 paragraph anchor가 맞을 때만 valid하다.
- reimport, chapter split mode 변경, paragraph id 변경 시 기존 segments와 TTS cache를 invalid/stale로 표시한다.
- user correction은 가능한 경우 text hash와 quote evidence로 재연결하되, 자동 remap이 실패하면 review queue로 보낸다.
- Character Graph merge는 `characters`, `character_aliases`, and `character_relations`를 같은 transaction에서 갱신해야 한다. `analysis_runs`는 해당 graph merge run metadata를 남기고, 기존 user-confirmed character/alias와 연결된 `voice_profiles.character_id`는 graph merge가 자동으로 끊지 않는다.

## Audio Cache

TTS cache key는 원문 텍스트를 직접 포함하지 않는다.

```text
cache_key = sha256(
  novel_id,
  chapter_id,
  segment_ids,
  speaker_id,
  voice_profile_id,
  provider_id,
  provider_model,
  provider_version,
  input_text_hash,
  tts_options_hash,
  tts_render_spec_hash(
    pronunciation_revision_id,
    pronunciation_fingerprint
  )
)
```

Cache invalidation:

- source paragraph text hash 변경.
- voice profile 변경.
- provider model/version 변경.
- speed/pitch/tone/providerOptions 변경.
- user correction으로 segment speaker/tone/emotion 변경.
- 선택된 voice catalog entry fingerprint 또는 pronunciation revision 변경.
- book deletion.

Storage:

- hosted: object storage, signed playback URL or authenticated API streaming.
- local: IndexedDB Blob or desktop app data directory; MVP에서는 system TTS cache 없음.

현재 `tts_audio_cache` schema와 shared `TTSCacheItem` 타입은 `provider_version`, `speaker_id`, `content_type`, `byte_size`, `audio_hash` 같은 합성 결과 메타데이터를 받는다. `0016`은 render plan/item, cache purpose, exact fingerprint, voice/pronunciation identity, verified/quarantined/stale 상태와 GC lease를 추가한다. `tts-cache/resolve` route는 같은 stable provider JSON 규칙으로 `cacheKey`와 `optionsHash`를 만들고, worker는 codec/container probe를 통과한 오디오만 object storage의 `tts/<book>/<chapter>/<cacheKey>.*` 경로와 cache row에 commit한다. Audio fetch는 current content, voice profile/catalog entry, pronunciation revision과 object hash/size/type를 다시 확인하며 mismatch/missing object를 quarantine한다. Background maintenance는 provider terminal 상태와 render item을 수렴시키고 stale/quarantined row를 bounded lease로 GC한다. Reader playback은 labeled segment 단위로 이 audio API를 호출해 blob을 재생하고, 같은 cache request key로 다음 segment 또는 다음 문단의 첫 playable hosted TTS audio를 작은 in-memory cache에 prefetch한다. Active source-range highlight, bounded current/nearby-chapter warmup, whole-book/background warmup, 등록 sample ID 기반 Hosted neutral sample이 구현되어 있다.

## S8 Voice Casting and Cache Boundary

`TtsVoiceBindingV1` binds accepted speaker provenance to an active voice assignment. Projection requires matching
book/content/chapter/segment provenance, active casting state, requested provider/model and the current VoiceProfile's
actual provider voice key. User-selected profile overrides are explicit; stale legacy generated profile references do
not bypass a valid casting binding.

Hosted `tts-cache/resolve` checks this binding before returning a hit or creating a synthesis job. A book with no
casting row keeps the legacy manual-profile path, while a book with stale casting or a missing character assignment
returns 409. Narrator/system/sample requests keep their separate fallback/sample rules. Sync and Hosted restore clear
derived casting to staging so old assignments cannot become valid merely because their profile IDs still exist.

Native cache identity now carries the same effective provider/model/voice and rendering inputs as the web plan,
including pronunciation revision/fingerprint, selected voice entry fingerprint, normalized controls/alignment,
chunker version and projection version. It stores hashes and non-secret metadata, never the casting workspace, source
text, provider options body or provider secret. A voice profile write that cannot be paired with casting persistence
invalidates the workspace and blocks projection until a successful recompute.

## Security Boundary

절대 금지:

- browser React code에서 외부 LLM/TTS API key 사용.
- `VITE_*` env에 provider secret 저장.
- provider secret을 IndexedDB/localStorage에 저장.
- service account JSON 내용을 로그, 문서, toast, test snapshot, sync event에 남김.
- `vertex env/` 하위 파일 커밋.
- hosted `provider_settings`에 API key, token, secret, credential path, password, private key 같은 secret-like key 저장.

허용:

- hosted server: server env, container secret, cloud secret manager, service account mount.
- desktop secure local: OS credential store 또는 Tauri secure adapter.
- local endpoint: 사용자가 별도로 띄운 localhost provider에 앱이 제한된 payload만 전송.
- system TTS: secret 없음.

Hosted `provider_settings` API는 secret-like key를 재귀적으로 거절한다. Secret은 server env/container secret/cloud secret manager에만 둔다.

현재 repo에서는 `vertex env/`를 `.gitignore`에 추가했다. 해당 파일은 local credential source로만 취급한다. `server-ai-config.ts`는 `GOOGLE_APPLICATION_CREDENTIALS`가 없고 `VERTEX_CREDENTIALS_DIR` 또는 기본 `vertex env` 아래 JSON 파일이 정확히 하나만 있으면 그 경로를 runtime credential path로 사용한다. `GOOGLE_CLOUD_PROJECT`가 비어 있으면 credential JSON의 `project_id`만 읽어 project 설정으로 사용할 수 있지만, private key/client email 같은 credential 내용은 코드/문서/로그/test snapshot에 쓰지 않는다.

## Vertex/Gemini Notes

Desktop Vertex uses the same provider-neutral prompt/schema contract but does not use browser JS or Node SDKs. The UI stores `llm_labeling/gemini-vertex/credential_path` through Tauri secure-store commands; `src-tauri/src/lib.rs` resolves the file path or single-JSON credential directory, signs a Google OAuth JWT bearer assertion, calls `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`, and returns only the candidate text. Non-secret `project` and `location` are provider options; if `project` is omitted, the service-account `project_id` is used.

공식 문서 기준으로 Gemini Enterprise Agent Platform/Vertex 작업은 Node.js에서 `@google/genai`를 설치하고 `new GoogleGenAI({ vertexai: true, project, location })`로 client를 만든 뒤 `client.models.generateContent()`를 호출한다. Quickstart는 ADC 또는 API key 인증을 설명하며, ADC를 권장한다. 구조화 출력은 `responseMimeType: 'application/json'`과 `responseSchema`를 `config`에 넣는 방식이다. 현재 adapter는 이 경로를 사용하되, provider-neutral schema/validator는 `src/providers/chapter-labeling-contract.ts`, prompt/schema selection is in `src/providers/chapter-labeling-request-profile.ts`. `pnpm server:provider-smoke -- --provider gemini-vertex --model gemini-3.1-flash-lite --profile chapter-labeling-v1-strict-tts`는 dry-run readiness와 effective profile을 확인하고, `--live`를 붙였을 때만 실제 요청을 보낸다.

테스트 후보:

- `gemini-3.1-flash-lite`: 비용/지연이 중요한 labeling smoke. `gemini-3.1-flash-lite-preview`는 2026-05-25 shut down 됐으므로 사용하지 않는다.
- `gemini-3.5-flash` 계열: 더 어려운 repair/validation smoke.
- Gemma 4 계열: Model Garden/managed API availability와 endpoint shape 확인 후 adapter로 추가.

정확한 model id는 provider config에서 설정하고, 코드에 박지 않는다.

## Implementation Order

1. Provider runtime foundation.
   - registry, capability, provider job/cache type.
   - UI direct provider instantiation 제거.

2. Storage/API foundation.
   - local voice profile/correction list.
   - hosted PostgreSQL AI/TTS schema.
   - remote repository no-op 제거 또는 명확한 unsupported state.

3. LLM analysis MVP.
   - 현재 mock chapter labeling job route/worker는 구현됐다.
   - OpenAI, Gemini AI Studio, Gemini Vertex/Agent Platform, and Anthropic adapter foundation은 구현됐고, 실제 호출 smoke는 환경 설정 후 별도 실행한다.
   - chapter labeling, bundle analysis, bundle-to-merge UI handoff, validator, repair request/provider boundaries, repair job persistence, manual repair UI, manual speaker/emotion label review correction UI, and opt-in validation-failure auto-repair UI/policy are implemented.
   - 실제 호출은 서버 worker 또는 secure local adapter에서만 실행.

4. Smart TTS MVP.
   - `VoiceProfile` local/hosted 저장과 repository/API boundary는 구현됐다.
   - `tts-playback.ts` resolver는 paragraph label, speaker, role, character voice profile을 시스템 TTS 재생 큐로 해석한다.
   - 현재 UI는 TTS add-on에서 내레이터/시스템/화자 미정/캐릭터별 시스템 음성과 hosted provider voice id를 수동 지정할 수 있다.
   - TTS cache resolve route, `openai-tts`/`elevenlabs`/`gemini-tts`/`gemini-vertex-tts`/`google-cloud-tts`/`local-endpoint` synthesis adapters, worker-side text reconstruction/hash check, audio object write, authenticated audio read route, first reader cache playback path, active highlight, pure playback-session helpers, injected warmup queue runner, browser audio session adapter, opportunistic prefetch, bounded current/nearby-chapter warmup, and whole-book/background chapter-batch warmup are implemented.
   - TTS provider smoke runner is implemented for dry-run readiness, render/style option overrides, explicit one-call live synthesis smoke, and categorized safe provider error output. The committed tests cover local-endpoint live behavior through an injected fetch stub without external calls.
   - 남은 작업: non-Vertex external TTS live smoke and Google Cloud TTS REST permission/auth verification.

5. Provider expansion.
   - Provider settings storage/API/client/UI는 구현됐다. UI는 server catalog를 상한으로 삼고 non-secret default/model/options만 저장한다.
   - LLM provider smoke runner는 구현됐고, Gemini Vertex `gemini-3.1-flash-lite` one-call live smoke는 통과했다.
   - TTS provider smoke runner is implemented; dry-run readiness, option override parsing/secret rejection, categorized safe error formatting, and fetch-stub local-endpoint live path are covered by tests.
   - 남은 작업: OpenAI/Gemini AI Studio/Gemini Agent Platform/Anthropic live smoke, non-Vertex external TTS live smoke execution with real credentials, and Google Cloud TTS REST permission/auth verification.
   - provider별 option UI는 공통 capability/result를 통해 표시.

## 2026-08-01 native offline download boundary

- Provider resolution and synthesis remain behind `TTSCacheGateway`; UI code does not call an external TTS API.
- Native current/nearby/book preparation now persists a local download job and sentence items around the existing
  immutable render identity. A repair run reuses verified cache hits and renders missing identities.
- IndexedDB stores job progress and a manifest only. Native audio stays in the Tauri cache and retains size/hash
  verification, atomic commit, bounded temporary cleanup and corrupt-record quarantine.
- Cache cleanup accepts only a byte quota and protected cache keys. Access sidecars order unprotected records, and a
  2 GiB high-water mark evicts to 90%; provider credentials, source text and audio bytes do not enter the job record.
- Browser persistence, offline-only fallback and Android WorkManager constraints are implemented by later checkpoints.
  Device airplane-mode and process-death evidence remain open; this checkpoint alone must not be read as
  full offline-listening completion.

## 2026-08-01 spoken-text identity boundary

- TTS queue construction keeps exact source ranges and separately projects spoken text, source spans, skipped ranges
  and a fingerprint. No provider receives text directly from a UI component.
- Literal pronunciation, locale normalization, EPUB ruby readings and skip rules run before system/hosted/native
  synthesis. Hosted requests still reconstruct and verify original source ranges before accepting projected text.
- `inputTextHash` covers projected speech. Render `pronunciationFingerprint` combines the existing pronunciation
  revision with the spoken projection fingerprint, so a rule or semantic change cannot reuse stale audio.
- Persistent skip rules contain only the configured pattern/action; provider credentials and generated audio remain
  outside the rule store. Advanced regular expressions are not accepted in this slice.

## 2026-08-01 native offline retry boundary

- Native offline synthesis keeps job/item state in the local repository, while provider calls continue to cross the
  existing TTS cache gateway. React components do not call external providers directly.
- A transient item failure persists `retry_wait`, bounded error text and `nextAttemptAt`, then retries the same
  immutable render specification with policy-limited exponential backoff and jitter. Known auth, credential,
  permission, unsupported and invalid-voice failures fail without retry.
- App bootstrap recovers abandoned `planned/running/retry_wait` rows as explicit failures. It never deletes or invalidates
  ready cache records, and normal status refresh does not rerun recovery.
- This is in-process recovery, not an Android background scheduler. WorkManager constraints and OS-triggered resume
  must remain behind the mobile platform adapter and must not duplicate IndexedDB/provider credential ownership.

## 2026-08-01 Hosted browser offline-audio boundary

- Server cache resolve, worker synthesis and authenticated audio fetch remain behind `RemoteApiClient`; React does not
  call a provider API. The browser repository stores only the returned authenticated audio Blob and non-secret cache
  identity metadata.
- IndexedDB v31 indexes `(bookId, renderSpecHash, storage)`. Reads require an `indexeddb` manifest for the same book,
  matching Blob/cache key/byte size and a fresh SHA-256 calculation. Missing or corrupt local evidence is deleted and
  handled as a cache miss.
- Ordinary connected playback is local-first and uses network fetch plus best-effort write-through on a miss. Explicit
  current/nearby/book warmup requires a successful local commit before marking its durable download item ready.
  Offline-only performs no server attach, resolve, synthesis or audio fetch and falls back to system speech on a miss.
- Browser audio items are limited to 64 MiB. Unpinned entries use a 512 MiB high-water/90% low-water LRU policy. Cache
  audio remains derived data and is excluded from sync, Cloud Vault and exact backup.
- App-start recovery can use only verified Blob evidence to reconcile an interrupted item. It carries cache key, render
  hash, byte size and storage kind; source text, audio bytes, provider request and credentials do not enter the job
  recovery record.
- Origin quota and persistence status are observational metadata only. The app calls `navigator.storage.persist()`
  exclusively from a user action and does not treat denial as data loss or playback failure.
- Hosted bulk preparation retries only transient remote failures within the persisted download-job limit. Delay is
  cancellable jittered exponential backoff with a five-minute provider Retry-After ceiling. Credential,
  configuration, invalid request, payload-size, local storage and quota failures are stable and never auto-retried.
- Old-content cleanup is a local browser operation keyed by `bookId` and `activeContentRevisionId`. It deletes only
  unpinned `indexeddb` manifest/Blob pairs from older revisions in one transaction. It cannot delete another book,
  current-revision audio, native cache files or manually retained jobs, and it makes no provider/server request.

## 2026-08-01 Connected PDF derived-text TTS boundary

- The browser still calls only the configured NovelDesk server. Starting connected PDF TTS uploads a bounded ready
  native/OCR text page to an owned-book route; it does not send the PDF source or page bitmap through this endpoint.
- The server validates revision/book/page identity, source/status, block identity/order/text limits, direction and finite
  quads, then derives normalized text itself. Page replacement is transactional and prior ready revisions become stale.
- TTS render anchors remain the authority. Both immutable input pinning and worker execution load a ready block for the
  matching 0-based page/1-based fixed chapter, slice its exact offsets and verify render/input hashes before dispatch.
  No arbitrary raw-text field from the React request is forwarded to a provider and no fake labeled segment is stored.
- `offlineOnly` never invokes server attach, document-text upload, cache resolve or audio fetch. A missing verified local
  audio item falls back to the system provider under the existing fail-closed policy.
- Explicit PDF preparation accepts only a current/user-selected range capped at 50 pages. It materializes requests only
  from local ready native/OCR blocks, then uses the same exact render anchors and durable download item policy as normal
  warmup. Connected audio must pass the verified IndexedDB Blob boundary; desktop audio uses the native binary cache.
  Cancellation and partial failure retain already verified items and do not persist the PDF source or page bitmap.

## 2026-08-01 PDF OCR quality fence

- The current ready revision remains the source authority, but an OCR revision with `qualityScore < 0.45` or no score
  is not materialized into playback or offline warmup requests. The threshold is shared with the PDF OCR-candidate
  decision instead of being duplicated in provider adapters.
- Native PDF text bypasses this OCR-only fence. Rejected OCR text remains available for local review/search/annotation
  and is never deleted or rewritten by TTS.
- Hosted and native cache identities are therefore never created for text the client already classifies as unreliable.
  Explicit selection fails closed with a re-OCR explanation rather than falling through to another source block.

## 2026-08-01 Spoken-preview skip mutation boundary

- The preview action persists only a trimmed `skip_line` rule through `spoken-text-rule-store`; it never rewrites the
  paragraph, provider payload directly or an existing audio object.
- The next projection fingerprint naturally changes the render/cache identity for affected text. Duplicate active
  exact rules are suppressed in the UI, while prefix/suffix rules remain explicit advanced settings.
- Reader selection crosses the screen boundary only as local preview text. Opening the preview performs no provider
  call or persistence; the existing explicit save action remains the sole rule mutation.

## 2026-08-01 Spoken numeric normalization boundary

- Locale normalization validates date/time ranges and expands grouped Korean decimal tokens before generic integer
  matching. Fraction zeros remain audible and source spans still point to the complete original numeric token.
- Projection output changes flow through the existing fingerprint in `TTSRenderSpec`; source text, reading anchors and
  provider interfaces do not change, and no UI component performs numeric rewriting.

## 2026-08-01 Whole-book spoken skip impact boundary

- The impact preview is an explicit local/connected repository read initiated by the user. Opening TTS settings does
  not scan the book, enqueue a provider job, synthesize audio or mutate cache state.
- Paragraph pages are consumed sequentially through `ReaderRepository.iterateParagraphPages`; the scan keeps only
  counters and at most three 120-character contexts in React state. Closing the panel or changing rules aborts it.
- Impact is calculated by the production spoken-text projection, but only skipped ranges whose ids belong to active
  user skip rules are counted. EPUB footnote-marker policy is therefore not presented as a user-rule match.
- The summary is ephemeral. It is not persisted, synchronized, backed up or included in provider requests.

## 2026-08-01 Optional Compose-local MeloTTS boundary

- `compose.local-tts.yaml` adds a separately built `tts-model` service and sets hosted `local-endpoint` as the default
  TTS provider. API and worker use the existing provider interface and call only the internal service DNS name;
  React never calls the model container directly.
- The adapter implements the existing `/voices` and `/synthesize` contract, serializes access to one loaded model,
  bounds request text and supports WAV/MP3/OGG/FLAC responses. No TTS service port is published to the host.
- Model files live in `local-tts-models`; synthesized cache audio still follows the existing worker -> MinIO ->
  `tts_audio_cache` boundary. Model weights and source text do not enter sync or Cloud Vault payloads.
- MeloTTS source is pinned at image build time and the Korean model is downloaded on first start. Source and model
  cards declare MIT licensing; the optional sidecar is not bundled into normal NovelDesk application artifacts.
- The Compose adapter is CPU-first. GPU images/device reservations, multi-model routing and autoscaling remain
  explicit future work rather than hidden behavior in the generic provider.

## Sources

- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI Text to Speech: https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI Prompt Caching: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI Data Controls: https://developers.openai.com/api/docs/guides/your-data
- Gemini Structured Output: https://ai.google.dev/gemini-api/docs/structured-output
- Gemini Enterprise Agent Platform quickstart: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start
- Google Gen AI SDK overview: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/sdks/overview
- Gemini Enterprise Agent Platform structured output: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output
- Google Cloud Application Default Credentials: https://docs.cloud.google.com/docs/authentication/application-default-credentials
- Vertex AI Gemini samples: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/googlegenaisdk-textgen-with-txt
- Vertex AI Google Gen AI SDK migration: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/deprecations/genai-vertexai-sdk
- Gemini 3.1 Flash-Lite model card: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
- Vertex AI Google models: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/code/code-models-overview
- Claude Structured Outputs: https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/increase-consistency
- Claude Messages API: https://docs.anthropic.com/en/api/messages
- Claude Errors: https://docs.anthropic.com/en/api/errors
- ElevenLabs Text to Speech: https://elevenlabs.io/docs/overview/capabilities/text-to-speech
- ElevenLabs API Authentication: https://elevenlabs.io/docs/api-reference/authentication
- ElevenLabs Text to Speech Convert API: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- Gemini API TTS: https://ai.google.dev/gemini-api/docs/speech-generation
- Google Cloud Gemini TTS: https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
