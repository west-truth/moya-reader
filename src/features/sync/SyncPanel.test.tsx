import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SyncOutboxItem, SyncState } from '../../sync/types';
import { DEFAULT_CLOUD_VAULT_SCOPE } from '../../cloud-vault/contracts';
import type { CloudVaultController } from '../cloud-vault/useCloudVaultController';
import SyncPanel from './SyncPanel';
import type { SyncPanelActions, SyncPanelData } from './sync-panel-contract';

function outboxItem(status: SyncOutboxItem['status'] = 'pending'): SyncOutboxItem {
  return {
    id: 'outbox-note-1',
    event: {
      id: 'event-note-1',
      type: 'note_updated',
      deviceId: 'local-browser-123456789',
      novelId: 'book-abcdef123456789',
      entityId: 'note-123456789abcdef',
      payload: { noteId: 'note-123456789abcdef' },
      createdAt: '2026-07-05T00:00:00.000Z',
    },
    status,
    localSequence: 1,
    attempts: 2,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function syncState(status: SyncState['status']): SyncState {
  return {
    id: 'sync-state',
    mode: 'connected',
    status,
    pendingCount: 1,
    nextSequence: 2,
    lastSyncedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function cloudVault(): CloudVaultController {
  return {
    available: true,
    activity: 'idle',
    config: {
      id: 'cloud-vault-config',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
      waitingBookTitles: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    connected: false,
    passphrase: '',
    directoryAvailable: true,
    dropboxAvailable: false,
    dropboxSetupHint: '배포 빌드에 VITE_DROPBOX_APP_KEY 설정이 필요합니다.',
    backupOnly: false,
    setPassphrase: vi.fn(),
    setScope: vi.fn().mockResolvedValue(undefined),
    selectDirectory: vi.fn().mockResolvedValue(undefined),
    connectDropbox: vi.fn().mockResolvedValue(undefined),
    syncNow: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function data(patch: Partial<SyncPanelData> = {}): SyncPanelData {
  return {
    cloudVault: cloudVault(),
    mode: 'local',
    syncOutbox: [outboxItem()],
    syncFlushing: false,
    syncServiceConnected: false,
    serverAttachAvailable: false,
    serverAttachBusy: false,
    serverAttachPercent: 0,
    importBusy: false,
    syncApiBaseUrlDraft: '',
    syncConnectionTest: { status: 'idle' },
    apiAuthTokenDraft: '',
    apiAuthTokenConfigured: false,
    apiAuthTokenStorage: 'browser_storage',
    mergeSelections: {},
    ...patch,
  };
}

function actions(): SyncPanelActions {
  return {
    close: vi.fn(),
    retry: vi.fn(),
    acceptRemoteState: vi.fn(),
    goToRemoteReadingPosition: vi.fn(),
    uploadSelectedNovelToServer: vi.fn(),
    cancelServerAttach: vi.fn(),
    setSyncApiBaseUrlDraft: vi.fn(),
    testSyncConnection: vi.fn(),
    saveSyncApiBaseUrl: vi.fn(),
    setApiAuthTokenDraft: vi.fn(),
    saveApiAuthToken: vi.fn(),
    discardOutboxItem: vi.fn(),
    discardOutboxGroup: vi.fn(),
    setMergeSelection: vi.fn(),
    clearMergeSelection: vi.fn(),
    applySelectedLocalFields: vi.fn().mockResolvedValue(true),
    applyRemoteSnapshot: vi.fn().mockResolvedValue(true),
  };
}

describe('SyncPanel', () => {
  it('renders local-only connection controls and queued reader changes through its feature contract', () => {
    const markup = renderToStaticMarkup(<SyncPanel data={data()} actions={actions()} />);

    expect(markup).toContain('동기화 상태');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Cloud Vault');
    expect(markup).toContain('VITE_DROPBOX_APP_KEY');
    expect(markup).toContain('서버 연결');
    expect(markup).toContain('로컬 변경 기록');
    expect(markup).toContain('메모 수정');
    expect(markup).toContain('시도 2회');
    expect(markup).not.toContain('서버 상태로 정리');
  });

  it('shows conflict recovery and remote reading position only when supplied by the controller', () => {
    const markup = renderToStaticMarkup(
      <SyncPanel
        data={data({
          syncServiceConnected: true,
          syncState: syncState('conflict'),
          remoteReadingPosition: {
            id: 'position-book-abcdef123456789',
            novelId: 'book-abcdef123456789',
            chapterId: 'chapter-123456789abcdef',
            paragraphId: 'paragraph-123456789abcdef',
            paragraphIndex: 7,
            offsetInParagraph: 0,
            chapterProgress: 0.42,
            scrollTop: 120,
            deviceId: 'local-browser-123456789',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
          remoteReadingPositionChapterTitle: '7화 갈림길',
        })}
        actions={actions()}
      />,
    );

    expect(markup).toContain('서버 상태로 정리');
    expect(markup).toContain('7화 갈림길');
    expect(markup).toContain('42%');
    expect(markup).toContain('7문단');
  });
});
