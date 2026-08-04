import { PHASE6_FIXTURE_BYTES } from './phase6-large-novel-fixture.mjs';

export const PHASE6_STRICT_INVARIANTS = Object.freeze({
  fixtureBytes: PHASE6_FIXTURE_BYTES,
  minimumChapterCount: 1000,
  minimumHeadingFamilies: 10,
  minimumLargeChapterParagraphs: 15000,
  maximumRenderedRows: 60,
  chapterSearchLimit: 200,
  bookSearchLimit: 300,
  maximumVisibleSearchResults: 6,
  requiredViewports: Object.freeze({
    mobile: Object.freeze({ width: 390, height: 844 }),
    tablet: Object.freeze({ width: 820, height: 1180 }),
    desktop: Object.freeze({ width: 1280, height: 720 }),
    wide: Object.freeze({ width: 1440, height: 900 }),
  }),
});

export const PHASE6_DEFAULT_TIMING_BUDGETS = Object.freeze({
  importTotalMs: 240000,
  importProgressGapMs: 15000,
  eventLoopHeartbeatGapMs: 250,
  cancellationMs: 15000,
  readerNavigationMs: 4000,
  searchResponseMs: 20000,
});

const TIMING_ENV = Object.freeze({
  importTotalMs: 'READER_PERF_IMPORT_BUDGET_MS',
  importProgressGapMs: 'READER_PERF_PROGRESS_GAP_BUDGET_MS',
  eventLoopHeartbeatGapMs: 'READER_PERF_EVENT_LOOP_GAP_BUDGET_MS',
  cancellationMs: 'READER_PERF_CANCELLATION_BUDGET_MS',
  readerNavigationMs: 'READER_PERF_NAVIGATION_BUDGET_MS',
  searchResponseMs: 'READER_PERF_SEARCH_BUDGET_MS',
});

