import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function declarationBlock(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return '';
}

function typescriptInterfaceFields(source, name) {
  const signature = source.match(new RegExp(`interface\\s+${name}(?:\\s+extends\\s+[^\\{]+)?\\s*\\{`))?.[0] ?? '';
  const block = signature ? declarationBlock(source, signature) : '';
  return [...block.matchAll(/\breadonly\s+([A-Za-z][A-Za-z0-9]*)(?:\?)?\s*:/g)].map((match) => match[1]).sort();
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
}

function rustStructFields(source, name) {
  const block = declarationBlock(source, `struct ${name} {`);
  return [...block.matchAll(/\bpub(?:\([^)]*\))?\s+([a-z][a-z0-9_]*)\s*:/g)]
    .map((match) => snakeToCamel(match[1]))
    .sort();
}

function rustDeclaredFields(source, name) {
  const block = declarationBlock(source, `struct ${name} {`);
  return [...block.matchAll(/^\s+(?:pub(?:\([^)]*\))?\s+)?([a-z][a-z0-9_]*)\s*:/gm)]
    .map((match) => snakeToCamel(match[1]))
    .sort();
}

function rustFunctionParameterFields(source, name) {
  const match = source.match(new RegExp(`fn\\s+${name}\\s*\\(([^)]*)\\)`, 's'));
  if (!match) return [];
  return [...match[1].matchAll(/(?:^|,)\s*([a-z][a-z0-9_]*)\s*:/g)].map((item) => snakeToCamel(item[1])).sort();
}

function sameFields(left, right) {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

const files = {
  rustLib: read('src-tauri/src/lib.rs'),
  rustApp: read('src-tauri/src/app.rs'),
  rustSecrets: read('src-tauri/src/provider_secrets.rs'),
  rustAiContract: read('src-tauri/src/ai/command_contract.rs'),
  rustAiBridge: read('src-tauri/src/ai/bridge.rs'),
  rustTtsContract: read('src-tauri/src/tts/command_contract.rs'),
  rustTtsBridge: read('src-tauri/src/tts/bridge.rs'),
  rustTtsCacheContract: read('src-tauri/src/tts/cache_contract.rs'),
  rustTtsCacheIdentity: read('src-tauri/src/tts/cache_identity.rs'),
  rustTtsCacheRecord: read('src-tauri/src/tts/cache_record.rs'),
  rustTtsCacheRuntime: read('src-tauri/src/tts/cache_runtime.rs'),
  rustTtsRenderCache: read('src-tauri/src/tts/render_cache.rs'),
  rustWorkflowContract: read('src-tauri/src/workflow/command_contract.rs'),
  rustWorkflowCompaction: read('src-tauri/src/workflow/compaction.rs'),
  rustWorkflowJournal: read('src-tauri/src/workflow/journal.rs'),
  rustWorkflowMod: read('src-tauri/src/workflow/mod.rs'),
  rustWorkflowState: read('src-tauri/src/workflow/state.rs'),
  rustWorkflowStore: read('src-tauri/src/workflow/store.rs'),
  rustWorkflowStoreTest: read('src-tauri/src/workflow/store.test.rs'),
  rustWorkflowPersistenceTest: read('src-tauri/src/workflow/persistence.test.rs'),
  rustWorkflowReviewEvidence: read('src-tauri/src/workflow/review_evidence.rs'),
  rustWorkflowReviewStore: read('src-tauri/src/workflow/review_store.rs'),
  rustWorkflowReviewTransition: read('src-tauri/src/workflow/review_transition.rs'),
  rustWorkflowReviewTest: read('src-tauri/src/workflow/review.test.rs'),
  rustWorkflowTestSupport: read('src-tauri/src/workflow/test_support.rs'),
  rustWorkflowRuntime: read('src-tauri/src/workflow/runtime.rs'),
  rustWorkflowBridge: read('src-tauri/src/workflow/bridge.rs'),
  desktopAi: read('src/providers/desktop-structured-json-provider.ts'),
  serverAi: read('apps/server/src/providers/server-structured-json-provider.ts'),
  workflowPlan: read('src/providers/book-ai-workflow-plan.ts'),
  nativeWorkflowContracts: read('src/features/ai/native-workflow/contracts.ts'),
  nativeWorkflowManifest: read('src/features/ai/native-workflow/manifest.ts'),
  labelingContract: read('src/providers/chapter-labeling-contract.ts'),
  desktopTts: read('src/providers/desktop-tts-provider.ts'),
  ttsRenderSpec: read('src/providers/tts-render-spec.ts'),
  ttsCacheGateway: read('src/features/tts/tts-cache-gateway.ts'),
  nativeTtsCacheGateway: read('src/platform/tauri/native-tts-cache-gateway.ts'),
  providerJobs: read('src/providers/provider-jobs.ts'),
  capability: read('src-tauri/capabilities/default.json'),
};

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
}

