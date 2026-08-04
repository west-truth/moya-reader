import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function hasArg(name) {
  return args.includes(name);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  return `${trimTrailingSlash(base)}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function jsonBody(body) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function firstTxtUnder(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const txt = entries
    .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.txt'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!txt) throw new Error(`No .txt file found under ${directory}`);
  return path.join(directory, txt);
}

const dryRun = hasArg('--dry-run');
const keepBook = hasArg('--keep-book') || process.env.HOSTED_AI_WORKFLOW_KEEP_BOOK === '1';
const webBaseUrl = trimTrailingSlash(argValue('--web-url', process.env.HOSTED_WEB_URL ?? 'http://127.0.0.1:8080'));
const apiBaseUrl = trimTrailingSlash(argValue('--api-url', process.env.HOSTED_API_URL ?? joinUrl(webBaseUrl, '/api')));
const timeoutMs = Number(
  argValue(
    '--timeout-ms',
    process.env.HOSTED_AI_WORKFLOW_TIMEOUT_MS ?? process.env.HOSTED_SMOKE_TIMEOUT_MS ?? '300000',
  ),
);
const pollIntervalMs = Number(argValue('--poll-interval-ms', process.env.HOSTED_AI_WORKFLOW_POLL_MS ?? '1000'));
const authToken = argValue(
  '--auth-token',
  process.env.HOSTED_API_AUTH_TOKEN ?? process.env.READER_AUTH_TOKEN ?? process.env.VITE_API_AUTH_TOKEN ?? '',
).trim();
const sourcePathArg = argValue('--file', process.env.HOSTED_AI_WORKFLOW_FILE ?? '');
const sourceDir = argValue('--source-dir', process.env.HOSTED_AI_WORKFLOW_SOURCE_DIR ?? 'test_novel');
const maxSourceCharacters = Number(
  argValue('--max-source-characters', process.env.HOSTED_AI_WORKFLOW_MAX_SOURCE_CHARS ?? '180000'),
);
const uploadChunkBytes = Number(argValue('--chunk-bytes', process.env.HOSTED_AI_WORKFLOW_CHUNK_BYTES ?? '262144'));
const maxWorkflowWindows = Number(
  argValue('--max-workflow-windows', process.env.HOSTED_AI_WORKFLOW_MAX_WINDOWS ?? '160'),
);
const maxLabelingParagraphs = Number(
  argValue('--max-labeling-paragraphs', process.env.HOSTED_AI_WORKFLOW_MAX_LABELING_PARAGRAPHS ?? '4'),
);
const maxBundleChapters = Number(
  argValue('--max-bundle-chapters', process.env.HOSTED_AI_WORKFLOW_MAX_BUNDLE_CHAPTERS ?? '3'),
);
const targetBundleCharacters = Number(
  argValue('--target-bundle-characters', process.env.HOSTED_AI_WORKFLOW_TARGET_BUNDLE_CHARS ?? '30000'),
);
const targetLabelingCharacters = Number(
  argValue('--target-labeling-characters', process.env.HOSTED_AI_WORKFLOW_TARGET_LABELING_CHARS ?? '12000'),
);
const smokeId = `ai_workflow_smoke_${Date.now()}`;
const syncPageLimit = 500;
const maxSyncPages = 1000;

function authHeaders(extra = {}) {
  return {
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...extra,
  };
}

async function request(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : joinUrl(apiBaseUrl, pathOrUrl);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed with ${response.status}: ${text || response.statusText}`);
  }
  return body;
}

function syncEvents(response) {
  assert(Array.isArray(response.events), 'sync pull did not return an events array');
  return response.events;
}

function syncCursor(response, previousCursor) {
  const cursor = Number(response.cursor ?? previousCursor);
  assert(Number.isFinite(cursor), 'sync pull did not return a numeric cursor');
  return cursor;
}

function eventPayload(event) {
  if (!event?.payload) return {};
  if (typeof event.payload === 'string') {
    try {
      return JSON.parse(event.payload);
    } catch {
      return {};
    }
  }
  return event.payload;
}