export function phase6TimingBudgets(env = process.env) {
  return Object.fromEntries(
    Object.entries(PHASE6_DEFAULT_TIMING_BUDGETS).map(([key, fallback]) => {
      const envName = TIMING_ENV[key];
      const raw = env[envName];
      if (raw === undefined || raw === '') return [key, fallback];
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${envName} must be a positive number`);
      }
      return [key, value];
    }),
  );
}

function failure(code, message, details) {
  return details === undefined ? { code, message } : { code, message, details };
}

function timingFailure(failures, actual, budget, code, label) {
  if (!Number.isFinite(actual) || actual > budget) {
    failures.push(failure(code, `${label}: ${actual ?? 'missing'}ms (budget ${budget}ms)`, { actual, budget }));
  }
}

export function evaluatePhase6PerformanceReport(report, budgets = PHASE6_DEFAULT_TIMING_BUDGETS) {
  const strict = PHASE6_STRICT_INVARIANTS;
  const failures = [];
  const fixture = report.fixture;
  const cancellation = report.cancellation;
  const imported = report.import;
  const reader = report.reader;
  const search = report.search;

  if (!fixture || fixture.actualBytes !== strict.fixtureBytes || fixture.fileBytes !== strict.fixtureBytes) {
    failures.push(
      failure('FIXTURE_SIZE_INVALID', 'Phase 6 fixture must be exactly 20 MiB.', {
        actual: fixture?.actualBytes,
        fileBytes: fixture?.fileBytes,
        expected: strict.fixtureBytes,
      }),
    );
  }
  if (!fixture || fixture.chapterCount < strict.minimumChapterCount) {
    failures.push(
      failure('FIXTURE_CHAPTER_COUNT_INVALID', 'Fixture must contain at least 1,000 chapters.', {
        actual: fixture?.chapterCount,
        minimum: strict.minimumChapterCount,
      }),
    );
  }
  if (!fixture || Object.keys(fixture.headingFamilyCounts ?? {}).length < strict.minimumHeadingFamilies) {
    failures.push(
      failure('FIXTURE_HEADING_FAMILIES_MISSING', 'Fixture does not cover enough chapter heading families.', {
        actual: Object.keys(fixture?.headingFamilyCounts ?? {}).length,
        minimum: strict.minimumHeadingFamilies,
      }),
    );
  }
  if (!fixture || fixture.largestChapter?.paragraphs < strict.minimumLargeChapterParagraphs) {
    failures.push(
      failure('FIXTURE_LARGE_CHAPTER_MISSING', 'Fixture does not contain the required very large chapter.', {
        actual: fixture?.largestChapter?.paragraphs,
        minimum: strict.minimumLargeChapterParagraphs,
      }),
    );
  }

  if (
    !cancellation?.observed ||
    !cancellation.workerPathObserved ||
    cancellation.workerFileBytes !== strict.fixtureBytes ||
    cancellation.storageNovelCountAfter !== 0 ||
    cancellation.storageRevisionCountAfter !== 0
  ) {
    failures.push(
      failure('IMPORT_CANCELLATION_NOT_OBSERVED', 'Import cancellation did not finish cleanly.', {
        observed: cancellation?.observed,
        workerPathObserved: cancellation?.workerPathObserved,
        workerFileBytes: cancellation?.workerFileBytes,
        storageNovelCountAfter: cancellation?.storageNovelCountAfter,
        storageRevisionCountAfter: cancellation?.storageRevisionCountAfter,
      }),
    );
  }
  timingFailure(
    failures,
    cancellation?.responseMs,
    budgets.cancellationMs,
    'IMPORT_CANCELLATION_TIMEOUT',
    'Cancellation',
  );
  timingFailure(
    failures,
    cancellation?.eventLoop?.maximumGapMs,
    budgets.eventLoopHeartbeatGapMs,
    'IMPORT_CANCELLATION_UI_STALL',
    'Cancellation UI heartbeat gap',
  );

  const requiredProgressStatuses = ['reading', 'decoding', 'writing', 'ready'];
  const progressStatuses = new Set(imported?.progressStatuses ?? []);
  const missingStatuses = requiredProgressStatuses.filter((status) => !progressStatuses.has(status));
  if (!imported || imported.progressEventCount < requiredProgressStatuses.length || missingStatuses.length > 0) {
    failures.push(
      failure('IMPORT_PROGRESS_MISSING', 'Real import worker did not deliver the required progress phases.', {
        eventCount: imported?.progressEventCount,
        missingStatuses,
      }),
    );
  }
  if (!imported?.workerPathObserved || imported.workerFileBytes !== strict.fixtureBytes) {
    failures.push(failure('IMPORT_WORKER_PATH_NOT_OBSERVED', 'The measured worker was not the real import worker.'));
  }
  timingFailure(failures, imported?.totalMs, budgets.importTotalMs, 'IMPORT_TOTAL_TIMEOUT', 'Import');
  timingFailure(
    failures,
    imported?.maximumProgressGapMs,
    budgets.importProgressGapMs,
    'IMPORT_PROGRESS_STALLED',
    'Import progress gap',
  );
  timingFailure(
    failures,
    imported?.eventLoop?.maximumGapMs,
    budgets.eventLoopHeartbeatGapMs,
    'IMPORT_EVENT_LOOP_STALL',
    'Main event-loop heartbeat gap',
  );
  if (!imported?.eventLoop || imported.eventLoop.tickCount < 1 || imported.eventLoop.durationMs <= 0) {
    failures.push(
      failure(
        'IMPORT_HEARTBEAT_NOT_OBSERVED',
        'Import did not produce a measurable browser heartbeat.',
        imported?.eventLoop,
      ),
    );
  }
  if (
    !imported?.storage ||
    imported.storage.novelCount !== 1 ||
    imported.storage.chapterCount < strict.minimumChapterCount ||
    imported.storage.largestChapterParagraphs < strict.minimumLargeChapterParagraphs
  ) {
    failures.push(
      failure(
        'IMPORT_STORAGE_NOT_PERSISTED',
        'Imported content is missing from the real IndexedDB revision stores.',
        imported?.storage,
      ),
    );
  }

  if (!reader || reader.chapterParagraphCount < strict.minimumLargeChapterParagraphs) {
    failures.push(
      failure('READER_LARGE_CHAPTER_NOT_OPEN', 'The real reader did not open the fixture large chapter.', {
        actual: reader?.chapterParagraphCount,
        minimum: strict.minimumLargeChapterParagraphs,
        title: reader?.chapterTitle,
      }),
    );
  }
  const viewportMap = new Map((reader?.viewports ?? []).map((viewport) => [viewport.name, viewport]));
  for (const [name, dimensions] of Object.entries(strict.requiredViewports)) {
    const viewport = viewportMap.get(name);
    if (!viewport || viewport.width !== dimensions.width || viewport.height !== dimensions.height) {
      failures.push(
        failure('READER_VIEWPORT_COVERAGE_MISSING', `${name} viewport was not measured at its required size.`, {
          expected: dimensions,
          actual: viewport ? { width: viewport.width, height: viewport.height } : undefined,
        }),
      );
      continue;
    }
    if (viewport.horizontalOverflowIssues?.length > 0) {
      failures.push(
        failure(
          'READER_HORIZONTAL_OVERFLOW',
          `${viewport.name} reader has horizontal overflow.`,
          viewport.horizontalOverflowIssues,
        ),
      );
    }
    for (const sample of viewport.samples ?? []) {
      if (
        sample.renderedRows < 1 ||
        sample.renderedParagraphs < 1 ||
        sample.renderedRows > strict.maximumRenderedRows ||
        sample.renderedParagraphs > strict.maximumRenderedRows
      ) {
        failures.push(
          failure('READER_DOM_UNBOUNDED', `${viewport.name}/${sample.position} rendered an invalid row count.`, sample),
        );
      }
      timingFailure(
        failures,
        sample.navigationMs,
        budgets.readerNavigationMs,
        'READER_NAVIGATION_TIMEOUT',
        `${viewport.name}/${sample.position} navigation`,
      );
      timingFailure(
        failures,
        sample.eventLoop?.maximumGapMs,
        budgets.eventLoopHeartbeatGapMs,
        'READER_SCROLL_EVENT_LOOP_STALL',
        `${viewport.name}/${sample.position} heartbeat gap`,
      );
      if (!Number.isFinite(sample.actualFraction) || Math.abs(sample.actualFraction - sample.targetFraction) >= 0.08) {
        failures.push(
          failure(
            'READER_SCROLL_POSITION_INVALID',
            `${viewport.name}/${sample.position} did not settle at the requested scroll position.`,
            sample,
          ),
        );
      }
    }
    const sampleMap = new Map((viewport.samples ?? []).map((sample) => [sample.position, sample]));
    const top = sampleMap.get('top');
    const middle = sampleMap.get('middle');
    const end = sampleMap.get('end');
    if (
      viewport.samples?.length !== 3 ||
      !top ||
      !middle ||
      !end ||
      top.firstRenderedIndex < 0 ||
      top.firstRenderedIndex > 2 ||
      middle.firstRenderedIndex <= top.firstRenderedIndex ||
      end.firstRenderedIndex <= middle.firstRenderedIndex
    ) {
      failures.push(
        failure('READER_SCROLL_WINDOW_STALE', `${viewport.name} virtual rows did not advance across top/middle/end.`, {
          top: top?.firstRenderedIndex,
          middle: middle?.firstRenderedIndex,
          end: end?.firstRenderedIndex,
        }),
      );
    }
  }
  if (!reader || (reader.viewports?.length ?? 0) !== Object.keys(strict.requiredViewports).length) {
    failures.push(failure('READER_VIEWPORT_COVERAGE_MISSING', 'All four release viewports are required.'));
  }

  const searchChecks = [
    ['chapter', search?.chapter, strict.chapterSearchLimit, 'SEARCH_CHAPTER_CAP_INVALID'],
    ['book', search?.book, strict.bookSearchLimit, 'SEARCH_BOOK_CAP_INVALID'],
  ];
  for (const [scope, measurement, expectedLimit, code] of searchChecks) {
    if (!measurement || measurement.reportedCount !== expectedLimit || !measurement.limited) {
      failures.push(failure(code, `${scope} search did not stop at its configured cap.`, measurement));
    }
    if (
      !measurement ||
      measurement.visibleResultCount < 1 ||
      measurement.visibleResultCount > strict.maximumVisibleSearchResults
    ) {
      failures.push(
        failure(
          'SEARCH_RESULT_WINDOW_UNBOUNDED',
          `${scope} search materialized too many result controls.`,
          measurement,
        ),
      );
    }
    if (!measurement?.navigationAdvanced) {
      failures.push(
        failure('SEARCH_PAGINATION_BROKEN', `${scope} search result-window navigation did not advance.`, measurement),
      );
    }
    timingFailure(
      failures,
      measurement?.responseMs,
      budgets.searchResponseMs,
      'SEARCH_RESPONSE_TIMEOUT',
      `${scope} search`,
    );
  }

  if (
    !search?.cancellation?.freshResultWon ||
    search.cancellation.reportedCount !== 1 ||
    !search.cancellation.supersededSearchStarted ||
    !search.cancellation.abortSignalObserved
  ) {
    failures.push(
      failure(
        'SEARCH_CANCELLATION_STALE_RESULT',
        'A superseded search result replaced the fresh query.',
        search?.cancellation,
      ),
    );
  }
  timingFailure(
    failures,
    search?.cancellation?.responseMs,
    budgets.searchResponseMs,
    'SEARCH_CANCELLATION_TIMEOUT',
    'Search cancellation',
  );

  if ((report.browserErrors?.length ?? 0) > 0) {
    failures.push(failure('BROWSER_ERROR', 'Browser console or page errors were recorded.', report.browserErrors));
  }

  return failures;
}

export function phase6ConsoleSummary(report) {
  const status = report.status === 'passed' ? 'PASS' : 'FAIL';
  const failureCodes = (report.failures ?? []).map((item) => item.code).join(', ');
  const lines = [
    `Phase 6 20MiB reader performance gate: ${status}${failureCodes ? ` [${failureCodes}]` : ''}`,
    `fixture ${(report.fixture?.actualBytes / 1024 / 1024).toFixed(2)}MiB, ${report.fixture?.chapterCount ?? 0} chapters, ${report.fixture?.largestChapter?.paragraphs ?? 0} paragraphs in largest chapter`,
    `cancel ${Math.round(report.cancellation?.responseMs ?? 0)}ms; import ${Math.round(report.import?.totalMs ?? 0)}ms; max heartbeat gap ${Math.round(report.import?.eventLoop?.maximumGapMs ?? 0)}ms; progress ${report.import?.progressEventCount ?? 0}`,
    `reader max rows ${report.reader?.maximumRenderedRows ?? 0}; search ${report.search?.chapter?.reportedCount ?? 0}/${report.search?.book?.reportedCount ?? 0}`,
    `report ${report.reportPath}`,
  ];
  return lines.join('\n');
}
