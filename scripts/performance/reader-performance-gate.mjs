#!/usr/bin/env node
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  launchFreshPersistentContext,
  removeDirectoryWithRetries,
  startOwnedVitePreviewServer,
  startOwnedViteServer,
  useExternalServer,
} from './browser-gate-harness.mjs';
import { PHASE6_FIXTURE_BYTES, generatePhase6LargeNovelFixture } from './phase6-large-novel-fixture.mjs';
import {
  PHASE6_DEFAULT_TIMING_BUDGETS,
  evaluatePhase6PerformanceReport,
  phase6ConsoleSummary,
  phase6TimingBudgets,
} from './reader-performance-policy.mjs';
import { verifyRealReaderPathContract } from './real-reader-path-contract.mjs';

const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const READER_DB_NAME = 'noveldesk-reader';
const STARTUP_TIMEOUT_MS = Number(process.env.READER_PERF_STARTUP_TIMEOUT_MS ?? 60000);
const args = process.argv.slice(2).filter((arg) => arg !== '--');

function hasArg(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

class GateFailure extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'GateFailure';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new GateFailure(code, message, details);
}

async function stage(code, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GateFailure) throw error;
    throw new GateFailure(code, error instanceof Error ? error.message : String(error));
  }
}

function installBrowserInstrumentation({ heartbeatIntervalMs }) {
  const now = () => performance.timeOrigin + performance.now();
  const state = {
    workerRuns: [],
    heartbeat: undefined,
    heartbeatResult: undefined,
    longTasks: [],
    abortCalls: [],
    searchTransactions: [],
  };
  let nextSearchTransactionId = 1;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ startAt: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Heartbeat deltas remain the cross-browser source of truth.
  }

  const NativeWorker = window.Worker;
  window.Worker = class InstrumentedWorker extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.phase6Run = {
        workerUrl: String(url),
        constructedAt: now(),
        startedAt: undefined,
        cancelRequestedAt: undefined,
        commands: [],
        progress: [],
        terminal: undefined,
        fileBytes: undefined,
        fileName: undefined,
      };
      state.workerRuns.push(this.phase6Run);
      this.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'progress') {
          const progress = message.progress ?? {};
          this.phase6Run.progress.push({
            at: now(),
            status: progress.status,
            bytesRead: progress.bytesRead,
            totalBytes: progress.totalBytes,
            chaptersDetected: progress.chaptersDetected,
            paragraphsWritten: progress.paragraphsWritten,
          });
        } else if (message.type === 'complete' || message.type === 'error') {
          this.phase6Run.terminal = {
            at: now(),
            type: message.type,
            name: message.name,
          };
        }
      });
    }

    postMessage(message, transferOrOptions) {
      if (message && typeof message === 'object') {
        const at = now();
        this.phase6Run.commands.push({ at, type: message.type });
        if (message.type === 'start') this.phase6Run.startedAt = at;
        if (message.type === 'start' && message.file instanceof File) {
          this.phase6Run.fileBytes = message.file.size;
          this.phase6Run.fileName = message.file.name;
        }
        if (message.type === 'cancel') this.phase6Run.cancelRequestedAt = at;
      }
      if (arguments.length > 1) return super.postMessage(message, transferOrOptions);
      return super.postMessage(message);
    }
  };

  const nativeAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function instrumentedAbort(reason) {
    state.abortCalls.push({ at: now(), reason: reason instanceof Error ? reason.name : typeof reason });
    return nativeAbort.call(this, reason);
  };

  const searchStores = new Set(['book_content_paragraph_search', 'paragraph_search', 'paragraph_pages', 'paragraphs']);
  const nativeTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function instrumentedTransaction() {
    const transaction = Reflect.apply(nativeTransaction, this, arguments);
    const storeNames = Array.from(transaction.objectStoreNames);
    if (transaction.mode === 'readonly' && storeNames.some((name) => searchStores.has(name))) {
      const record = {
        id: nextSearchTransactionId,
        startedAt: now(),
        storeNames,
        completedAt: undefined,
        abortedAt: undefined,
        error: undefined,
      };
      nextSearchTransactionId += 1;
      state.searchTransactions.push(record);
      transaction.addEventListener('complete', () => {
        record.completedAt = now();
      });
      transaction.addEventListener('abort', () => {
        record.abortedAt = now();
        record.error = transaction.error?.name;
      });
      transaction.addEventListener('error', () => {
        record.error = transaction.error?.name;
      });
    }
    return transaction;
  };

  window.__NOVELDESK_PHASE6_PERF__ = {
    startHeartbeat(label) {
      if (state.heartbeat?.timer) clearInterval(state.heartbeat.timer);
      const startedAt = now();
      const stalls = [];
      const heartbeat = { label, startedAt, stalls, previousTick: performance.now(), timer: undefined };
      heartbeat.timer = setInterval(() => {
        const tick = performance.now();
        stalls.push(Math.max(0, tick - heartbeat.previousTick - heartbeatIntervalMs));
        heartbeat.previousTick = tick;
      }, heartbeatIntervalMs);
      state.heartbeat = heartbeat;
      state.heartbeatResult = undefined;
    },
    stopHeartbeat() {
      const heartbeat = state.heartbeat;
      if (!heartbeat) return undefined;
      clearInterval(heartbeat.timer);
      const sorted = [...heartbeat.stalls].sort((left, right) => left - right);
      const finishedAt = now();
      const tailGapMs = Math.max(0, performance.now() - heartbeat.previousTick);
      const observedGaps = [...heartbeat.stalls.map((stall) => stall + heartbeatIntervalMs), tailGapMs].sort(
        (left, right) => left - right,
      );
      const observedLongTasks = state.longTasks.filter(
        (task) => task.startAt >= heartbeat.startedAt && task.startAt <= finishedAt,
      );
      const result = {
        label: heartbeat.label,
        startedAt: heartbeat.startedAt,
        finishedAt,
        durationMs: finishedAt - heartbeat.startedAt,
        tickCount: sorted.length,
        maximumStallMs: sorted.at(-1) ?? 0,
        maximumGapMs: observedGaps.at(-1) ?? 0,
        p95StallMs: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
        p95GapMs: observedGaps[Math.max(0, Math.ceil(observedGaps.length * 0.95) - 1)] ?? 0,
        longTaskCount: observedLongTasks.length,
        maximumLongTaskMs: Math.max(0, ...observedLongTasks.map((task) => task.durationMs)),
      };
      state.heartbeat = undefined;
      state.heartbeatResult = result;
      return result;
    },
    snapshot() {
      return JSON.parse(
        JSON.stringify({
          workerRuns: state.workerRuns,
          heartbeatResult: state.heartbeatResult,
          abortCalls: state.abortCalls,
          searchTransactions: state.searchTransactions,
        }),
      );
    },
  };
}

