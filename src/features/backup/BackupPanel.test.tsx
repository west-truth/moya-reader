import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BackupPanel from './BackupPanel';
import type { BackupFeatureController } from './useBackupController';

function controller(overrides: Partial<BackupFeatureController> = {}): BackupFeatureController {
  return {
    open: true,
    busy: false,
    available: true,
    defaultResolution: 'skip',
    conflictResolutions: { book_1: 'copy' },
    usesPlatformPicker: false,
    inspection: {
      manifest: {
        format: 'noveldesk-backup',
        version: 1,
        exportedAt: '2026-07-13T00:00:00.000Z',
        appVersion: '0.1.0',
        books: [{ id: 'book_1', format: 'txt', title: '백업 소설' }],
        entries: [],
        assetBlobs: [],
      },
      conflicts: [{ bookId: 'book_1', title: '백업 소설', existingTitle: '기존 소설' }],
      archiveByteLength: 1024,
      totalUncompressedBytes: 2048,
      warnings: [],
    },
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    exportBackup: vi.fn(async () => undefined),
    pickBackupFile: vi.fn(async () => undefined),
    inspectFile: vi.fn(async () => undefined),
    restoreBackup: vi.fn(async () => undefined),
    setDefaultResolution: vi.fn(),
    setConflictResolution: vi.fn(),
    ...overrides,
  };
}

describe('BackupPanel', () => {
  it('renders export, validated restore and per-book conflict controls', () => {
    const markup = renderToStaticMarkup(<BackupPanel controller={controller()} />);

    expect(markup).toContain('백업 및 복원');
    expect(markup).toContain('전체 백업 만들기');
    expect(markup).toContain('백업 파일 선택');
    expect(markup).toContain('백업 소설');
    expect(markup).toContain('복사본으로 추가');
    expect(markup).toContain('검사한 백업 복원');
  });

  it('shows an explicit unsupported state instead of inactive controls', () => {
    const markup = renderToStaticMarkup(<BackupPanel controller={controller({ available: false })} />);
    expect(markup).toContain('현재 실행 환경에서 전체 백업을 사용할 수 없습니다.');
    expect(markup).not.toContain('백업 파일 선택');
  });
});