function hasSyncEvent(events, type, predicate) {
  return events.some((event) => event.type === type && predicate(event, eventPayload(event)));
}

function assertSyncEvent(events, type, predicate) {
  assert(hasSyncEvent(events, type, predicate), `sync pull did not include expected ${type} event`);
}

async function syncCursorAtEnd() {
  let cursor = 0;
  for (let page = 0; page < maxSyncPages; page += 1) {
    const response = await request(`/sync?since=${encodeURIComponent(String(cursor))}`);
    const events = syncEvents(response);
    const nextCursor = syncCursor(response, cursor);
    if (!events.length || nextCursor === cursor) return cursor;
    cursor = nextCursor;
    if (events.length < syncPageLimit) return cursor;
  }
  throw new Error(`Sync cursor drain exceeded ${maxSyncPages} pages`);
}

async function pullSyncEventsSince(cursor) {
  let currentCursor = cursor;
  const allEvents = [];
  for (let page = 0; page < maxSyncPages; page += 1) {
    const response = await request(`/sync?since=${encodeURIComponent(String(currentCursor))}`);
    const events = syncEvents(response);
    const nextCursor = syncCursor(response, currentCursor);
    allEvents.push(...events);
    if (!events.length || nextCursor === currentCursor) return allEvents;
    currentCursor = nextCursor;
    if (events.length < syncPageLimit) return allEvents;
  }
  throw new Error(`Sync pull exceeded ${maxSyncPages} pages`);
}

