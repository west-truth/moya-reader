import { BrowserImportService } from '../services/import/browser-import-service';
import { ImportService } from '../services/import/import-service';
import { LocalBookAttachService } from '../services/import/local-book-attach-service';
import { ServerUploadImportService } from '../services/import/server-upload-import-service';
import { RemoteApiClient } from '../services/remote/remote-api-client';
import { LocalOutboxSyncService } from '../sync/local-outbox-sync-service';
import { IndexedDbReaderRepository } from './indexeddb-reader-repository';
import { IndexedDbBookAssetRepository } from './indexeddb-book-asset-repository';
import { IndexedDbLibraryCatalogRepository } from './indexeddb-library-catalog-repository';
import { ReaderRepository } from './reader-repository';
import type { BookAssetRepository } from './book-asset-repository';
import type { LibraryCatalogRepository } from './library-catalog-repository';
import type { BackupRepository } from './backup-repository';
import { IndexedDbBackupRepository } from './indexeddb-backup-repository';
import { RemoteReaderRepository } from './remote-reader-repository';
import { RemoteBookAssetRepository } from './remote-book-asset-repository';
import { RemoteLibraryCatalogRepository } from './remote-library-catalog-repository';
import { RemoteBackupRepository } from './remote-backup-repository';
import type { ChapterStructureRepository } from './chapter-structure-repository';
import { IndexedDbChapterStructureRepository } from './indexeddb-chapter-structure-repository';
import { RemoteChapterStructureRepository } from './remote-chapter-structure-repository';
import type { ReaderPersonalizationRepository } from './reader-personalization-repository';
import { IndexedDbReaderPersonalizationRepository } from './indexeddb-reader-personalization-repository';
import { RemoteReaderPersonalizationRepository } from './remote-reader-personalization-repository';
import { defaultSettings, PARAGRAPHS_PER_PAGE } from './reader-defaults';
import type { ReaderDocumentRepository } from './reader-document-repository';
import { RepositoryBackedReaderDocumentRepository } from './reader-document-repository';
import {
  API_AUTH_TOKEN_STORAGE_KEY,
  apiAuthTokenUsesAndroidKeystore,
  getApiAuthTokenDraft,
  resolveStoredApiAuthToken,
  saveApiAuthToken,
} from '../platform/secure-credentials';

export type ReaderBackendMode = 'local' | 'remote';

export interface ReaderRuntime {
  mode: ReaderBackendMode;
  apiBaseUrl?: string;
  remoteApiClient?: RemoteApiClient;
  syncApiClient?: RemoteApiClient;
  readerRepository: ReaderRepository;
  bookAssetRepository?: BookAssetRepository;
  libraryCatalogRepository?: LibraryCatalogRepository;
  backupRepository?: BackupRepository;
  chapterStructureRepository?: ChapterStructureRepository;
  personalizationRepository?: ReaderPersonalizationRepository;
  documentRepository: ReaderDocumentRepository;
  importService: ImportService;
  syncService?: LocalOutboxSyncService;
  serverAttachService?: LocalBookAttachService;
}

export { API_AUTH_TOKEN_STORAGE_KEY };
export const SYNC_API_BASE_URL_STORAGE_KEY = 'noveldesk.syncApiBaseUrl.v1';
export const REMOTE_DEVICE_ID_STORAGE_KEY = 'noveldesk.remoteDeviceId';

function resolveApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api';
}

export function getStoredApiAuthToken(): string {
  return getApiAuthTokenDraft();
}

export function saveStoredApiAuthToken(token: string): Promise<void> {
  return saveApiAuthToken(token);
}

export function resolveApiAuthToken(): string | undefined {
  const stored = resolveStoredApiAuthToken();
  if (stored) return stored;
  if (apiAuthTokenUsesAndroidKeystore()) return undefined;
  return (import.meta.env.VITE_API_AUTH_TOKEN as string | undefined)?.trim() || undefined;
}

export function normalizeSyncApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  try {
    const fallbackOrigin = globalThis.location?.origin || 'http://local.invalid';
    const url = new URL(withoutTrailingSlash, fallbackOrigin);
    const isRelative = !/^[a-z][a-z\d+\-.]*:/i.test(withoutTrailingSlash);
    const pathname = url.pathname.replace(/\/+$/, '');
    const needsDefaultApiPath = pathname === '' || pathname === '/';
    if (needsDefaultApiPath) {
      url.pathname = '/api';
    } else {
      url.pathname = pathname;
    }
    url.search = '';
    url.hash = '';
    if (isRelative) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return withoutTrailingSlash;
  }
}