async function telemetry(page) {
  return page.evaluate(() => window.__NOVELDESK_PHASE6_PERF__.snapshot());
}

async function startHeartbeat(page, label) {
  await page.evaluate((nextLabel) => window.__NOVELDESK_PHASE6_PERF__.startHeartbeat(nextLabel), label);
}

async function stopHeartbeat(page) {
  return page.evaluate(() => window.__NOVELDESK_PHASE6_PERF__.stopHeartbeat());
}

async function inspectReaderDatabase(page) {
  return page.evaluate(async (databaseName) => {
    const request = indexedDB.open(databaseName);
    const db = await new Promise((resolveDb, reject) => {
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = (storeName) => {
      if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
      const tx = db.transaction(storeName, 'readonly');
      const read = tx.objectStore(storeName).getAll();
      return new Promise((resolveRows, reject) => {
        read.onsuccess = () => resolveRows(read.result);
        read.onerror = () => reject(read.error);
      });
    };
    const [novels, revisions, revisionChapters, legacyChapters] = await Promise.all([
      getAll('novels'),
      getAll('book_content_revisions'),
      getAll('book_content_chapters'),
      getAll('chapters'),
    ]);
    db.close();
    const novel = novels[0];
    const chapters = novel?.activeContentRevisionId
      ? revisionChapters.filter((chapter) => chapter.contentRevisionId === novel.activeContentRevisionId)
      : legacyChapters.filter((chapter) => chapter.novelId === novel?.id);
    const largest = chapters.reduce(
      (current, chapter) => (chapter.paragraphCount > (current?.paragraphCount ?? -1) ? chapter : current),
      undefined,
    );
    const first = chapters.reduce(
      (current, chapter) => (chapter.index < (current?.index ?? Infinity) ? chapter : current),
      undefined,
    );
    return {
      novelCount: novels.length,
      revisionCount: revisions.length,
      activeRevisionCount: revisions.filter((revision) => revision.status === 'active').length,
      chapterCount: chapters.length,
      largestChapterParagraphs: largest?.paragraphCount ?? 0,
      largestChapterIndex: largest?.index,
      firstChapterParagraphs: first?.paragraphCount ?? 0,
      firstChapterTitle: first?.title,
    };
  }, READER_DB_NAME);
}

function maximumProgressGap(run) {
  const timestamps = [run.startedAt, ...run.progress.map((event) => event.at), run.terminal?.at]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  let maximum = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    maximum = Math.max(maximum, timestamps[index] - timestamps[index - 1]);
  }
  return maximum;
}

async function selectFixture(page, fixturePath) {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) {
    await page.locator('.floating-import').click();
    await input.waitFor({ state: 'attached' });
  }
  await input.setInputFiles([]);
  await input.setInputFiles(fixturePath);
  const modal = page
    .locator('.modal')
    .filter({ has: page.getByRole('heading', { name: '\ucc45 \uac00\uc838\uc624\uae30' }) });
  await modal.waitFor({ state: 'visible' });
  await modal.locator('select').nth(1).selectOption('mixed');
  return modal;
}

