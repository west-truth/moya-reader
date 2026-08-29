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
const browserUI = hasArg('--browser-ui') || process.env.HOSTED_AI_WORKFLOW_BROWSER_UI === '1';
const deterministicSource = hasArg('--deterministic-source');
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
const detailedSpeakerWorkflowId = 'moya.ai.tts.detailed.speaker-preparation';
const managedWorkflowId = argValue(
  '--managed-workflow-id',
  process.env.HOSTED_AI_WORKFLOW_MANAGED_WORKFLOW_ID ?? 'moya.ai.tts.book-preparation',
);
let negotiatedSyncContract;

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

async function negotiateSyncContract() {
  const capabilities = await request('/sync/capabilities');
  const supportedContracts = Array.isArray(capabilities.supportedContracts) ? capabilities.supportedContracts : [];
  const contract = supportedContracts.find((candidate) => Number(candidate?.contractVersion) === 2);
  assert(contract, 'sync capabilities do not include contract v2');
  assert(typeof contract.idContract === 'string' && contract.idContract, 'sync v2 idContract is missing');
  assert(typeof contract.hashContract === 'string' && contract.hashContract, 'sync v2 hashContract is missing');
  negotiatedSyncContract = {
    contractVersion: 2,
    idContract: contract.idContract,
    hashContract: contract.hashContract,
  };
}

function syncPullPath(since) {
  assert(negotiatedSyncContract, 'sync contract must be negotiated before pulling events');
  const query = new URLSearchParams({
    since: String(since),
    contractVersion: String(negotiatedSyncContract.contractVersion),
    idContract: negotiatedSyncContract.idContract,
    hashContract: negotiatedSyncContract.hashContract,
  });
  return `/sync?${query.toString()}`;
}

