import { describe, expect, it } from 'vitest';
import { importTaskIsActive, importTaskLabel, projectImportProgress } from './import-task-projection';

describe('import task projection', () => {
  it('does not treat completed upload bytes as whole-job progress', () => {
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

  it('treats a committed external release as complete and immediately usable', () => {
    const task = {
      id: 'task',
      batchId: 'batch',
      source: 'external_source' as const,
      title: '작품',
      phase: 'complete' as const,
    };
    expect(importTaskLabel(task)).toBe('완료');
    expect(importTaskIsActive(task)).toBe(false);
  });
});

it('shows a short server activity in place and clears it for later client work', () => {
  const progress = {
    jobId: 'server',
    status: 'writing' as const,
    subphase: 'server_processing' as const,
    bytesRead: 100,
    totalBytes: 100,
    chaptersDetected: 1,
    paragraphsWritten: 0,
    message: '이미지 저장 45개',
  };
  const task = {
    id: 'task',
    batchId: 'batch',
    source: 'local_file' as const,
    title: '작품',
    ...projectImportProgress(progress),
  };
  expect(importTaskLabel(task)).toBe('저장 45개');
  expect(task.percent).toBeUndefined();
  expect(
    importTaskLabel({
      ...task,
      ...projectImportProgress({ ...progress, status: 'reading', subphase: 'uploading_chunks', bytesRead: 25 }),
    }),
  ).toBe('업로드 25%');
  expect(importTaskLabel({ ...task, phase: 'complete' })).toBe('완료');
  expect(projectImportProgress({ ...progress, message: '긴 서버 설명'.repeat(20) }).activity).toBeUndefined();
});