const aiTsFields = typescriptInterfaceFields(files.desktopAi, 'DesktopStructuredJsonGenerateInput').filter(
  (field) => field !== 'generationPolicy',
);
const aiRustFields = rustStructFields(files.rustAiContract, 'DesktopStructuredJsonRequest');
check(
  'desktop structured JSON transport DTO field parity',
  sameFields(aiTsFields, aiRustFields),
  `TypeScript=${aiTsFields.join(',')} Rust=${aiRustFields.join(',')}`,
);

const ttsTsFields = typescriptInterfaceFields(files.desktopTts, 'DesktopTTSSynthesisInput');
const ttsRustFields = rustStructFields(files.rustTtsContract, 'DesktopTTSSynthesisRequest');
check(
  'desktop TTS request DTO field parity',
  sameFields(ttsTsFields, ttsRustFields),
  `TypeScript=${ttsTsFields.join(',')} Rust=${ttsRustFields.join(',')}`,
);

const ttsResultTsFields = typescriptInterfaceFields(files.desktopTts, 'DesktopTTSSynthesisCommandResult');
const ttsResultRustFields = rustStructFields(files.rustTtsContract, 'DesktopTTSSynthesisResult');
check(
  'desktop TTS result DTO field parity',
  sameFields(ttsResultTsFields, ttsResultRustFields),
  `TypeScript=${ttsResultTsFields.join(',')} Rust=${ttsResultRustFields.join(',')}`,
);

