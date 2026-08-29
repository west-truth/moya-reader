import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultFileProvider,
  type CloudVaultProviderKind,
  type CloudVaultSyncReport,
  type CloudVaultSyncScope,
} from '../../cloud-vault/contracts';
import {
  CLOUD_VAULT_MIN_PASSPHRASE_LENGTH,
  sealCloudVaultSecret,
  unsealCloudVaultSecret,
} from '../../cloud-vault/crypto';
import {
  DirectoryCloudVaultProvider,
  directoryPickerAvailable,
  ensureDirectoryPermission,
  pickCloudVaultDirectory,
} from '../../cloud-vault/directory-provider';
import { connectDropboxWithDesktopBrowser, connectDropboxWithPopup } from '../../cloud-vault/dropbox-oauth';
import {
  DropboxCloudVaultProvider,
  fetchDropboxAccountLabel,
  type DropboxCredential,
  type DropboxCredentialStore,
} from '../../cloud-vault/dropbox-provider';
import { IndexedDbCloudVaultArtifactRepository } from '../../cloud-vault/indexeddb-artifact-repository';
import { CloudVaultLocalStateStore, type CloudVaultLocalConfig } from '../../cloud-vault/local-state';
import { CloudVaultService } from '../../cloud-vault/service';
import { CloudVaultContentTransferService } from '../../cloud-vault/content-transfer';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { ImportService } from '../../services/import/import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';
import {
  cloudVaultUsesNativeSecureStore,
  deleteNativeCloudVaultDropboxCredential,
  deleteNativeCloudVaultPassphrase,
  getNativeCloudVaultDropboxCredential,
  getNativeCloudVaultPassphrase,
  saveNativeCloudVaultDropboxCredential,
  saveNativeCloudVaultPassphrase,
} from '../../platform/secure-credentials';
import { detectPlatformRuntime } from '../../platform/runtime';
import {
  CLOUD_VAULT_MUTATION_KINDS,
  cloudVaultMutationDelay,
  cloudVaultMutationEnabled,
  initialCloudVaultMutationRevisions,
  type CloudVaultMutationKind,
  type CloudVaultMutationRevisions,
} from '../../cloud-vault/sync-policy';

type CloudVaultActivity = 'idle' | 'loading' | 'connecting' | 'syncing' | 'disconnecting';

export interface CloudVaultController {
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly activity: CloudVaultActivity;
  readonly config?: CloudVaultLocalConfig;
  readonly providerKind?: CloudVaultProviderKind;
  readonly providerLabel?: string;
  readonly connected: boolean;
  readonly passphrase: string;
  readonly unlocked: boolean;
  readonly directoryAvailable: boolean;
  readonly dropboxAvailable: boolean;
  readonly dropboxSetupHint?: string;
  readonly backupOnly: boolean;
  readonly lastReport?: CloudVaultSyncReport;
  readonly setPassphrase: (value: string) => void;
  readonly setRememberPassphrase: (enabled: boolean) => Promise<void>;
  readonly setAutoSync: (enabled: boolean) => Promise<void>;
  readonly setScope: (key: keyof Omit<CloudVaultSyncScope, 'ttsAudio'>, enabled: boolean) => Promise<void>;
  readonly selectDirectory: () => Promise<void>;
  readonly connectDropbox: () => Promise<void>;
  readonly syncNow: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

interface UseCloudVaultControllerOptions {
  readonly repository: ReaderRepository;
  readonly assets?: BookAssetRepository;
  readonly importService: ImportService;
  readonly catalog?: LibraryCatalogRepository;
  readonly personalization?: ReaderPersonalizationRepository;
  readonly deviceId: string;
  readonly serverSyncConnected: boolean;
  readonly refreshLibrary: () => Promise<void>;
  readonly notify: (message: string, tone?: ToastTone) => void;
  readonly confirm: (message: string) => boolean;
  readonly dropboxAppKey?: string;
  readonly localMutationRevisions?: CloudVaultMutationRevisions;
}

export function cloudVaultErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : '';
  if (name === 'AbortError') return '';
  if (!message.trim()) return 'Cloud Vault 작업을 완료하지 못했습니다.';
  const normalized = message.toLowerCase();
  if (normalized.includes('passphrase')) return '암호가 틀렸거나 Vault 파일을 열 수 없습니다.';
  if (normalized.includes('permission')) return '선택한 폴더의 읽기·쓰기 권한이 필요합니다.';
  return message.trim();
}

function isPassphraseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('passphrase') || message.includes('unlock');
}

function parseDropboxCredential(value: string): DropboxCredential {
  try {
    const parsed = JSON.parse(value) as Partial<DropboxCredential>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken.trim()) throw new Error();
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : undefined,
    };
  } catch {
    throw new Error('Stored Dropbox connection is invalid. Connect Dropbox again.');
  }
}

export function useCloudVaultController(options: UseCloudVaultControllerOptions): CloudVaultController {
  const {
    repository,
    assets,
    importService,
    catalog,
    personalization,
    deviceId,
    serverSyncConnected,
    refreshLibrary,
    notify,
    confirm,
    dropboxAppKey: configuredDropboxAppKey,
    localMutationRevisions = initialCloudVaultMutationRevisions(),
  } = options;
  const available = repository.capabilities.backend === 'indexeddb';
  const stateStore = useMemo(() => new CloudVaultLocalStateStore(), []);
  const service = useMemo(
    () =>
      new CloudVaultService(
        new IndexedDbCloudVaultArtifactRepository(repository, catalog, personalization),
        assets ? new CloudVaultContentTransferService(repository, assets, importService) : undefined,
      ),
    [assets, catalog, importService, personalization, repository],
  );
  const [config, setConfig] = useState<CloudVaultLocalConfig>();
  const [passphrase, setPassphraseDraft] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [activity, setActivity] = useState<CloudVaultActivity>(available ? 'loading' : 'idle');
  const [lastReport, setLastReport] = useState<CloudVaultSyncReport>();
  const configRef = useRef<CloudVaultLocalConfig>();
  const passphraseRef = useRef('');
  const busyRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const runSyncRef = useRef<
    (automatic: boolean, reason?: 'startup' | 'local' | 'remote' | 'background') => Promise<void>
  >(async () => undefined);
  const startupAutoSyncDoneRef = useRef(false);
  const seenMutationRevisionsRef = useRef(localMutationRevisions);
  const latestMutationRevisionsRef = useRef(localMutationRevisions);
  latestMutationRevisionsRef.current = localMutationRevisions;
  const dirtyMutationKindsRef = useRef(new Set<CloudVaultMutationKind>());
  const dirtySinceRef = useRef<number>();
  const syncPendingRef = useRef(false);
  const platformRuntime = detectPlatformRuntime();
  const nativeSecureCredentials = cloudVaultUsesNativeSecureStore();
  const dropboxAppKey = configuredDropboxAppKey?.trim();

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      try {
        const value = await stateStore.getConfig();
        let rememberedPassphrase: string | undefined;
        if (value.providerKind && value.rememberPassphrase) {
          try {
            if (nativeSecureCredentials) {
              rememberedPassphrase = await getNativeCloudVaultPassphrase();
              if (!rememberedPassphrase) {
                rememberedPassphrase = await stateStore.getRememberedPassphrase();
                if (rememberedPassphrase) {
                  await saveNativeCloudVaultPassphrase(rememberedPassphrase);
                  await stateStore.clearRememberedPassphrase();
                }
              }
            } else {
              rememberedPassphrase = await stateStore.getRememberedPassphrase();
            }
          } catch {
            await stateStore.clearRememberedPassphrase().catch(() => undefined);
            if (nativeSecureCredentials) await deleteNativeCloudVaultPassphrase().catch(() => undefined);
            if (!cancelled) notify('저장된 Vault 암호를 복구하지 못했습니다. 다시 입력하세요.', 'warning');
          }
        }
        if (cancelled) return;
        configRef.current = value;
        setConfig(value);
        if (rememberedPassphrase && rememberedPassphrase.length >= CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
          passphraseRef.current = rememberedPassphrase;
          setUnlocked(true);
        }
      } catch (error) {
        if (!cancelled) notify(cloudVaultErrorMessage(error), 'danger');
      } finally {
        if (!cancelled) setActivity('idle');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available, nativeSecureCredentials, notify, stateStore]);

  const saveConfig = useCallback(
    async (patch: Partial<Omit<CloudVaultLocalConfig, 'id'>>) => {
      const next = await stateStore.saveConfig(patch);
      configRef.current = next;
      setConfig(next);
      return next;
    },
    [stateStore],
  );

  const setPassphrase = useCallback((value: string) => {
    passphraseRef.current = value;
    setPassphraseDraft(value);
    setUnlocked(false);
  }, []);

  const rememberPassphraseOnDevice = useCallback(
    async (value: string, shouldRemember: boolean) => {
      passphraseRef.current = value;
      setPassphraseDraft('');
      setUnlocked(true);
      if (nativeSecureCredentials) {
        if (shouldRemember) await saveNativeCloudVaultPassphrase(value);
        else await deleteNativeCloudVaultPassphrase();
        await stateStore.clearRememberedPassphrase();
      } else if (shouldRemember) {
        await stateStore.saveRememberedPassphrase(value);
      } else {
        await stateStore.clearRememberedPassphrase();
      }
    },
    [nativeSecureCredentials, stateStore],
  );

  const setRememberPassphrase = useCallback(
    async (enabled: boolean) => {
      await saveConfig({ rememberPassphrase: enabled });
      if (!enabled) {
        await stateStore.clearRememberedPassphrase();
        if (nativeSecureCredentials) await deleteNativeCloudVaultPassphrase();
      } else if (passphraseRef.current.length >= CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
        if (nativeSecureCredentials) {
          await saveNativeCloudVaultPassphrase(passphraseRef.current);
          await stateStore.clearRememberedPassphrase();
        } else {
          await stateStore.saveRememberedPassphrase(passphraseRef.current);
        }
      }
    },
    [nativeSecureCredentials, saveConfig, stateStore],
  );

  const setAutoSync = useCallback(
    async (enabled: boolean) => {
      await saveConfig({ autoSync: enabled });
      if (enabled) startupAutoSyncDoneRef.current = false;
    },
    [saveConfig],
  );

  const setScope = useCallback(
    async (key: keyof Omit<CloudVaultSyncScope, 'ttsAudio'>, enabled: boolean) => {
      const scope: CloudVaultSyncScope = {
        ...(config?.scope ?? DEFAULT_CLOUD_VAULT_SCOPE),
        [key]: enabled,
        ttsAudio: false,
      };
      await saveConfig({ scope });
    },
    [config?.scope, saveConfig],
  );

  const selectDirectory = useCallback(async () => {
    if (!available || activity !== 'idle' || busyRef.current) return;
    busyRef.current = true;
    setActivity('connecting');
    try {
      const handle = await pickCloudVaultDirectory();
      if (!(await ensureDirectoryPermission(handle, true)))
        throw new Error('Cloud vault folder permission was denied.');
      await stateStore.saveDirectoryHandle(handle);
      const nextConfig = await saveConfig({
        providerKind: 'directory',
        directoryName: handle.name,
        dropboxCredentialEnvelope: undefined,
        dropboxAccountLabel: undefined,
        lastSyncAt: undefined,
        lastSyncProviderKind: undefined,
        lastRemoteRevision: undefined,
        lastUploadedBytes: undefined,
        lastError: undefined,
        waitingBookTitles: [],
        aiTtsObjectKeys: {},
      });
      if (passphraseRef.current.length >= CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
        await rememberPassphraseOnDevice(passphraseRef.current, nextConfig.rememberPassphrase).catch(() => {
          notify('Vault 암호는 현재 실행 중에만 유지됩니다.', 'warning');
        });
      }
      startupAutoSyncDoneRef.current = false;
      setLastReport(undefined);
      notify('Cloud Vault 동기화 폴더를 연결했습니다.', 'success');
    } catch (error) {
      const message = cloudVaultErrorMessage(error);
      if (message) notify(message, 'danger');
    } finally {
      busyRef.current = false;
      setActivity('idle');
    }
  }, [activity, available, notify, rememberPassphraseOnDevice, saveConfig, stateStore]);

  const connectDropbox = useCallback(async () => {
    if (!available || activity !== 'idle' || busyRef.current) return;
    if (platformRuntime.kind === 'tauri-mobile') {
      notify('Android Dropbox 연결은 Custom Tab과 앱 링크 adapter가 준비된 뒤 사용할 수 있습니다.', 'warning');
      return;
    }
    if (!dropboxAppKey) {
      notify('이 빌드에는 Dropbox 앱 키가 설정되지 않았습니다.', 'warning');
      return;
    }
    const currentPassphrase = passphraseRef.current;
    if (currentPassphrase.length < CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
      notify(`Dropbox 연결 전에 ${CLOUD_VAULT_MIN_PASSPHRASE_LENGTH}자 이상의 Vault 암호를 입력하세요.`, 'warning');
      return;
    }
    busyRef.current = true;
    setActivity('connecting');
    try {
      const connect =
        platformRuntime.kind === 'tauri-desktop' ? connectDropboxWithDesktopBrowser : connectDropboxWithPopup;
      const credential = await connect({
        appKey: dropboxAppKey,
        scopes: [
          'account_info.read',
          'files.content.read',
          'files.content.write',
          'files.metadata.read',
          'files.metadata.write',
        ],
      });
      const [envelope, accountLabel] = await Promise.all([
        nativeSecureCredentials
          ? saveNativeCloudVaultDropboxCredential(JSON.stringify(credential)).then(() => undefined)
          : sealCloudVaultSecret(credential, currentPassphrase),
        fetchDropboxAccountLabel(credential).catch(() => undefined),
      ]);
      await stateStore.clearDirectoryHandle();
      const nextConfig = await saveConfig({
        providerKind: 'dropbox',
        directoryName: undefined,
        dropboxCredentialEnvelope: envelope,
        dropboxAccountLabel: accountLabel,
        lastSyncAt: undefined,
        lastSyncProviderKind: undefined,
        lastRemoteRevision: undefined,
        lastUploadedBytes: undefined,
        lastError: undefined,
        waitingBookTitles: [],
        aiTtsObjectKeys: {},
      });
      await rememberPassphraseOnDevice(currentPassphrase, nextConfig.rememberPassphrase).catch(() => {
        notify('Dropbox는 연결했지만 Vault 암호는 현재 실행 중에만 유지됩니다.', 'warning');
      });
      startupAutoSyncDoneRef.current = false;
      setLastReport(undefined);
      notify('Dropbox App Folder를 연결했습니다.', 'success');
    } catch (error) {
      const message = cloudVaultErrorMessage(error);
      if (message) notify(message, 'danger');
    } finally {
      busyRef.current = false;
      setActivity('idle');
    }
  }, [
    activity,
    available,
    dropboxAppKey,
    nativeSecureCredentials,
    notify,
    platformRuntime.kind,
    rememberPassphraseOnDevice,
    saveConfig,
    stateStore,
  ]);

  const createProvider = useCallback(
    async (currentConfig: CloudVaultLocalConfig, currentPassphrase: string) => {
      if (currentConfig.providerKind === 'directory') {
        const handle = await stateStore.getDirectoryHandle();
        if (!handle) throw new Error('동기화 폴더 연결 정보가 없습니다. 폴더를 다시 선택하세요.');
        if (!(await ensureDirectoryPermission(handle, true)))
          throw new Error('Cloud vault folder permission was denied.');
        return new DirectoryCloudVaultProvider(handle);
      }
      if (currentConfig.providerKind === 'dropbox') {
        if (!dropboxAppKey) throw new Error('이 빌드에는 Dropbox 앱 키가 설정되지 않았습니다.');
        let credential: DropboxCredential;
        if (nativeSecureCredentials) {
          const nativeCredential = await getNativeCloudVaultDropboxCredential();
          if (nativeCredential) {
            credential = parseDropboxCredential(nativeCredential);
          } else if (currentConfig.dropboxCredentialEnvelope) {
            credential = await unsealCloudVaultSecret<DropboxCredential>(
              currentConfig.dropboxCredentialEnvelope,
              currentPassphrase,
            );
            await saveNativeCloudVaultDropboxCredential(JSON.stringify(credential));
            await saveConfig({ dropboxCredentialEnvelope: undefined });
          } else {
            throw new Error('이 기기의 보안 저장소에 Dropbox 연결 정보가 없습니다. 다시 연결하세요.');
          }
        } else {
          if (!currentConfig.dropboxCredentialEnvelope)
            throw new Error('Dropbox 연결 정보가 없습니다. 다시 연결하세요.');
          credential = await unsealCloudVaultSecret<DropboxCredential>(
            currentConfig.dropboxCredentialEnvelope,
            currentPassphrase,
          );
        }
        const credentialStore: DropboxCredentialStore = {
          get: async () => credential,
          save: async (next) => {
            credential = next;
            if (nativeSecureCredentials) {
              await saveNativeCloudVaultDropboxCredential(JSON.stringify(next));
            } else {
              const envelope = await sealCloudVaultSecret(next, currentPassphrase);
              await saveConfig({ dropboxCredentialEnvelope: envelope });
            }
          },
        };
        return new DropboxCloudVaultProvider(dropboxAppKey, credentialStore);
      }
      throw new Error('먼저 Cloud Vault 저장 위치를 연결하세요.');
    },
    [dropboxAppKey, nativeSecureCredentials, saveConfig, stateStore],
  );

  const runSync = useCallback(
    async (automatic: boolean, reason: 'startup' | 'local' | 'remote' | 'background' = 'local') => {
      if (!available) return;
      if (syncInFlightRef.current) {
        if (automatic && (reason === 'local' || reason === 'background' || dirtyMutationKindsRef.current.size > 0)) {
          syncPendingRef.current = true;
        }
        return;
      }
      if (busyRef.current) return;
      const currentConfig = configRef.current;
      if (!currentConfig?.providerKind) {
        if (!automatic) notify('먼저 Cloud Vault 저장 위치를 연결하세요.', 'warning');
        return;
      }
      if (automatic && !currentConfig.autoSync) return;
      const currentPassphrase = passphraseRef.current;
      if (currentPassphrase.length < CLOUD_VAULT_MIN_PASSPHRASE_LENGTH) {
        if (!automatic) notify(`${CLOUD_VAULT_MIN_PASSPHRASE_LENGTH}자 이상의 Vault 암호를 입력하세요.`, 'warning');
        return;
      }
      syncInFlightRef.current = true;
      busyRef.current = true;
      setActivity('syncing');
      const startedMutationRevisions = latestMutationRevisionsRef.current;
      try {
        const provider: CloudVaultFileProvider = await createProvider(currentConfig, currentPassphrase);
        if (
          automatic &&
          reason === 'remote' &&
          dirtyMutationKindsRef.current.size === 0 &&
          currentConfig.lastRemoteRevision &&
          provider.getRevision
        ) {
          const revision = await provider.getRevision();
          if (revision === currentConfig.lastRemoteRevision) {
            await saveConfig({ lastSyncAt: new Date().toISOString(), lastError: undefined });
            return;
          }
        }
        const report = await service.sync({
          provider,
          passphrase: currentPassphrase,
          deviceId,
          scope: currentConfig.scope,
          backupOnly: serverSyncConnected,
          knownAiTtsObjectKeys: currentConfig.aiTtsObjectKeys ?? {},
        });
        setLastReport(report);
        await saveConfig({
          lastSyncAt: report.syncedAt,
          lastSyncProviderKind: provider.kind,
          lastRemoteRevision: report.remoteRevision,
          lastUploadedBytes: report.uploadedBytes || currentConfig.lastUploadedBytes,
          lastError: undefined,
          waitingBookTitles: report.waitingBookTitles,
          aiTtsObjectKeys: report.aiTtsObjectKeys,
        });
        for (const kind of CLOUD_VAULT_MUTATION_KINDS) {
          // A failed immutable sidecar upload must remain retryable. The
          // manifest can still be committed with its prior descriptor.
          if ((kind === 'content' || kind === 'aiTts') && report.contentFailures.length > 0) continue;
          if (latestMutationRevisionsRef.current[kind] <= startedMutationRevisions[kind]) {
            dirtyMutationKindsRef.current.delete(kind);
          }
        }
        if (dirtyMutationKindsRef.current.size === 0) dirtySinceRef.current = undefined;
        if (!unlocked) {
          await rememberPassphraseOnDevice(currentPassphrase, currentConfig.rememberPassphrase).catch(() => {
            notify('Vault 암호는 현재 실행 중에만 유지됩니다.', 'warning');
          });
        }
        if (!serverSyncConnected) await refreshLibrary();
        const message =
          report.contentFailures.length > 0
            ? `Vault 기록은 동기화했지만 작품 파일 ${report.contentFailures.length}개를 처리하지 못했습니다.`
            : report.waitingForSourceBooks > 0
              ? currentConfig.scope.sourceFiles
                ? `동기화했습니다. 클라우드 원본이 없는 ${report.waitingForSourceBooks}개 작품은 연결 대기로 남겼습니다.`
                : `동기화했습니다. 같은 원문을 가져오면 ${report.waitingForSourceBooks}개 작품의 기록을 연결할 수 있습니다.`
              : serverSyncConnected
                ? '암호화된 Cloud Vault 백업을 갱신했습니다.'
                : report.restoredSourceFiles > 0
                  ? `Cloud Vault 동기화를 완료하고 작품 ${report.restoredSourceFiles}개를 복원했습니다.`
                  : 'Cloud Vault 동기화를 완료했습니다.';
        const hasWarning = report.contentFailures.length > 0 || report.waitingForSourceBooks > 0;
        if (!automatic || hasWarning || report.restoredSourceFiles > 0) {
          notify(message, hasWarning ? 'warning' : 'success');
        }
      } catch (error) {
        const message = cloudVaultErrorMessage(error) || 'Cloud Vault 동기화에 실패했습니다.';
        await saveConfig({ lastError: message }).catch(() => undefined);
        if (isPassphraseError(error)) {
          passphraseRef.current = '';
          setPassphraseDraft('');
          setUnlocked(false);
          await stateStore.clearRememberedPassphrase().catch(() => undefined);
          if (nativeSecureCredentials) await deleteNativeCloudVaultPassphrase().catch(() => undefined);
        }
        notify(message, 'danger');
      } finally {
        syncInFlightRef.current = false;
        busyRef.current = false;
        setActivity('idle');
        const changedDuringSync = CLOUD_VAULT_MUTATION_KINDS.some(
          (kind) => latestMutationRevisionsRef.current[kind] > startedMutationRevisions[kind],
        );
        if (syncPendingRef.current || changedDuringSync) {
          syncPendingRef.current = false;
          window.setTimeout(() => void runSyncRef.current(true, 'local'), 0);
        }
      }
    },
    [
      available,
      createProvider,
      deviceId,
      notify,
      refreshLibrary,
      rememberPassphraseOnDevice,
      saveConfig,
      serverSyncConnected,
      service,
      stateStore,
      unlocked,
      nativeSecureCredentials,
    ],
  );

  useEffect(() => {
    runSyncRef.current = runSync;
  }, [runSync]);

  useEffect(() => {
    if (
      startupAutoSyncDoneRef.current ||
      activity !== 'idle' ||
      !config?.providerKind ||
      !config.autoSync ||
      !unlocked
    ) {
      return;
    }
    startupAutoSyncDoneRef.current = true;
    // A full startup sync is intentional: an earlier browser shutdown may have
    // happened before the in-memory dirty marker could be flushed.
    void runSyncRef.current(true, 'startup');
  }, [activity, config?.autoSync, config?.providerKind, unlocked]);

  useEffect(() => {
    if (!available) return;
    const syncWhenActive = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void runSyncRef.current(true, 'remote');
    };
    const syncBeforeBackground = () => {
      if (document.visibilityState === 'hidden' && dirtyMutationKindsRef.current.size > 0) {
        void runSyncRef.current(true, 'background');
      } else if (document.visibilityState === 'visible') {
        syncWhenActive();
      }
    };
    window.addEventListener('online', syncWhenActive);
    window.addEventListener('focus', syncWhenActive);
    document.addEventListener('visibilitychange', syncBeforeBackground);
    const probe = window.setInterval(syncWhenActive, 2 * 60_000);
    return () => {
      window.removeEventListener('online', syncWhenActive);
      window.removeEventListener('focus', syncWhenActive);
      document.removeEventListener('visibilitychange', syncBeforeBackground);
      window.clearInterval(probe);
    };
  }, [available]);

  useEffect(() => {
    const previous = seenMutationRevisionsRef.current;
    seenMutationRevisionsRef.current = localMutationRevisions;
    const scope = config?.scope;
    if (scope) {
      for (const kind of CLOUD_VAULT_MUTATION_KINDS) {
        if (localMutationRevisions[kind] > previous[kind] && cloudVaultMutationEnabled(kind, scope)) {
          dirtyMutationKindsRef.current.add(kind);
          dirtySinceRef.current ??= Date.now();
        }
      }
    }
    if (!config?.providerKind || !config.autoSync || !unlocked || dirtyMutationKindsRef.current.size === 0) return;
    const dirtyForMs = dirtySinceRef.current === undefined ? 0 : Date.now() - dirtySinceRef.current;
    const delay = cloudVaultMutationDelay(dirtyMutationKindsRef.current, dirtyForMs);
    if (delay === undefined) return;
    const timeout = window.setTimeout(() => void runSyncRef.current(true, 'local'), delay);
    return () => window.clearTimeout(timeout);
  }, [config?.autoSync, config?.providerKind, config?.scope, localMutationRevisions, unlocked]);

  const syncNow = useCallback(async () => runSync(false, 'local'), [runSync]);

  const disconnect = useCallback(async () => {
    if (!available || activity !== 'idle' || !config?.providerKind || busyRef.current) return;
    if (!confirm('이 기기에서 Cloud Vault 연결을 해제할까요? 클라우드의 암호화 파일은 삭제하지 않습니다.')) {
      return;
    }
    busyRef.current = true;
    setActivity('disconnecting');
    try {
      await stateStore.clearDirectoryHandle();
      if (nativeSecureCredentials) await deleteNativeCloudVaultDropboxCredential();
      await saveConfig({
        providerKind: undefined,
        directoryName: undefined,
        dropboxCredentialEnvelope: undefined,
        dropboxAccountLabel: undefined,
        lastSyncAt: undefined,
        lastSyncProviderKind: undefined,
        lastRemoteRevision: undefined,
        lastUploadedBytes: undefined,
        lastError: undefined,
        waitingBookTitles: [],
        aiTtsObjectKeys: {},
      });
      await stateStore.clearRememberedPassphrase();
      if (nativeSecureCredentials) await deleteNativeCloudVaultPassphrase();
      passphraseRef.current = '';
      setPassphrase('');
      setUnlocked(false);
      startupAutoSyncDoneRef.current = false;
      setLastReport(undefined);
      notify('이 기기의 Cloud Vault 연결을 해제했습니다.', 'success');
    } catch (error) {
      notify(cloudVaultErrorMessage(error), 'danger');
    } finally {
      busyRef.current = false;
      setActivity('idle');
    }
  }, [
    activity,
    available,
    config?.providerKind,
    confirm,
    notify,
    nativeSecureCredentials,
    saveConfig,
    setPassphrase,
    stateStore,
  ]);

  const providerLabel =
    config?.providerKind === 'directory'
      ? config.directoryName || '동기화 폴더'
      : config?.providerKind === 'dropbox'
        ? config.dropboxAccountLabel || 'Dropbox'
        : undefined;

  return {
    available,
    unavailableReason: available ? undefined : '호스팅 서버 모드에서는 서버 동기화를 사용합니다.',
    activity,
    config,
    providerKind: config?.providerKind,
    providerLabel,
    connected: Boolean(config?.providerKind),
    passphrase,
    unlocked,
    directoryAvailable: directoryPickerAvailable(),
    dropboxAvailable: Boolean(dropboxAppKey) && platformRuntime.kind !== 'tauri-mobile',
    dropboxSetupHint:
      platformRuntime.kind === 'tauri-mobile'
        ? 'Android Dropbox 연결은 Custom Tab과 검증된 앱 링크 adapter가 준비되기 전까지 비활성화됩니다.'
        : dropboxAppKey
          ? undefined
          : '배포의 공개 Dropbox 앱 키 설정이 필요합니다.',
    backupOnly: serverSyncConnected,
    lastReport,
    setPassphrase,
    setRememberPassphrase,
    setAutoSync,
    setScope,
    selectDirectory,
    connectDropbox,
    syncNow,
    disconnect,
  };
}