export function getStoredSyncApiBaseUrl(): string {
  try {
    return normalizeSyncApiBaseUrl(globalThis.localStorage?.getItem(SYNC_API_BASE_URL_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

export function saveStoredSyncApiBaseUrl(value: string): string {
  const normalized = normalizeSyncApiBaseUrl(value);
  try {
    if (normalized) {
      globalThis.localStorage?.setItem(SYNC_API_BASE_URL_STORAGE_KEY, normalized);
    } else {
      globalThis.localStorage?.removeItem(SYNC_API_BASE_URL_STORAGE_KEY);
    }
  } catch {
    // Storage access can fail in restricted browser contexts; the current runtime keeps using its startup config.
  }
  return normalized;
}

export function resolveSyncApiBaseUrl(): string | undefined {
  const stored = getStoredSyncApiBaseUrl();
  if (stored) return stored;
  return normalizeSyncApiBaseUrl((import.meta.env.VITE_SYNC_API_BASE_URL as string | undefined) ?? '') || undefined;
}

export interface SyncApiConnectionTestResult {
  ok: boolean;
  normalizedBaseUrl: string;
  status?: number;
  message: string;
}

export async function testSyncApiConnection(baseUrl: string, authToken?: string): Promise<SyncApiConnectionTestResult> {
  const normalizedBaseUrl = normalizeSyncApiBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      normalizedBaseUrl,
      message: '서버 API URL을 입력하세요.',
    };
  }

  try {
    const response = await fetch(`${normalizedBaseUrl}/ready`, {
      headers: authToken?.trim() ? { Authorization: `Bearer ${authToken.trim()}` } : undefined,
    });
    if (!response.ok) {
      const message = await response.text();
      return {
        ok: false,
        normalizedBaseUrl,
        status: response.status,
        message: message || response.statusText || `서버 응답 ${response.status}`,
      };
    }
    return {
      ok: true,
      normalizedBaseUrl,
      status: response.status,
      message: '서버 readiness 확인에 성공했습니다.',
    };
  } catch (error) {
    return {
      ok: false,
      normalizedBaseUrl,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function randomDeviceSuffix(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId.replace(/-/g, '').slice(0, 20);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function getOrCreateRemoteDeviceId(): string {
  try {
    const stored = globalThis.localStorage?.getItem(REMOTE_DEVICE_ID_STORAGE_KEY)?.trim();
    if (stored) return stored;
    const next = `device_web_${randomDeviceSuffix()}`;
    globalThis.localStorage?.setItem(REMOTE_DEVICE_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return `device_web_${randomDeviceSuffix()}`;
  }
}

export function createReaderRuntime(): ReaderRuntime {
  const mode = import.meta.env.VITE_READER_BACKEND === 'remote' ? 'remote' : 'local';
  if (mode === 'remote') {
    const apiBaseUrl = resolveApiBaseUrl();
    const client = new RemoteApiClient(apiBaseUrl, { getAuthToken: resolveApiAuthToken });
    const deviceId = getOrCreateRemoteDeviceId();
    const remoteRepository = new RemoteReaderRepository(client, deviceId);
    return {
      mode,
      apiBaseUrl,
      remoteApiClient: client,
      syncApiClient: client,
      readerRepository: remoteRepository,
      documentRepository: new RepositoryBackedReaderDocumentRepository(remoteRepository),
      bookAssetRepository: new RemoteBookAssetRepository(client),
      libraryCatalogRepository: new RemoteLibraryCatalogRepository(client),
      backupRepository: new RemoteBackupRepository(client),
      chapterStructureRepository: new RemoteChapterStructureRepository(client),
      personalizationRepository: new RemoteReaderPersonalizationRepository(client),
      importService: new ServerUploadImportService(client),
    };
  }

  const syncApiBaseUrl = resolveSyncApiBaseUrl();
  const localRepository = new IndexedDbReaderRepository();
  const syncClient = syncApiBaseUrl
    ? new RemoteApiClient(syncApiBaseUrl, { getAuthToken: resolveApiAuthToken })
    : undefined;

  return {
    mode,
    apiBaseUrl: syncApiBaseUrl,
    syncApiClient: syncClient,
    readerRepository: localRepository,
    documentRepository: new RepositoryBackedReaderDocumentRepository(localRepository),
    bookAssetRepository: new IndexedDbBookAssetRepository(),
    libraryCatalogRepository: new IndexedDbLibraryCatalogRepository(),
    backupRepository: new IndexedDbBackupRepository(),
    chapterStructureRepository: new IndexedDbChapterStructureRepository(),
    personalizationRepository: new IndexedDbReaderPersonalizationRepository(),
    importService: new BrowserImportService(),
    syncService: syncClient ? new LocalOutboxSyncService(syncClient) : undefined,
    serverAttachService: syncClient
      ? new LocalBookAttachService(localRepository, new ServerUploadImportService(syncClient))
      : undefined,
  };
}

export { defaultSettings, PARAGRAPHS_PER_PAGE };