const canonicalRequestBuilders = [
  'buildChapterLabelingRequest',
  'buildChapterLabelRepairRequest',
  'buildCharacterBundleAnalysisRequest',
  'buildCharacterGraphMergeRequest',
];
check(
  'desktop/server AI adapters share canonical labeling and graph request builders',
  canonicalRequestBuilders.every((name) => files.desktopAi.includes(`${name}(`) && files.serverAi.includes(`${name}(`)),
  `required builders: ${canonicalRequestBuilders.join(', ')}`,
);
check(
  'native workflow reuses canonical provider-neutral AI requests and stage names',
  ['character_graph_bootstrap', 'character_graph_merge', 'chapter_labeling', 'tts_ready_preparation'].every((stage) =>
    new RegExp(`["']${stage}["']`).test(files.workflowPlan),
  ) &&
    ['CharacterGraphBootstrap', 'CharacterGraphMerge', 'ChapterLabeling', 'TtsReadyPreparation'].every((stage) =>
      files.rustWorkflowContract.includes(stage),
    ) &&
    files.rustWorkflowContract.includes('request: Option<DesktopStructuredJsonRequest>') &&
    files.rustWorkflowContract.includes('NativeBookWorkflowMaterializeRequest') &&
    files.rustWorkflowRuntime.includes('desktop_ai_generate_json_impl(Some(app), claim.request.clone())'),
  'TypeScript owns planning/prompt policy; Rust persists and executes the existing provider-neutral request DTO',
);
const workflowSubmitTsFields = typescriptInterfaceFields(
  files.nativeWorkflowContracts,
  'NativeBookWorkflowSubmitRequest',
);
const workflowSubmitRustFields = rustStructFields(files.rustWorkflowContract, 'NativeBookWorkflowSubmitRequest');
check(
  'native workflow v2 submit DTO and canonical plan hash stay shared',
  sameFields(workflowSubmitTsFields, workflowSubmitRustFields) &&
    files.nativeWorkflowManifest.includes('NATIVE_BOOK_WORKFLOW_PLAN_SCHEMA_VERSION = 2') &&
    files.nativeWorkflowManifest.includes('schemaVersion') &&
    files.nativeWorkflowManifest.includes('itemIds') &&
    files.rustWorkflowContract.includes('WORKFLOW_SCHEMA_VERSION: u32 = 2') &&
    files.rustWorkflowContract.includes('NativeWorkflowPlanIdentity') &&
    files.rustWorkflowContract.includes('item_ids'),
  `TypeScript=${workflowSubmitTsFields.join(',')} Rust=${workflowSubmitRustFields.join(',')}`,
);
check(
  'native workflow boundary is durable, idempotent, restartable, and cancel-fenced',
  files.rustWorkflowStore.includes('native-book-workflows-v1.jsonl') &&
    files.rustWorkflowJournal.includes('.append(true)') &&
    files.rustWorkflowJournal.includes('file.sync_all()') &&
    files.rustWorkflowState.includes('payload_hash') &&
    files.rustWorkflowStore.includes('recover_interrupted') &&
    files.rustWorkflowStore.includes('WorkflowRequeueReason::ProcessRestart') &&
    files.rustWorkflowStore.includes('workflow.fence != claim.fence') &&
    files.rustWorkflowStore.includes('workflow.fence + 1') &&
    files.rustWorkflowStore.includes('materialized request drift was rejected') &&
    files.rustWorkflowJournal.includes('file.set_len(valid_len)') &&
    files.rustWorkflowJournal.includes('integrity_hash(&request)? != request_hash') &&
    files.rustWorkflowJournal.includes('integrity_hash(&checkpoint.output)?') &&
    files.rustWorkflowCompaction.includes('COMPACTING_SUFFIX') &&
    files.rustWorkflowCompaction.includes('SnapshotCompleted') &&
    files.rustWorkflowCompaction.includes('state_hash: integrity_hash(workflows)?') &&
    files.rustWorkflowCompaction.includes('file.sync_all()') &&
    files.rustWorkflowCompaction.includes('compact_completed_requests') &&
    files.rustWorkflowJournal.includes('JobMaterialized') &&
    files.rustWorkflowJournal.includes('ReadinessFinalized') &&
    files.rustWorkflowJournal.includes('ReviewRequired') &&
    files.rustWorkflowState.includes('LEGACY_WORKFLOW_SCHEMA_VERSION') &&
    files.rustWorkflowContract.includes('WaitingForInput') &&
    files.rustWorkflowContract.includes('NeedsReview') &&
    files.rustWorkflowContract.includes('schema_version: u32') &&
    files.rustWorkflowReviewEvidence.includes('MAX_REVIEW_BYTES') &&
    files.rustWorkflowJournal.includes('native workflow stage transition is invalid') &&
    files.rustWorkflowContract.includes('can_transition_to') &&
    files.rustApp.includes('native_book_workflow_submit') &&
    files.rustApp.includes('native_book_workflow_active_get') &&
    files.rustApp.includes('native_book_workflow_materialize') &&
    files.rustApp.includes('native_book_workflow_finalize_readiness') &&
    files.rustApp.includes('native_book_workflow_require_review') &&
    files.rustApp.includes('native_book_workflow_resume') &&
    files.rustApp.includes('native_book_workflow_cancel') &&
    files.rustApp.includes('native_book_workflow_checkpoint_get') &&
    files.rustWorkflowRuntime.includes('finish_runner') &&
    files.rustWorkflowRuntime.includes('Self::should_spawn(&view)'),
  'workflow state changes must remain fsynced events with immutable submit identity, restart requeue, and stale-result fencing',
);
check(
  'native workflow responsibilities remain split across state, journal, and store modules',
  files.rustWorkflowState.includes('struct PersistedWorkflow') &&
    files.rustWorkflowJournal.includes('fn apply_event(') &&
    files.rustWorkflowStore.includes('pub(crate) fn claim_next('),
);
check(
  'Rust AI bridge does not duplicate canonical labeling schema or segment vocabulary',
  !`${files.rustAiContract.split('#[cfg(test)]')[0]}\n${files.rustAiBridge}`.includes('chapter-labeling-result-v1') &&
    !`${files.rustAiContract.split('#[cfg(test)]')[0]}\n${files.rustAiBridge}`.includes('quoted_dialogue') &&
    files.labelingContract.includes("CHAPTER_LABELING_SCHEMA_VERSION = 'chapter-labeling-result-v1'"),
  'labeling schema/version and segment labels must stay in the canonical TypeScript contract',
);
check(
  'native command inputs have runtime validation and reject unknown fields',
  files.rustAiContract.includes('deny_unknown_fields') &&
    files.rustAiBridge.includes('request.validate()?;') &&
    files.rustTtsContract.includes('deny_unknown_fields') &&
    files.rustTtsBridge.includes('request.validate()?;'),
  'both AI and TTS Tauri command DTOs need semantic and unknown-field validation',
);
check(
  'native TTS preserves synthesis source text',
  files.rustTtsBridge.includes('let text = request.text.as_str();') &&
    !files.rustTtsBridge.includes('let text = request.text.trim();'),
  'blank checks may trim for validation, but provider input must preserve the supplied text',
);

