import { describe, expect, it } from 'vitest';
import { importTaskLabel, projectImportProgress } from './import-task-projection';

describe('import task projection', () => {
  it('shows real byte progress only for measurable client work', () => {
    expect(
      projectImportProgress({
        jobId: 'upload',
        status: 'reading',
        subphase: 'uploading_chunks',
        bytesRead: 25,
        totalBytes: 100,
        chaptersDetected: 0,
        paragraphsWritten: 0,
      }),
    ).toEqual({ phase: 'uploading', percent: 25 });

    expect(
      projectImportProgress({
        jobId: 'server',
        status: 'writing',
        subphase: 'server_processing',
        bytesRead: 100,
        totalBytes: 100,
        chaptersDetected: 1,
        paragraphsWritten: 10,
      }),
    ).toEqual({ phase: 'saving' });
  });

  it('keeps server completion in the final catalog-refresh phase', () => {
    const projection = projectImportProgress({
      jobId: 'done',
      status: 'ready',
      subphase: 'complete',
      bytesRead: 100,
      totalBytes: 100,
      chaptersDetected: 1,
      paragraphsWritten: 10,
    });
    expect(projection).toEqual({ phase: 'saving', percent: 100 });
    expect(
      importTaskLabel({
        id: 'task',
        batchId: 'batch',
        source: 'local_file',
        title: '작품',
        phase: projection.phase,
        percent: projection.percent,
      }),
    ).toBe('저장 중');
  });
});