async function waitForImport(jobId) {
  const startedAt = Date.now();
  let lastJob;
  while (Date.now() - startedAt < timeoutMs) {
    const job = await request(`/import-jobs/${encodeURIComponent(jobId)}`);
    lastJob = job;
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new Error(`Import job failed: ${job.error_message ?? job.message ?? jobId}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Import job timed out after ${timeoutMs}ms: ${JSON.stringify(lastJob)}`);
}

async function waitForWorkflow(workflowId) {
  const startedAt = Date.now();
  let lastWorkflow;
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(`/analysis-workflows/${encodeURIComponent(workflowId)}`);
    const workflow = response.workflow;
    lastWorkflow = workflow;
    if (workflow?.status === 'succeeded') return workflow;
    if (['needs_review', 'failed', 'cancelled'].includes(workflow?.status)) {
      throw new Error(
        `AI workflow ended as ${workflow.status}/${workflow.stage}: ${workflow.errorMessage ?? workflow.errorCode ?? JSON.stringify(workflow.progress ?? {})}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`AI workflow timed out after ${timeoutMs}ms: ${JSON.stringify(lastWorkflow)}`);
}

async function readSourceText() {
  const sourcePath = sourcePathArg ? path.resolve(sourcePathArg) : await firstTxtUnder(path.resolve(sourceDir));
  const text = await fs.readFile(sourcePath, 'utf8');
  const boundedText =
    Number.isFinite(maxSourceCharacters) && maxSourceCharacters > 0 ? text.slice(0, maxSourceCharacters) : text;
  assert(boundedText.trim().length > 0, `Source text is empty: ${sourcePath}`);
  return { sourcePath, text: boundedText, originalCharacters: text.length };
}

async function uploadAndImportBook(source) {
  const bytes = new TextEncoder().encode(source.text);
  const safeChunkBytes =
    Number.isFinite(uploadChunkBytes) && uploadChunkBytes > 0 ? Math.floor(uploadChunkBytes) : 262144;
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / safeChunkBytes));
  const upload = await request('/uploads/init', {
    method: 'POST',
    ...jsonBody({
      fileName: `${smokeId}.txt`,
      sizeBytes: bytes.byteLength,
      contentType: 'text/plain',
      encoding: 'utf-8',
      chapterSplitMode: 'mixed',
      totalChunks,
      clientBookId: smokeId,
    }),
  });
  assert(typeof upload.uploadId === 'string', 'upload init did not return uploadId');

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * safeChunkBytes;
    const chunk = bytes.slice(start, Math.min(bytes.byteLength, start + safeChunkBytes));
    const chunkResult = await request(`/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${chunkIndex}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    });
    assert(chunkResult.chunkIndex === chunkIndex, `chunk ${chunkIndex} response returned wrong index`);
    assert(chunkResult.sizeBytes === chunk.byteLength, `chunk ${chunkIndex} response returned wrong size`);
  }

  const complete = await request(`/uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST' });
  assert(typeof complete.jobId === 'string', 'upload complete did not return jobId');
  const job = await waitForImport(complete.jobId);
  const bookId = job.book_id ?? smokeId;
  assert(bookId, 'completed import job did not include book_id');
  return { bookId, byteLength: bytes.byteLength, totalChunks };
}

function mockVoiceProfiles(bookId) {
  const now = new Date().toISOString();
  const profile = (id, role, label, characterId) => ({
    id: `voice_${bookId}_${id}`,
    novelId: bookId,
    characterId,
    role,
    providerId: 'system',
    providerVoiceId: 'default',
    label,
    speed: 1,
    providerOptions: {},
    isUserSelected: true,
    createdAt: now,
    updatedAt: now,
  });
  return [
    profile('narrator', 'narrator', 'Mock narrator'),
    profile('system', 'system', 'Mock system'),
    profile('unknown', 'unknown', 'Mock unknown'),
    profile('char_hyun', 'character', 'Mock char_hyun', 'char_hyun'),
    profile('char_minseo', 'character', 'Mock char_minseo', 'char_minseo'),
    profile('char_system', 'character', 'Mock char_system', 'char_system'),
  ];
}

async function run() {
  console.log(`Hosted AI workflow smoke target: web=${webBaseUrl} api=${apiBaseUrl}`);
  const source = await readSourceText();
  console.log(`Source: ${source.sourcePath} (${source.text.length}/${source.originalCharacters} chars used)`);
  if (dryRun) {
    console.log('Dry run only; no network requests were made.');
    return;
  }

  const ready = await request(joinUrl(webBaseUrl, '/ready'));
  assert(ready.ok === true, 'readiness endpoint did not return ok=true');
  assert(ready.components?.database?.ok === true, 'readiness database check failed');
  assert(ready.components?.queue?.ok === true, 'readiness queue check failed');

  let bookId;
  try {
    const imported = await uploadAndImportBook(source);
    bookId = imported.bookId;
    console.log(
      `ok imported AI workflow smoke book ${bookId} (${imported.byteLength} bytes, ${imported.totalChunks} chunk(s))`,
    );

    const chapters = await request(`/books/${encodeURIComponent(bookId)}/chapters`);
    assert(Array.isArray(chapters.chapters) && chapters.chapters.length >= 1, 'chapters endpoint returned no chapters');
    const firstChapter = chapters.chapters[0];
    const planQuery = new URLSearchParams({
      maxBundleChapters: String(maxBundleChapters),
      targetBundleCharacters: String(targetBundleCharacters),
      maxLabelingParagraphs: String(maxLabelingParagraphs),
      targetLabelingCharacters: String(targetLabelingCharacters),
    });
    const planResponse = await request(`/books/${encodeURIComponent(bookId)}/analysis-workflow-plan?${planQuery}`);
    const plan = planResponse.plan;
    assert(plan?.bundleWindows?.length >= 1, 'workflow plan did not include graph bundle windows');
    assert(plan?.labelingWindows?.length >= 1, 'workflow plan did not include labeling windows');
    if (Number.isFinite(maxWorkflowWindows) && maxWorkflowWindows > 0) {
      assert(
        plan.labelingWindows.length <= maxWorkflowWindows,
        `workflow plan has ${plan.labelingWindows.length} labeling windows, above max ${maxWorkflowWindows}. Increase --max-workflow-windows or reduce --max-source-characters.`,
      );
    }
    console.log(
      `ok planned AI workflow (${plan.bundleWindows.length} bundle(s), ${plan.labelingWindows.length} labeling window(s))`,
    );

    const syncCursor = await syncCursorAtEnd();
    const voices = await request(`/books/${encodeURIComponent(bookId)}/voice-profiles`, {
      method: 'PUT',
      ...jsonBody({ voiceProfiles: mockVoiceProfiles(bookId) }),
    });
    assert(voices.ok === true && voices.voiceProfiles?.length >= 6, 'voice profile save failed');
    console.log('ok saved mock system voice profiles for readiness');

    const started = await request(`/books/${encodeURIComponent(bookId)}/analysis-workflows`, {
      method: 'POST',
      ...jsonBody({
        providerId: 'mock',
        modelId: 'mock-segment-labeler-v1',
        force: true,
        planOptions: {
          maxBundleChapters,
          targetBundleCharacters,
          maxLabelingParagraphs,
          targetLabelingCharacters,
        },
      }),
    });
    const workflowId = started.workflow?.id;
    assert(typeof workflowId === 'string', 'analysis workflow start did not return workflow id');
    console.log(`ok started hosted AI workflow ${workflowId}`);

    const workflow = await waitForWorkflow(workflowId);
    assert(
      workflow.stage === 'ready_for_tts' || workflow.stage === 'audio_cache_ready',
      `workflow ended at unexpected stage ${workflow.stage}`,
    );
    const ttsReadiness = workflow.progress?.ttsReadiness;
    assert(ttsReadiness?.ok === true, 'workflow did not record passing TTS readiness');
    assert(Number(ttsReadiness.metrics?.segmentCount ?? 0) > 0, 'TTS readiness segment count was zero');
    assert(
      Number(ttsReadiness.metrics?.missingPlannedParagraphCount ?? 0) === 0,
      'TTS readiness still has missing planned paragraphs',
    );
    console.log(`ok workflow reached ${workflow.stage} with ${ttsReadiness.metrics.segmentCount} segment(s)`);

    const graphResponse = await request(`/books/${encodeURIComponent(bookId)}/character-graph`);
    const graph = graphResponse.graph ?? graphResponse;
    assert(
      Array.isArray(graph.characters) && graph.characters.length >= 1,
      'character graph endpoint returned no characters',
    );
    const segments = await request(`/chapters/${encodeURIComponent(firstChapter.id)}/segments`);
    assert(
      Array.isArray(segments.segments) && segments.segments.length >= 1,
      'first chapter returned no labeled segments',
    );
    console.log(
      `ok graph and labeled segments persisted (${graph.characters.length} character(s), ${segments.segments.length} first-chapter segment(s))`,
    );

    const cacheReadiness = await request(`/analysis-workflows/${encodeURIComponent(workflowId)}/tts-cache-readiness`, {
      method: 'POST',
    });
    const cacheReport = cacheReadiness.ttsCacheReadiness;
    assert(cacheReport && typeof cacheReport.ok === 'boolean', 'TTS cache readiness endpoint did not return a report');
    console.log(
      `ok checked hosted TTS cache readiness (ok=${cacheReport.ok}, code=${cacheReport.errorCode ?? 'none'})`,
    );

    const syncAfter = await pullSyncEventsSince(syncCursor);
    assertSyncEvent(
      syncAfter,
      'voice_profiles_updated',
      (event, payload) => event.book_id === bookId && payload.voiceProfiles?.length >= 1,
    );
    assertSyncEvent(
      syncAfter,
      'character_graph_updated',
      (event, payload) =>
        event.book_id === bookId && (payload.graph?.characters?.length >= 1 || payload.characters?.length >= 1),
    );
    assertSyncEvent(
      syncAfter,
      'chapter_segments_updated',
      (event, payload) => event.book_id === bookId && payload.segments?.length >= 1,
    );
    console.log('ok sync pull exposed AI/TTS voice, graph, and segment metadata events');
  } finally {
    if (bookId && !keepBook) {
      await request(`/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
      console.log('ok cleaned up AI workflow smoke book');
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
