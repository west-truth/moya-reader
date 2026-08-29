import type { Novel } from '../../domain/types';
import type { ImportProgress } from '../../services/import/import-service';
import type { AiTtsSyncRemoteSnapshot } from '../../sync/ai-tts-sync-diff';
import type { AiTtsSyncConflictGroup } from '../../sync/sync-ui';
import type { ReadingPosition, SyncOutboxItem, SyncState } from '../../sync/types';
import type { SyncMergeSelections } from './useSyncMergeSelections';
import type { CloudVaultController } from '../cloud-vault/useCloudVaultController';

export type SyncConnectionTestState = {
  readonly status: 'idle' | 'testing' | 'ok' | 'failed';
  readonly message?: string;
  readonly normalizedBaseUrl?: string;
};

export interface SyncPanelData {
  readonly cloudVault: CloudVaultController;
  readonly mode: 'local' | 'remote';
  readonly apiBaseUrl?: string;
  readonly syncState?: SyncState;
  readonly syncOutbox: readonly SyncOutboxItem[];
  readonly syncFlushing: boolean;
  readonly syncServiceConnected: boolean;
  readonly remoteReadingPosition?: ReadingPosition;
  readonly remoteReadingPositionChapterTitle?: string;
  readonly serverAttachAvailable: boolean;
  readonly serverAttachBusy: boolean;
  readonly serverAttachProgress?: ImportProgress;
  readonly serverAttachPercent: number;
  readonly importBusy: boolean;
  readonly selectedNovel?: Pick<Novel, 'id' | 'title'>;
  readonly syncApiBaseUrlDraft: string;
  readonly syncConnectionTest: SyncConnectionTestState;
  readonly apiAuthTokenDraft: string;
  readonly apiAuthTokenConfigured: boolean;
  readonly apiAuthTokenStorage: 'browser_storage' | 'native_secure_store';
  readonly mergeSelections: SyncMergeSelections;
}

export interface SyncPanelActions {
  readonly close: () => void;
  readonly retry: () => void | Promise<void>;
  readonly acceptRemoteState: () => void | Promise<void>;
  readonly goToRemoteReadingPosition: () => void | Promise<void>;
  readonly uploadSelectedNovelToServer: () => void | Promise<void>;
  readonly cancelServerAttach: () => void;
  readonly setSyncApiBaseUrlDraft: (value: string) => void;
  readonly testSyncConnection: () => void | Promise<void>;
  readonly saveSyncApiBaseUrl: () => void;
  readonly setApiAuthTokenDraft: (value: string) => void;
  readonly saveApiAuthToken: () => void;
  readonly discardOutboxItem: (item: SyncOutboxItem) => void | Promise<void>;
  readonly discardOutboxGroup: (items: SyncOutboxItem[], label: string) => void | Promise<void>;
  readonly setMergeSelection: (groupKey: string, diffKey: string, checked: boolean) => void;
  readonly clearMergeSelection: (groupKey: string) => void;
  readonly loadRemoteSnapshot?: (group: AiTtsSyncConflictGroup) => Promise<AiTtsSyncRemoteSnapshot>;
  readonly applySelectedLocalFields: (
    group: AiTtsSyncConflictGroup,
    remoteSnapshot: AiTtsSyncRemoteSnapshot,
    selectedKeys: readonly string[],
  ) => Promise<boolean>;
  readonly applyRemoteSnapshot: (
    group: AiTtsSyncConflictGroup,
    remoteSnapshot: AiTtsSyncRemoteSnapshot,
  ) => Promise<boolean>;
}

export interface SyncPanelProps {
  readonly data: SyncPanelData;
  readonly actions: SyncPanelActions;
}
