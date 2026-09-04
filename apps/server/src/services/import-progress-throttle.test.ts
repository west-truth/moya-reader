import { describe, expect, it } from 'vitest';
import {
  createImportProgressUpdateThrottle,
  IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS,
} from './import-progress-throttle.js';

describe('import progress update throttle', () => {
  it('allows the first update and limits repeated writes to the configured interval', () => {
    const shouldUpdate = createImportProgressUpdateThrottle();

    expect(shouldUpdate(10_000)).toBe(true);
    expect(shouldUpdate(10_000 + IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldUpdate(10_000 + IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS)).toBe(true);
    expect(shouldUpdate(10_000 + IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS * 2 - 1)).toBe(false);
    expect(shouldUpdate(10_000 + IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS * 2)).toBe(true);
  });
});