const nativeTtsSpecTsFields = typescriptInterfaceFields(files.ttsRenderSpec, 'TTSRenderSpec');
const nativeTtsSpecRustFields = rustDeclaredFields(files.rustTtsCacheContract, 'NativeTTSRenderSpec');
check(
  'native TTS v2 uses the complete canonical render spec identity',
  sameFields(nativeTtsSpecTsFields, nativeTtsSpecRustFields) &&
    files.rustTtsCacheIdentity.includes('integrity_hash(&RenderSpecIdentity') &&
    files.rustTtsCacheIdentity.includes('persistent_id128("tts", &[&content_revision, &render_spec_hash])') &&
    files.rustTtsCacheIdentity.includes('text_integrity_hash(&synthesis.text)') &&
    files.rustTtsCacheIdentity.includes('native TTS does not support non-default pitch'),
  `TypeScript=${nativeTtsSpecTsFields.join(',')} Rust=${nativeTtsSpecRustFields.join(',')}`,
);
const nativeTtsRenderRequestFields = rustDeclaredFields(files.rustTtsCacheContract, 'NativeTTSRenderRequest');
const nativeTtsExpectedRenderTsFields = typescriptInterfaceFields(files.ttsCacheGateway, 'TTSCacheExpectedRender');
const nativeTtsExpectedRenderRustFields = rustDeclaredFields(files.rustTtsCacheContract, 'NativeTTSExpectedRender');
const nativeTtsRenderInputTsFields = [
  ...typescriptInterfaceFields(files.ttsCacheGateway, 'TTSCacheRenderInput'),
  ...nativeTtsExpectedRenderTsFields,
].sort();
const nativeTtsRenderResultTsFields = typescriptInterfaceFields(
  files.nativeTtsCacheGateway,
  'NativeTTSCacheRenderCommandResult',
);
const nativeTtsRenderResultRustFields = rustDeclaredFields(files.rustTtsCacheContract, 'NativeTTSRenderResult');
const nativeTtsCacheFields = rustDeclaredFields(files.rustTtsCacheRecord, 'NativeTTSCacheRecord');
const nativeTtsValidationIndex = files.rustTtsCacheRuntime.indexOf('validate_render_request(&request)?;');
const nativeTtsCacheReadIndex = files.rustTtsCacheRuntime.indexOf('read_cache_record(cache_dir, &identity)?');
check(
  'native TTS v2 validates secrets and immutable metadata before cache lookup',
  sameFields(nativeTtsExpectedRenderTsFields, nativeTtsExpectedRenderRustFields) &&
    sameFields(nativeTtsRenderInputTsFields, nativeTtsRenderRequestFields) &&
    sameFields(nativeTtsRenderResultTsFields, nativeTtsRenderResultRustFields) &&
    nativeTtsValidationIndex >= 0 &&
    nativeTtsCacheReadIndex >= 0 &&
    nativeTtsValidationIndex < nativeTtsCacheReadIndex &&
    files.rustTtsCacheIdentity.includes('ensure_non_secret_provider_options(&request.synthesis.provider_options)') &&
    !nativeTtsCacheFields.includes('text') &&
    !nativeTtsCacheFields.includes('providerOptions') &&
    !nativeTtsCacheFields.some((field) => /secretValue|apiKey|credentialPath|endpointUrl/i.test(field)) &&
    !files.rustTtsCacheRecord.includes('provider_request_id: result.provider_request_id') &&
    files.rustTtsCacheRecord.includes('file.sync_all()') &&
    files.rustTtsCacheRecord.includes('sync_parent(cache_dir)?'),
  `expected TypeScript=${nativeTtsExpectedRenderTsFields.join(',')} Rust=${nativeTtsExpectedRenderRustFields.join(',')} request TypeScript=${nativeTtsRenderInputTsFields.join(',')} Rust=${nativeTtsRenderRequestFields.join(',')} result TypeScript=${nativeTtsRenderResultTsFields.join(',')} Rust=${nativeTtsRenderResultRustFields.join(',')} cache fields=${nativeTtsCacheFields.join(',')}`,
);
check(
  'native TTS v2 exposes restart readiness and cancellable per-key deduplicated rendering',
  files.rustApp.includes('native_tts_render_cached') &&
    files.rustApp.includes('native_tts_cache_readiness') &&
    files.rustApp.includes('native_tts_operation_cancel') &&
    files.rustTtsCacheRuntime.includes('planned') &&
    files.rustTtsCacheRuntime.includes('ready_count') &&
    files.rustTtsCacheRuntime.includes('missing_count') &&
    files.rustTtsCacheRuntime.includes('evidence_hash') &&
    files.rustTtsCacheRuntime.includes('key_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>') &&
    files.rustTtsCacheRuntime.includes('MAX_PENDING_CANCELLATIONS') &&
    files.rustTtsCacheRuntime.includes('PendingCancellation') &&
    files.rustTtsCacheRuntime.includes('race_cancellation') &&
    files.rustTtsCacheRuntime.includes('operation.commit(|| persist_cache_record') &&
    files.rustTtsCacheIdentity.includes('effective_provider_model') &&
    files.rustTtsCacheIdentity.includes('gpt-4o-mini-tts') &&
    files.rustTtsCacheIdentity.includes('eleven_flash_v2_5') &&
    files.rustTtsCacheContract.includes('MAX_READINESS_RENDERS') &&
    files.rustTtsCacheIdentity.includes('request.expected.len() > MAX_READINESS_RENDERS') &&
    files.rustTtsRenderCache.includes('spawn_blocking(move || cache_readiness_at') &&
    files.rustTtsCacheRecord.includes('cleanup_stale_temporary_files_at') &&
    files.rustTtsCacheRecord.includes('STALE_TEMPORARY_AGE_MS'),
  'render/readiness/cancel commands must share restart-safe records, cancellation fencing, and per-key locks',
);
const nativeTtsReadinessInputTsFields = typescriptInterfaceFields(files.ttsCacheGateway, 'TTSCacheReadinessInput');
const nativeTtsReadinessInputRustFields = rustDeclaredFields(
  files.rustTtsCacheContract,
  'NativeTTSCacheReadinessRequest',
);
const nativeTtsReadinessTsFields = typescriptInterfaceFields(files.ttsCacheGateway, 'TTSCacheReadiness');
const nativeTtsReadinessRustFields = rustDeclaredFields(files.rustTtsCacheContract, 'NativeTTSCacheReadinessResult');
const nativeTtsCancelResultRustFields = rustDeclaredFields(
  files.rustTtsCacheContract,
  'NativeTTSOperationCancelResult',
);
check(
  'native TTS command DTOs and Tauri parameters match the real gateway contracts',
  sameFields(nativeTtsReadinessInputTsFields, nativeTtsReadinessInputRustFields) &&
    sameFields(nativeTtsReadinessTsFields, nativeTtsReadinessRustFields) &&
    sameFields(nativeTtsCancelResultRustFields, ['cancelled', 'operationId']) &&
    sameFields(rustFunctionParameterFields(files.rustTtsRenderCache, 'native_tts_render_cached'), ['app', 'request']) &&
    sameFields(rustFunctionParameterFields(files.rustTtsRenderCache, 'native_tts_cache_readiness'), [
      'app',
      'request',
    ]) &&
    sameFields(rustFunctionParameterFields(files.rustTtsRenderCache, 'native_tts_operation_cancel'), [
      'app',
      'operationId',
    ]),
  `readiness input TypeScript=${nativeTtsReadinessInputTsFields.join(',')} Rust=${nativeTtsReadinessInputRustFields.join(',')} readiness result TypeScript=${nativeTtsReadinessTsFields.join(',')} Rust=${nativeTtsReadinessRustFields.join(',')} cancel Rust=${nativeTtsCancelResultRustFields.join(',')}`,
);
check(
  'native TTS cache responsibilities remain split across contract, identity, record, runtime, and command modules',
  files.rustTtsCacheContract.includes('struct NativeTTSRenderSpec') &&
    files.rustTtsCacheIdentity.includes('fn validate_render_request(') &&
    files.rustTtsCacheRecord.includes('struct NativeTTSCacheRecord') &&
    files.rustTtsCacheRuntime.includes('fn render_cached_with') &&
    files.rustTtsRenderCache.includes('fn native_tts_render_cached'),
);

