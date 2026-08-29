import { describe, expect, it } from 'vitest';
import {
  PHASE6_DEFAULT_TIMING_BUDGETS,
  PHASE6_STRICT_INVARIANTS,
  evaluatePhase6PerformanceReport,
  phase6ImportPhaseTimings,
  phase6TimingBudgets,
} from './reader-performance-policy.mjs';

function passingReport() {
  const strict = PHASE6_STRICT_INVARIANTS;
  const sample = (position) => ({
    position,
    targetFraction: position === 'top' ? 0 : position === 'middle' ? 0.5 : 0.95,
    actualFraction: position === 'top' ? 0 : position === 'middle' ? 0.5 : 0.95,
    navigationMs: 120,
    eventLoop: { maximumGapMs: 55 },
    renderedRows: 18,
    renderedParagraphs: 18,
    firstRenderedIndex: position === 'top' ? 0 : position === 'middle' ? 10000 : 20000,
  });
  const search = (reportedCount) => ({
    responseMs: 300,
    reportedCount,
    limited: true,
    visibleResultCount: 6,
    navigationAdvanced: true,
  });
  return {
    fixture: {
      actualBytes: strict.fixtureBytes,
      fileBytes: strict.fixtureBytes,
      chapterCount: strict.minimumChapterCount,
      headingFamilyCounts: Object.fromEntries(
        Array.from({ length: strict.minimumHeadingFamilies }, (_, index) => [`f${index}`, 1]),
      ),
      largestChapter: { paragraphs: strict.minimumLargeChapterParagraphs },
    },
    cancellation: {
      observed: true,
      workerPathObserved: true,
      workerFileBytes: strict.fixtureBytes,
      responseMs: 80,
      eventLoop: { maximumGapMs: 55 },
      storageNovelCountAfter: 0,
      storageRevisionCountAfter: 0,
    },
    import: {
      workerPathObserved: true,
      workerFileBytes: strict.fixtureBytes,
      totalMs: 12000,
      progressEventCount: 20,
      progressStatuses: ['reading', 'decoding', 'writing', 'ready'],
      phaseTimings: { parseMs: 4000, bodyWriteMs: 6000, activationMs: 1500 },
      maximumProgressGapMs: 800,
      eventLoop: { maximumGapMs: 70, tickCount: 10, durationMs: 1000 },
      storage: {
        novelCount: 1,
        chapterCount: strict.minimumChapterCount,
        largestChapterParagraphs: strict.minimumLargeChapterParagraphs,
      },
    },
    reader: {
      chapterParagraphCount: strict.minimumLargeChapterParagraphs,
      viewports: [
        ...Object.entries(strict.requiredViewports).map(([name, viewport]) => ({
          name,
          ...viewport,
          samples: [sample('top'), sample('middle'), sample('end')],
          horizontalOverflowIssues: [],
        })),
      ],
    },
    search: {
      chapter: search(strict.chapterSearchLimit),
      book: search(strict.bookSearchLimit),
      cancellation: {
        responseMs: 350,
        reportedCount: 1,
        freshResultWon: true,
        supersededSearchStarted: true,
        abortSignalObserved: true,
      },
    },
    browserErrors: [],
  };
}

describe('Phase 6 reader performance report policy', () => {
  it('derives parse, body-write, and activation durations from worker subphases', () => {
    expect(
      phase6ImportPhaseTimings({
        startedAt: 100,
        progress: [
          { at: 180, status: 'decoding', subphase: 'decoding_text' },
          { at: 300, status: 'writing', subphase: 'staging_chapters' },
          { at: 700, status: 'writing', subphase: 'writing_pages' },
          { at: 900, status: 'writing', subphase: 'activating_revision' },
        ],
        terminal: { at: 1100, type: 'complete' },
      }),
    ).toEqual({ parseMs: 200, bodyWriteMs: 600, activationMs: 200 });
  });

  it('accepts a complete report within the generous timing budgets', () => {
    expect(evaluatePhase6PerformanceReport(passingReport())).toEqual([]);
  });

  it('returns stable reason codes for timing regressions', () => {
    const report = passingReport();
    report.import.totalMs = PHASE6_DEFAULT_TIMING_BUDGETS.importTotalMs + 1;
    report.import.eventLoop.maximumGapMs = PHASE6_DEFAULT_TIMING_BUDGETS.eventLoopHeartbeatGapMs + 1;
    report.cancellation.responseMs = PHASE6_DEFAULT_TIMING_BUDGETS.cancellationMs + 1;
    expect(evaluatePhase6PerformanceReport(report).map((item) => item.code)).toEqual(
      expect.arrayContaining(['IMPORT_TOTAL_TIMEOUT', 'IMPORT_EVENT_LOOP_STALL', 'IMPORT_CANCELLATION_TIMEOUT']),
    );
  });

  it('rejects reports that do not contain complete import subphase timings', () => {
    const report = passingReport();
    report.import.phaseTimings.activationMs = null;

    expect(evaluatePhase6PerformanceReport(report).map((item) => item.code)).toContain('IMPORT_PHASE_TIMING_MISSING');
  });

  it('keeps DOM and search correctness strict when timing budgets are overridden', () => {
    const report = passingReport();
    report.reader.viewports[0].samples[0].renderedRows = PHASE6_STRICT_INVARIANTS.maximumRenderedRows + 1;
    report.search.chapter.reportedCount = PHASE6_STRICT_INVARIANTS.chapterSearchLimit - 1;
    report.search.book.visibleResultCount = PHASE6_STRICT_INVARIANTS.maximumVisibleSearchResults + 1;
    const permissive = Object.fromEntries(
      Object.keys(PHASE6_DEFAULT_TIMING_BUDGETS).map((key) => [key, Number.MAX_SAFE_INTEGER]),
    );
    expect(evaluatePhase6PerformanceReport(report, permissive).map((item) => item.code)).toEqual(
      expect.arrayContaining(['READER_DOM_UNBOUNDED', 'SEARCH_CHAPTER_CAP_INVALID', 'SEARCH_RESULT_WINDOW_UNBOUNDED']),
    );
  });

  it('rejects fixture metadata that was not delivered to both real import worker runs', () => {
    const report = passingReport();
    report.fixture.fileBytes -= 1;
    report.cancellation.workerFileBytes -= 1;
    report.import.workerFileBytes -= 1;

    expect(evaluatePhase6PerformanceReport(report).map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'FIXTURE_SIZE_INVALID',
        'IMPORT_CANCELLATION_NOT_OBSERVED',
        'IMPORT_WORKER_PATH_NOT_OBSERVED',
      ]),
    );
  });

  it('rejects a stale virtual window and a stale-result check that never cancelled an in-flight search', () => {
    const report = passingReport();
    report.reader.viewports[0].samples[2].firstRenderedIndex = report.reader.viewports[0].samples[1].firstRenderedIndex;
    report.search.cancellation.abortSignalObserved = false;

    expect(evaluatePhase6PerformanceReport(report).map((item) => item.code)).toEqual(
      expect.arrayContaining(['READER_SCROLL_WINDOW_STALE', 'SEARCH_CANCELLATION_STALE_RESULT']),
    );
  });

  it('allows only positive timing overrides', () => {
    expect(phase6TimingBudgets({ READER_PERF_IMPORT_BUDGET_MS: '300000' }).importTotalMs).toBe(300000);
    expect(() => phase6TimingBudgets({ READER_PERF_IMPORT_BUDGET_MS: '0' })).toThrow(/positive number/);
  });
});