async function runCancellationTrial(page, fixturePath, timeoutMs) {
  const modal = await selectFixture(page, fixturePath);
  await startHeartbeat(page, 'phase6-cancelled-import');
  await modal.getByRole('button', { name: /\uac00\uc838\uc624\uae30 \uc2dc\uc791/ }).click();
  await page.waitForFunction(
    () =>
      window.__NOVELDESK_PHASE6_PERF__
        .snapshot()
        .workerRuns.at(-1)
        ?.progress.some(
          (event) =>
            event.status === 'reading' &&
            Number.isFinite(event.bytesRead) &&
            event.bytesRead > 0 &&
            event.bytesRead < event.totalBytes,
        ),
    undefined,
    { timeout: timeoutMs },
  );
  await modal.getByRole('button', { name: '\ucde8\uc18c', exact: true }).click();
  await page.waitForFunction(
    () => Boolean(window.__NOVELDESK_PHASE6_PERF__.snapshot().workerRuns.at(-1)?.terminal),
    undefined,
    { timeout: timeoutMs },
  );
  const snapshot = await telemetry(page);
  const run = snapshot.workerRuns.at(-1);
  const eventLoop = await stopHeartbeat(page);
  await modal.locator('.import-progress').waitFor({ state: 'hidden', timeout: timeoutMs });
  const storage = await inspectReaderDatabase(page);
  return {
    observed: run.terminal?.type === 'error' && run.terminal?.name === 'AbortError',
    workerPathObserved: run.workerUrl.includes('import-worker'),
    workerFileBytes: run.fileBytes,
    responseMs: run.terminal?.at - run.cancelRequestedAt,
    progressEventCount: run.progress.length,
    eventLoop,
    storageNovelCountAfter: storage.novelCount,
    storageRevisionCountAfter: storage.revisionCount,
  };
}

async function runFullImport(page, fixturePath, timeoutMs) {
  const modal = await selectFixture(page, fixturePath);
  await startHeartbeat(page, 'phase6-full-import');
  const uiStartedAt = Date.now();
  await modal.getByRole('button', { name: /\uac00\uc838\uc624\uae30 \uc2dc\uc791/ }).click();
  await page.locator('.chapters-screen').waitFor({ state: 'visible', timeout: timeoutMs });
  const totalMs = Date.now() - uiStartedAt;
  const eventLoop = await stopHeartbeat(page);
  const snapshot = await telemetry(page);
  const run = snapshot.workerRuns.at(-1);
  if (run.terminal?.type !== 'complete') fail('IMPORT_WORKER_FAILED', 'Import worker did not complete.', run.terminal);
  return {
    totalMs,
    workerPathObserved: run.workerUrl.includes('import-worker'),
    workerFileBytes: run.fileBytes,
    progressEventCount: run.progress.length,
    progressStatuses: [...new Set(run.progress.map((event) => event.status))],
    maximumProgressGapMs: maximumProgressGap(run),
    eventLoop,
    storage: await inspectReaderDatabase(page),
  };
}