async function syncCursorAtEnd() {
  let cursor = 0;
  for (let page = 0; page < maxSyncPages; page += 1) {
    const response = await request(syncPullPath(cursor));
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
    const response = await request(syncPullPath(currentCursor));
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

async function waitForWorkflow(workflowId, { allowNeedsReview = false } = {}) {
  const startedAt = Date.now();
  let lastWorkflow;
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(`/analysis-workflows/${encodeURIComponent(workflowId)}`);
    const workflow = response.workflow;
    lastWorkflow = workflow;
    if (workflow?.status === 'succeeded') return workflow;
    if (workflow?.status === 'needs_review' && allowNeedsReview) return workflow;
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
  if (deterministicSource) {
    const chapters = Array.from({ length: 1 }, (_, chapterIndex) => {
      const paragraphs = Array.from({ length: 4 }, (_, paragraphIndex) =>
        paragraphIndex % 3 === 0
          ? `강현우: 현우가 ${chapterIndex + 1}화 ${paragraphIndex + 1}번째 계획을 설명했다.`
          : paragraphIndex % 3 === 1
            ? `박민서: 민서가 ${chapterIndex + 1}화 ${paragraphIndex + 1}번째 답을 전했다.`
            : `두 사람은 다음 장면으로 이동하며 상황을 정리했다.`,
      );
      return `제${chapterIndex + 1}화 검증 장면\n\n${paragraphs.join('\n\n')}`;
    });
    const text = chapters.join('\n\n');
    return { sourcePath: '[deterministic managed-workflow fixture]', text, originalCharacters: text.length };
  }
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

async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  const errors = [];
  for (const channel of ['msedge', 'chrome', 'chromium']) {
    try {
      const browser = await chromium.launch({ channel, headless: true });
      console.log(`Browser UI smoke channel: ${channel}`);
      return browser;
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(`Could not launch Edge/Chrome for hosted AI workflow UI smoke. ${errors.join(' | ')}`);
}

async function openBookReader(page, bookTitle) {
  await page.goto(webBaseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByText('책장을 불러오는 중입니다').waitFor({ state: 'hidden', timeout: timeoutMs });
  await page.getByRole('button', { name: `${bookTitle} 작품 상세 열기`, exact: true }).click({ timeout: timeoutMs });
  await page
    .getByRole('button', { name: /첫 화 보기|이어 읽기/u })
    .first()
    .click({ timeout: timeoutMs });
  await page
    .locator('.reader-viewport-layer.is-active .reader-paragraph:not(.is-loading):not(.is-error)')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
}

async function openAIWorkflowSurface(page, options = {}) {
  const screen = page.locator('.reader-screen');
  if (!(await screen.getAttribute('class'))?.split(/\s+/u).includes('chrome-visible')) {
    const viewport = page.locator('.reader-viewport-layer.is-active');
    const box = await viewport.boundingBox();
    assert(box, 'Reader viewport was unavailable while opening AI workflow tools');
    await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  }
  await page.getByRole('button', { name: '부가 기능 열기', exact: true }).click({ timeout: timeoutMs });
  await page.getByRole('tab', { name: 'AI', exact: true }).click({ timeout: timeoutMs });
  const selector = page.locator('#ai-managed-workflow');
  const initialSelection = await selector.inputValue();
  let settingsSave;
  if (options.select && initialSelection !== managedWorkflowId) {
    settingsSave = page.waitForResponse(
      (response) => response.request().method() === 'PUT' && response.url().endsWith('/api/settings'),
      { timeout: timeoutMs },
    );
    await selector.selectOption(managedWorkflowId);
  }
  await page.locator(`[data-workflow-id="${managedWorkflowId}"]`).waitFor({ state: 'visible', timeout: timeoutMs });
  if (settingsSave) {
    const response = await settingsSave;
    assert(response.ok(), `managed workflow selection save returned ${response.status()}`);
  }
  const selection = await selector.inputValue();
  assert(selection === managedWorkflowId, `managed workflow selector resolved ${selection}`);
}

async function startWorkflowFromBrowser(bookId, bookTitle) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  if (authToken) {
    await context.addInitScript(({ key, token }) => window.localStorage.setItem(key, token), {
      key: 'noveldesk.apiAuthToken',
      token: authToken,
    });
  }
  const page = await context.newPage();
  try {
    await openBookReader(page, bookTitle);
    await openAIWorkflowSurface(page, { select: true });
    await page.route(`**/api/books/${encodeURIComponent(bookId)}/analysis-workflows`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON();
      if (managedWorkflowId === detailedSpeakerWorkflowId) {
        assert(
          body.planOptions?.maxLabelingParagraphs === 2,
          `alternate runner did not send maxLabelingParagraphs=2: ${JSON.stringify(body.planOptions)}`,
        );
      }
      await route.continue({
        postData: JSON.stringify({
          ...body,
          providerId: 'mock',
          modelId: 'mock-segment-labeler-v1',
          force: true,
          planOptions: {
            maxBundleChapters,
            targetBundleCharacters,
            maxLabelingParagraphs,
            targetLabelingCharacters,
            ...body.planOptions,
          },
        }),
      });
    });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/api/books/${encodeURIComponent(bookId)}/analysis-workflows`),
      { timeout: timeoutMs },
    );
    await page.getByRole('button', { name: '작품 전체 분석 시작', exact: true }).click({ timeout: timeoutMs });
    const response = await responsePromise;
    assert(response.ok(), `browser workflow start returned ${response.status()}`);
    const started = await response.json();
    const workflowId = started.workflow?.id;
    assert(typeof workflowId === 'string', 'browser workflow start did not return workflow id');
    if (managedWorkflowId === detailedSpeakerWorkflowId) {
      assert(
        started.workflow?.plan?.labelingWindows?.length === 2,
        `alternate runner plan produced ${started.workflow?.plan?.labelingWindows?.length ?? 'no'} labeling windows`,
      );
      console.log('ok alternate trusted runner applied its two-paragraph planning policy');
    }
    await page.close();
    return { browser, context, workflowId, bookTitle };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function verifyCompletedWorkflowInBrowser(session) {
  const { context, bookTitle } = session;
  const page = await context.newPage();
  try {
    await openBookReader(page, bookTitle);
    await openAIWorkflowSurface(page);
    await page.getByText('라벨과 음성 연결이 끝났습니다. 듣기용 음성을 준비할 수 있습니다.').waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
    await page.getByText('고급 정보', { exact: true }).click({ timeout: timeoutMs });
    await page.getByText('Label/voice readiness passed', { exact: true }).waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
    await page.getByRole('tab', { name: '듣기', exact: true }).click({ timeout: timeoutMs });
    const play = page.getByRole('button', { name: '재생', exact: true });
    await play.waitFor({ state: 'visible', timeout: timeoutMs });
    assert(!(await play.isDisabled()), 'basic/system TTS play action was disabled beside the completed workflow');
    console.log('ok browser restored ready_for_tts evidence and kept basic/system TTS playback available');
  } finally {
    await page.close();
  }
}

async function verifyWorkflowCancellationRoute(bookId) {
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
  assert(typeof workflowId === 'string', 'cancellation probe did not return a workflow id');
  const cancelled = await request(`/analysis-workflows/${encodeURIComponent(workflowId)}/cancel`, {
    method: 'POST',
  });
  assert(cancelled.workflow?.status === 'cancelled', 'workflow cancellation did not return cancelled state');
  const restored = await request(`/analysis-workflows/${encodeURIComponent(workflowId)}`);
  assert(restored.workflow?.status === 'cancelled', 'cancelled workflow was not durably restorable');
  console.log('ok cancelled a queued hosted workflow and restored its durable cancelled state');
}

function mockVoiceProfiles(bookId, graphCharacters) {
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
    ...graphCharacters.map((character, index) =>
      profile(`character_${index + 1}`, 'character', `Mock ${character.canonicalName ?? character.id}`, character.id),
    ),
  ];
}

async function waitForGeneratedCharacterGraph(bookId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(`/books/${encodeURIComponent(bookId)}/character-graph`);
    const graph = response.graph ?? response;
    if (Array.isArray(graph.characters) && graph.characters.length >= 1) return graph;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, 250)));
  }
  throw new Error(`Generated Character Graph did not appear within ${timeoutMs}ms`);
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
  await negotiateSyncContract();

  let bookId;
  let browserSession;
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

    let workflowId;
    if (browserUI) {
      const library = await request('/books');
      const importedBook = library.books?.find((book) => book.id === bookId);
      assert(typeof importedBook?.title === 'string', 'imported browser smoke book was absent from the library');
      browserSession = await startWorkflowFromBrowser(bookId, importedBook.title);
      workflowId = browserSession.workflowId;
      console.log(`ok started hosted AI workflow ${workflowId} from managed browser UI`);
    } else {
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
      workflowId = started.workflow?.id;
      assert(typeof workflowId === 'string', 'analysis workflow start did not return workflow id');
      console.log(`ok started hosted AI workflow ${workflowId}`);
    }

    let workflow = await waitForWorkflow(workflowId, { allowNeedsReview: true });
    if (workflow.status === 'needs_review') {
      console.log(
        `ok initial workflow reached review before voice assignment (${workflow.errorCode ?? 'needs_review'})`,
      );
      const generatedGraph = await waitForGeneratedCharacterGraph(bookId);
      const voices = await request(`/books/${encodeURIComponent(bookId)}/voice-profiles`, {
        method: 'PUT',
        ...jsonBody({ voiceProfiles: mockVoiceProfiles(bookId, generatedGraph.characters) }),
      });
      assert(
        voices.ok === true && voices.voiceProfiles?.length >= 3 + generatedGraph.characters.length,
        'voice profile save failed',
      );
      console.log('ok saved mock system voice profiles after analysis artifact promotion');
      assert(
        workflow.errorCode === 'tts_readiness_missing_voice_profiles',
        `workflow reached unexpected review state ${workflow.errorCode ?? workflow.errorMessage ?? 'needs_review'}`,
      );
      await request(`/analysis-workflows/${encodeURIComponent(workflowId)}/retry`, {
        method: 'POST',
        ...jsonBody({ action: 'retry_same_request' }),
      });
      console.log('ok retried workflow after satisfying TTS voice readiness');
      workflow = await waitForWorkflow(workflowId);
    }
    assert(
      workflow.status === 'succeeded',
      `workflow ended as ${workflow.status}/${workflow.stage}: ${workflow.errorMessage ?? workflow.errorCode ?? ''}`,
    );
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
    if (browserSession) await verifyCompletedWorkflowInBrowser(browserSession);
    await verifyWorkflowCancellationRoute(bookId);
  } finally {
    if (browserSession) await browserSession.browser.close();
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
