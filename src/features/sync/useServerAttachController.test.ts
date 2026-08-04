import { describe, expect, it } from 'vitest';
import type { ImportProgress } from '../../services/import/import-service';
import { serverAttachIsBusy, serverAttachPercent } from './useServerAttachController';

function progress(patch: Partial<ImportProgress> = {}): ImportProgress {
  return {
    jobId: 'attach-job-1',
    status: 'reading',
    bytesRead: 25,
    totalBytes: 100,
    chaptersDetected: 1,
    paragraphsWritten: 0,
    message: '읽는 중',
    ...patch,
  };
}

describe('server attach controller model', () => {
  it('keeps progress bounded for empty and inconsistent byte totals', () => {
    expect(serverAttachPercent(undefined)).toBe(0);
    expect(serverAttachPercent(progress())).toBe(25);
    expect(serverAttachPercent(progress({ bytesRead: 200 }))).toBe(100);
    expect(serverAttachPercent(progress({ bytesRead: -20, totalBytes: 0 }))).toBe(0);
  });

  it('treats every nonterminal attach phase as busy', () => {
    expect(serverAttachIsBusy(undefined)).toBe(false);
    expect(serverAttachIsBusy(progress({ status: 'cancelling' }))).toBe(true);
    expect(serverAttachIsBusy(progress({ status: 'ready' }))).toBe(false);
    expect(serverAttachIsBusy(progress({ status: 'failed' }))).toBe(false);
  });
});