async function horizontalOverflowIssues(page) {
  return page.evaluate(() => {
    const selectors = [
      '.reader-screen',
      '.reader-topbar',
      '.reader-scroll',
      '.reader-document',
      '.reader-bottombar',
      '.search-result-strip',
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].filter(visible).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const invalid =
          rect.left < -2 || rect.right > viewportWidth + 2 || element.scrollWidth > element.clientWidth + 2;
        return invalid
          ? [
              {
                selector,
                left: rect.left,
                right: rect.right,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                viewportWidth,
              },
            ]
          : [];
      }),
    );
  });
}

async function measureReaderPosition(page, position, fraction, timeoutMs) {
  await startHeartbeat(page, `reader-scroll-${position}`);
  const startedAt = Date.now();
  await page.locator('.reader-scroll').evaluate((element, targetFraction) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top: maximum * targetFraction, behavior: 'auto' });
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, fraction);
  await page.waitForFunction(
    (targetFraction) => {
      const root = document.querySelector('.reader-scroll');
      const maximum = root ? Math.max(0, root.scrollHeight - root.clientHeight) : 0;
      const actual = maximum > 0 ? root.scrollTop / maximum : 0;
      return document.querySelectorAll('.reader-paragraph').length > 0 && Math.abs(actual - targetFraction) < 0.08;
    },
    fraction,
    { timeout: timeoutMs },
  );
  await page.evaluate(
    () => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))),
  );
  await page.waitForTimeout(100);
  const eventLoop = await stopHeartbeat(page);
  const counts = await page.evaluate(() => ({
    renderedRows: document.querySelectorAll('.reader-virtual-row').length,
    renderedParagraphs: document.querySelectorAll('.reader-paragraph').length,
    firstRenderedIndex: Number(document.querySelector('.reader-virtual-row')?.getAttribute('data-index') ?? -1),
    lastRenderedIndex: Number(
      [...document.querySelectorAll('.reader-virtual-row')].at(-1)?.getAttribute('data-index') ?? -1,
    ),
    scrollTop: document.querySelector('.reader-scroll')?.scrollTop ?? 0,
    scrollHeight: document.querySelector('.reader-scroll')?.scrollHeight ?? 0,
    clientHeight: document.querySelector('.reader-scroll')?.clientHeight ?? 0,
  }));
  const scrollableHeight = Math.max(0, counts.scrollHeight - counts.clientHeight);
  return {
    position,
    targetFraction: fraction,
    actualFraction: scrollableHeight > 0 ? counts.scrollTop / scrollableHeight : 0,
    navigationMs: Date.now() - startedAt,
    eventLoop,
    ...counts,
  };
}

async function measureReaderViewport(page, name, viewport, timeoutMs) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
  const samples = [];
  for (const [position, fraction] of [
    ['top', 0],
    ['middle', 0.5],
    ['end', 0.95],
  ]) {
    samples.push(await measureReaderPosition(page, position, fraction, timeoutMs));
  }
  return { name, ...viewport, samples, horizontalOverflowIssues: await horizontalOverflowIssues(page) };
}

