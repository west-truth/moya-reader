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
      rememberPassphrase: true,
      autoSync: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    connected: false,
    passphrase: '',
    unlocked: false,
    directoryAvailable: true,
    dropboxAvailable: true,
    backupOnly: false,
    setPassphrase: vi.fn(),
    setRememberPassphrase: vi.fn().mockResolvedValue(undefined),
    setAutoSync: vi.fn().mockResolvedValue(undefined),
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

    expect(markup).toContain('>동기화</h2>');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('기기 간 동기화');
    expect(markup).toContain('Dropbox 연결');
    expect(markup).toContain('8자 이상');
    expect(markup).toContain('이 기기에서 기억');
    expect(markup).toContain('자동 동기화');
    expect(markup).toContain('다른 저장 위치');
    expect(markup.indexOf('Dropbox 연결')).toBeLessThan(markup.indexOf('로컬 폴더'));
    expect(markup).not.toContain('서버 없이 독서 기록을 암호화해 보관합니다.');
    expect(markup).toContain('개인 서버');
    expect(markup).toContain('선택 사항');
    expect(markup).not.toContain('대기 중인 변경');
    expect(markup).not.toContain('메모 수정');
    expect(markup).not.toContain('시도 2회');
    expect(markup).not.toContain('서버 상태로 정리');
  });

  it('treats stale server state as local-only when no server is configured', () => {
    const markup = renderToStaticMarkup(
      <SyncPanel
        data={data({
          syncState: {
            ...syncState('offline'),
            pendingCount: 13,
            lastError: 'Failed to fetch',
          },
        })}
        actions={actions()}
      />,
    );

    expect(markup).not.toContain('로컬 전용');
    expect(markup).not.toContain('대기 중인 변경');
    expect(markup).not.toContain('오프라인');
    expect(markup).not.toContain('서버에 연결할 수 없음');
    expect(markup).not.toContain('Failed to fetch');
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

  it('shows sync time only when it belongs to the connected Cloud Vault provider', () => {
    const base = cloudVault();
    const staleDropbox: CloudVaultController = {
      ...base,
      connected: true,
      providerKind: 'dropbox',
      providerLabel: 'reader@example.com',
      passphrase: 'long-enough-passphrase',
      config: {
        ...base.config!,
        providerKind: 'dropbox',
        lastSyncAt: '2026-08-28T06:38:00.000Z',
        lastUploadedBytes: 1024,
      },
    };
    const staleMarkup = renderToStaticMarkup(
      <SyncPanel data={data({ cloudVault: staleDropbox })} actions={actions()} />,
    );

    expect(staleMarkup).toContain('아직 동기화하지 않았습니다.');
    expect(staleMarkup).not.toContain('암호화 기록 1 KB');

    const currentMarkup = renderToStaticMarkup(
      <SyncPanel
        data={data({
          cloudVault: {
            ...staleDropbox,
            config: { ...staleDropbox.config!, lastSyncProviderKind: 'dropbox' },
          },
        })}
        actions={actions()}
      />,
    );
    expect(currentMarkup).toContain('암호화 기록 1 KB');
  });

  it('keeps a remembered device unlocked without rendering the Vault password input', () => {
    const base = cloudVault();
    const markup = renderToStaticMarkup(
      <SyncPanel
        data={data({
          cloudVault: {
            ...base,
            connected: true,
            unlocked: true,
            providerKind: 'dropbox',
            providerLabel: 'reader@example.com',
            config: { ...base.config!, providerKind: 'dropbox' },
          },
        })}
        actions={actions()}
      />,
    );

    expect(markup).toContain('이 기기에서 잠금 해제됨');
    expect(markup).not.toContain('placeholder="8자 이상"');
  });
});