const secretStatusTsFields = typescriptInterfaceFields(files.providerJobs, 'ProviderSecretStatus');
const secretStatusRustFields = rustDeclaredFields(files.rustSecrets, 'ProviderSecretStatus');
const permittedSecretStatusFields = new Set(secretStatusTsFields);
check(
  'native secret status is a status-only TypeScript-compatible subset',
  secretStatusRustFields.every((field) => permittedSecretStatusFields.has(field)) &&
    !secretStatusRustFields.some((field) => /secretValue|apiKey|credentialPath|endpointUrl/i.test(field)),
  `TypeScript=${secretStatusTsFields.join(',')} Rust=${secretStatusRustFields.join(',')}`,
);
check(
  'no provider secret read-back command is exposed to JS',
  !files.rustApp.includes('provider_secret_get') &&
    !files.capability.includes('providerSecretStore') &&
    !files.capability.includes('getSecret') &&
    files.rustApp.includes('provider_secret_status'),
  'only set/status/delete/test commands and derived status metadata may cross the JS boundary',
);
check(
  'lib.rs remains a composition root',
  files.rustLib.includes('pub use app::run;') &&
    files.rustLib.includes('mod app;') &&
    files.rustLib.includes('mod ai;') &&
    files.rustLib.includes('mod tts;'),
  'provider implementation must stay in app/secret/http/AI/TTS modules',
);

for (const item of checks) {
  console.log(`${item.passed ? '[통과]' : '[실패]'} ${item.name}${item.passed ? '' : ` - ${item.detail}`}`);
}

const failures = checks.filter((item) => !item.passed);
if (failures.length > 0) {
  console.error(`\nNative parity 정적 검사 실패: ${failures.length}개`);
  process.exit(1);
}

console.log(`\nNative parity 정적 검사 통과: ${checks.length}개`);
console.log(
  '범위: command DTO, durable native workflow, canonical AI delegation, TTS render/cache identity, secret non-readback, Rust module boundary.',
);
console.log('제외: live provider 호출, APK 빌드/실기기 smoke.');