function parseReportedCount(text) {
  const match = String(text).replaceAll(',', '').match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function measureSearchScope(page, scope, query, expectedCount, timeoutMs) {
  const strip = page.locator('.search-result-strip');
  const input = page.getByPlaceholder('\ubcf8\ubb38 \uac80\uc0c9').first();
  const startedAt = Date.now();
  if ((await input.inputValue()) !== query) await input.fill(query);
  await strip.waitFor({ state: 'visible', timeout: timeoutMs });
  if (scope === 'book') await strip.getByRole('button', { name: '\ucc45 \uc804\uccb4', exact: true }).click();
  else await strip.getByRole('button', { name: '\ud604\uc7ac \ud654', exact: true }).click();
  await page.waitForFunction(
    ({ count }) =>
      document.querySelector('.search-result-summary strong')?.textContent?.replaceAll(',', '').includes(String(count)),
    { count: expectedCount },
    { timeout: timeoutMs },
  );
  const responseMs = Date.now() - startedAt;
  const summary = await strip.locator('.search-result-summary strong').textContent();
  const visibleResultCount = await strip.locator('.search-result-list > button').count();
  const counter = strip.locator('.search-result-controls span');
  const before = await counter.textContent();
  await strip.getByRole('button', { name: '\ub2e4\uc74c \uac80\uc0c9 \uacb0\uacfc' }).click();
  await page.waitForFunction(
    (previous) => document.querySelector('.search-result-controls span')?.textContent !== previous,
    before,
    { timeout: timeoutMs },
  );
  return {
    responseMs,
    reportedCount: parseReportedCount(summary),
    limited: summary?.includes('+') ?? false,
    visibleResultCount,
    navigationAdvanced: (await counter.textContent()) !== before,
  };
}

async function measureSearchCancellation(page, uniqueQuery, timeoutMs) {
  const strip = page.locator('.search-result-strip');
  await strip.getByRole('button', { name: '\ucc45 \uc804\uccb4', exact: true }).click();
  const input = page.getByPlaceholder('\ubcf8\ubb38 \uac80\uc0c9').first();
  await page.waitForFunction(
    () => document.querySelector('.search-result-summary strong')?.textContent?.replaceAll(',', '').includes('300'),
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(50);
  const baseline = await telemetry(page);
  const baselineTransactionId = Math.max(0, ...baseline.searchTransactions.map((transaction) => transaction.id));
  await input.fill('phase6-query-that-does-not-exist');
  await page.waitForFunction(
    (minimumId) =>
      window.__NOVELDESK_PHASE6_PERF__
        .snapshot()
        .searchTransactions.some(
          (transaction) =>
            transaction.id > minimumId && transaction.completedAt === undefined && transaction.abortedAt === undefined,
        ),
    baselineTransactionId,
    { timeout: timeoutMs, polling: 5 },
  );
  const inFlight = await telemetry(page);
  const firstQueryTransactions = inFlight.searchTransactions.filter(
    (transaction) => transaction.id > baselineTransactionId,
  );
  const firstQueryStartedAt = Math.min(...firstQueryTransactions.map((transaction) => transaction.startedAt));
  const startedAt = Date.now();
  const supersedeRequestedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  await strip.getByRole('button', { name: '\ud604\uc7ac \ud654', exact: true }).click();
  await input.fill(uniqueQuery);
  await page.waitForFunction(
    () => document.querySelector('.search-result-summary strong')?.textContent?.includes('1'),
    undefined,
    { timeout: timeoutMs },
  );
  const responseMs = Date.now() - startedAt;
  await page.waitForTimeout(Math.min(2000, Math.floor(timeoutMs / 4)));
  const summary = await strip.locator('.search-result-summary strong').textContent();
  const resultText = await strip.locator('.search-result-list').textContent();
  const finalTelemetry = await telemetry(page);
  const cancellationAborts = finalTelemetry.abortCalls.filter(
    (call) => call.at >= firstQueryStartedAt && call.at >= supersedeRequestedAt - 25,
  );
  const firstQueryTransactionIds = new Set(firstQueryTransactions.map((transaction) => transaction.id));
  return {
    responseMs,
    reportedCount: parseReportedCount(summary),
    freshResultWon: parseReportedCount(summary) === 1 && resultText?.includes(uniqueQuery),
    supersededSearchStarted: firstQueryTransactions.length > 0,
    firstQueryTransactionCount: firstQueryTransactions.length,
    abortSignalObserved: cancellationAborts.length > 0,
    searchTransactionAbortObserved: finalTelemetry.searchTransactions.some(
      (transaction) => firstQueryTransactionIds.has(transaction.id) && Number.isFinite(transaction.abortedAt),
    ),
  };
}

async function runReaderAndSearchGate(page, imported, fixture, budgets) {
  await page.getByRole('button', { name: '\uc774\uc5b4 \uc77d\uae30' }).first().click();
  await page.locator('.reader-scroll').waitFor({ state: 'visible', timeout: budgets.readerNavigationMs * 2 });
  await page
    .locator('.reader-paragraph')
    .first()
    .waitFor({ state: 'visible', timeout: budgets.readerNavigationMs * 2 });
  const viewports = [
    await measureReaderViewport(page, 'mobile', { width: 390, height: 844 }, budgets.readerNavigationMs),
    await measureReaderViewport(page, 'tablet', { width: 820, height: 1180 }, budgets.readerNavigationMs),
    await measureReaderViewport(page, 'desktop', { width: 1280, height: 720 }, budgets.readerNavigationMs),
    await measureReaderViewport(page, 'wide', { width: 1440, height: 900 }, budgets.readerNavigationMs),
  ];
  await page.setViewportSize({ width: 1280, height: 720 });
  await measureReaderPosition(page, 'search-origin', 0, budgets.readerNavigationMs);
  const search = {
    chapter: await measureSearchScope(page, 'chapter', fixture.commonQuery, 200, budgets.searchResponseMs),
    book: await measureSearchScope(page, 'book', fixture.commonQuery, 300, budgets.searchResponseMs),
    cancellation: await measureSearchCancellation(page, fixture.uniqueQuery, budgets.searchResponseMs),
  };
  return {
    chapterParagraphCount: imported.storage.firstChapterParagraphs,
    chapterTitle: imported.storage.firstChapterTitle,
    viewports,
    maximumRenderedRows: Math.max(
      ...viewports.flatMap((viewport) => viewport.samples.map((sample) => sample.renderedRows)),
    ),
    search,
  };
}

async function writeReport(reportPath, report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const startedAt = new Date();
  let budgetConfigurationError;
  let budgets = PHASE6_DEFAULT_TIMING_BUDGETS;
  try {
    budgets = phase6TimingBudgets();
  } catch (error) {
    budgetConfigurationError = error;
  }
  const reportPath = resolve(
    ROOT_DIRECTORY,
    argValue(
      '--report',
      process.env.READER_PERF_REPORT_PATH ?? 'fixtures/generated/performance-reports/phase6-reader-20mb.json',
    ),
  );
  const report = {
    schemaVersion: 2,
    gate: 'phase6-20mb-reader-performance',
    status: 'running',
    startedAt: startedAt.toISOString(),
    reportPath: relative(ROOT_DIRECTORY, reportPath).replaceAll('\\', '/'),
    environment: { platform: process.platform, node: process.version },
    budgets,
    browserErrors: [],
    failures: [],
  };

  let temporaryDirectory;
  let profileDirectory;
  let browserContext;
  let server;
  let measurementsCompleted = false;

  try {
    if (budgetConfigurationError) {
      fail(
        'TIMING_BUDGET_INVALID',
        budgetConfigurationError instanceof Error ? budgetConfigurationError.message : String(budgetConfigurationError),
      );
    }
    report.staticContract = await stage('REAL_PATH_CONTRACT_FAILED', () =>
      verifyRealReaderPathContract(ROOT_DIRECTORY),
    );
    if (!report.staticContract.passed)
      fail(
        'REAL_PATH_CONTRACT_FAILED',
        'Performance gate no longer targets the real import/reader path.',
        report.staticContract.results,
      );

    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'noveldesk-phase6-'));
    profileDirectory = resolve(temporaryDirectory, 'browser-profile');
    const fixturePath = resolve(temporaryDirectory, 'noveldesk-phase6-20mb.txt');
    report.fixture = await stage('FIXTURE_GENERATION_FAILED', () =>
      generatePhase6LargeNovelFixture({
        outputPath: fixturePath,
        targetBytes: PHASE6_FIXTURE_BYTES,
      }),
    );
    report.fixture.fileBytes = (await stat(fixturePath)).size;
    delete report.fixture.outputPath;

    const externalUrl = argValue('--url', process.env.READER_PERF_URL ?? '');
    server = externalUrl
      ? await stage('EXTERNAL_SERVER_UNREACHABLE', () => useExternalServer(externalUrl, STARTUP_TIMEOUT_MS))
      : hasArg('--dev')
        ? await stage('DEV_SERVER_START_FAILED', () =>
            startOwnedViteServer({
              rootDirectory: ROOT_DIRECTORY,
              startupTimeoutMs: STARTUP_TIMEOUT_MS,
              onOutput: hasArg('--verbose') ? (line) => process.stdout.write(line) : undefined,
            }),
          )
        : await stage('PRODUCTION_PREVIEW_START_FAILED', () =>
            startOwnedVitePreviewServer({
              rootDirectory: ROOT_DIRECTORY,
              outDirectory: resolve(temporaryDirectory, 'production-dist'),
              startupTimeoutMs: STARTUP_TIMEOUT_MS,
              onOutput: hasArg('--verbose') ? (line) => process.stdout.write(line) : undefined,
            }),
          );
    report.environment.baseUrl = server.baseUrl;
    report.environment.ownedServer = server.owned;
    report.environment.serverMode = server.mode;
    if (Number.isFinite(server.buildMs)) report.environment.productionBuildMs = server.buildMs;

    const launched = await stage('BROWSER_LAUNCH_FAILED', () =>
      launchFreshPersistentContext({
        profileDirectory,
        explicitChannel: argValue('--channel', process.env.READER_UI_BROWSER_CHANNEL ?? ''),
        headed: hasArg('--headed'),
      }),
    );
    browserContext = launched.context;
    report.environment.browserChannel = launched.channel;
    await browserContext.addInitScript(installBrowserInstrumentation, { heartbeatIntervalMs: 50 });
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());
    page.on('pageerror', (error) => report.browserErrors.push(error.message));
    page.on('console', (message) => {
      const text = message.text();
      if (
        message.type() === 'error' &&
        !text.includes('Failed to load resource: the server responded with a status of 404')
      ) {
        report.browserErrors.push(text);
      }
    });
    await stage('APP_LOAD_FAILED', () =>
      page.goto(server.baseUrl, { waitUntil: 'domcontentloaded', timeout: STARTUP_TIMEOUT_MS }),
    );

    report.cancellation = await stage('IMPORT_CANCELLATION_FLOW_FAILED', () =>
      runCancellationTrial(page, fixturePath, budgets.cancellationMs * 2),
    );
    report.import = await stage('IMPORT_FLOW_FAILED', () => runFullImport(page, fixturePath, budgets.importTotalMs));
    const readerAndSearch = await stage('READER_FLOW_FAILED', () =>
      runReaderAndSearchGate(page, report.import, report.fixture, budgets),
    );
    report.reader = {
      chapterParagraphCount: readerAndSearch.chapterParagraphCount,
      chapterTitle: readerAndSearch.chapterTitle,
      viewports: readerAndSearch.viewports,
      maximumRenderedRows: readerAndSearch.maximumRenderedRows,
    };
    report.search = readerAndSearch.search;
    report.failures.push(...evaluatePhase6PerformanceReport(report, budgets));
    measurementsCompleted = true;
  } catch (error) {
    report.failures.push({
      code: error instanceof GateFailure ? error.code : 'UNEXPECTED_GATE_ERROR',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof GateFailure && error.details !== undefined ? { details: error.details } : {}),
    });
  } finally {
    const cleanupErrors = [];
    if (browserContext) {
      await browserContext.close().catch((error) => cleanupErrors.push(`browser: ${String(error)}`));
    }
    if (profileDirectory) {
      await removeDirectoryWithRetries(profileDirectory).catch((error) =>
        cleanupErrors.push(`browser-profile: ${String(error)}`),
      );
    }
    if (server) {
      await server.stop().catch((error) => cleanupErrors.push(`web-server: ${String(error)}`));
    }
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) =>
        cleanupErrors.push(`fixture: ${String(error)}`),
      );
    }
    if (cleanupErrors.length > 0) {
      report.failures.push({
        code: 'CLEANUP_FAILED',
        message: 'Performance gate cleanup was incomplete.',
        details: cleanupErrors,
      });
    }
    report.measurementsCompleted = measurementsCompleted;
    report.status = report.failures.length === 0 ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();
    report.durationMs = new Date(report.finishedAt).getTime() - startedAt.getTime();
    await writeReport(reportPath, report);
    console.log(phase6ConsoleSummary(report));
    if (report.status !== 'passed') process.exitCode = 1;
  }
}

await main();
