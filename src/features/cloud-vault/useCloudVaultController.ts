import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultProviderKind,
  type CloudVaultSyncReport,
  type CloudVaultSyncScope,
} from '../../cloud-vault/contracts';
import { sealCloudVaultSecret, unsealCloudVaultSecret } from '../../cloud-vault/crypto';
import {
  DirectoryCloudVaultProvider,
  directoryPickerAvailable,
  ensureDirectoryPermission,
  pickCloudVaultDirectory,
} from '../../cloud-vault/directory-provider';
import { connectDropboxWithPopup } from '../../cloud-vault/dropbox-oauth';
import {
  DropboxCloudVaultProvider,
  fetchDropboxAccountLabel,
  type DropboxCredential,
  type DropboxCredentialStore,
} from '../../cloud-vault/dropbox-provider';
import { IndexedDbCloudVaultArtifactRepository } from '../../cloud-vault/indexeddb-artifact-repository';
import { CloudVaultLocalStateStore, type CloudVaultLocalConfig } from '../../cloud-vault/local-state';
import { CloudVaultService } from '../../cloud-vault/service';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import type { ToastTone } from '../../shared/ui/ToastHost';
import {
  apiAuthTokenUsesAndroidKeystore,
  deleteAndroidCloudVaultDropboxCredential,
  getAndroidCloudVaultDropboxCredential,
  saveAndroidCloudVaultDropboxCredential,
} from '../../platform/secure-credentials';

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
  readonly directoryAvailable: boolean;
  readonly dropboxAvailable: boolean;
  readonly dropboxSetupHint?: string;
  readonly backupOnly: boolean;
  readonly lastReport?: CloudVaultSyncReport;
  readonly setPassphrase: (value: string) => void;
  readonly setScope: (key: keyof Omit<CloudVaultSyncScope, 'ttsAudio'>, enabled: boolean) => Promise<void>;
  readonly selectDirectory: () => Promise<void>;
  readonly connectDropbox: () => Promise<void>;
  readonly syncNow: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

interface UseCloudVaultControllerOptions {
  readonly repository: ReaderRepository;
  readonly catalog?: LibraryCatalogRepository;
  readonly personalization?: ReaderPersonalizationRepository;
  readonly deviceId: string;
  readonly serverSyncConnected: boolean;
  readonly refreshLibrary: () => Promise<void>;
  readonly notify: (message: string, tone?: ToastTone) => void;
  readonly confirm: (message: string) => boolean;
  readonly dropboxAppKey?: string;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Cloud Vault 작업을 완료하지 못했습니다.';
  if (error.name === 'AbortError') return '';
  if (error.message.includes('passphrase')) return '암호가 틀렸거나 Vault 파일을 열 수 없습니다.';
  if (error.message.includes('permission')) return '선택한 폴더의 읽기·쓰기 권한이 필요합니다.';
  return error.message;
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
    catalog,
    personalization,
    deviceId,
    serverSyncConnected,
    refreshLibrary,
    notify,
    confirm,
    dropboxAppKey: configuredDropboxAppKey,
  } = options;
  const available = repository.capabilities.backend === 'indexeddb';
  const stateStore = useMemo(() => new CloudVaultLocalStateStore(), []);
  const service = useMemo(
    () => new CloudVaultService(new IndexedDbCloudVaultArtifactRepository(repository, catalog, personalization)),
    [catalog, personalization, repository],
  );
  const [config, setConfig] = useState<CloudVaultLocalConfig>();
  const [passphrase, setPassphrase] = useState('');
  const [activity, setActivity] = useState<CloudVaultActivity>(available ? 'loading' : 'idle');
  const [lastReport, setLastReport] = useState<CloudVaultSyncReport>();
  const androidSecureCredentials = apiAuthTokenUsesAndroidKeystore();
  const dropboxAppKey =
    configuredDropboxAppKey?.trim() || (import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined)?.trim();

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void stateStore
      .getConfig()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((error) => {
        if (!cancelled) notify(errorMessage(error), 'danger');
      })
      .finally(() => {
        if (!cancelled) setActivity('idle');
      });
    return () => {
      cancelled = true;
    };
  }, [available, notify, stateStore]);

  const saveConfig = useCallback(
    async (patch: Partial<Omit<CloudVaultLocalConfig, 'id'>>) => {
      const next = await stateStore.saveConfig(patch);
      setConfig(next);
      return next;
    },
    [stateStore],
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
    if (!available || activity !== 'idle') return;
    setActivity('connecting');
    try {
      const handle = await pickCloudVaultDirectory();
      if (!(await ensureDirectoryPermission(handle, true)))
        throw new Error('Cloud vault folder permission was denied.');
      await stateStore.saveDirectoryHandle(handle);
      await saveConfig({
        providerKind: 'directory',
        directoryName: handle.name,
        dropboxCredentialEnvelope: undefined,
        dropboxAccountLabel: undefined,
        lastError: undefined,
        waitingBookTitles: [],
      });
      notify('Cloud Vault 동기화 폴더를 연결했습니다.', 'success');
    } catch (error) {
      const message = errorMessage(error);
      if (message) notify(message, 'danger');
    } finally {
      setActivity('idle');
    }
  }, [activity, available, notify, saveConfig, stateStore]);

  const connectDropbox = useCallback(async () => {
    if (!available || activity !== 'idle') return;
    if (androidSecureCredentials) {
      notify('Android Dropbox 연결은 Custom Tab과 앱 링크 adapter가 준비된 뒤 사용할 수 있습니다.', 'warning');
      return;
    }
    if (!dropboxAppKey) {
      notify('이 빌드에는 Dropbox 앱 키가 설정되지 않았습니다.', 'warning');
      return;
    }
    if (passphrase.length < 12) {
      notify('Dropbox 연결 전에 12자 이상의 Vault 암호를 입력하세요.', 'warning');
      return;
    }
    setActivity('connecting');
    try {
      const credential = await connectDropboxWithPopup({ appKey: dropboxAppKey });
      const [envelope, accountLabel] = await Promise.all([
        sealCloudVaultSecret(credential, passphrase),
        fetchDropboxAccountLabel(credential),
      ]);
      await stateStore.clearDirectoryHandle();
      await saveConfig({
        providerKind: 'dropbox',
        directoryName: undefined,
        dropboxCredentialEnvelope: envelope,
        dropboxAccountLabel: accountLabel,
        lastError: undefined,
        waitingBookTitles: [],
      });
      notify('Dropbox App Folder를 연결했습니다.', 'success');
    } catch (error) {
      const message = errorMessage(error);
      if (message) notify(message, 'danger');
    } finally {
      setActivity('idle');
    }
  }, [activity, androidSecureCredentials, available, dropboxAppKey, notify, passphrase, saveConfig, stateStore]);

  const createProvider = useCallback(async () => {
    if (config?.providerKind === 'directory') {
      const handle = await stateStore.getDirectoryHandle();
      if (!handle) throw new Error('동기화 폴더 연결 정보가 없습니다. 폴더를 다시 선택하세요.');
      if (!(await ensureDirectoryPermission(handle, true)))
        throw new Error('Cloud vault folder permission was denied.');
      return new DirectoryCloudVaultProvider(handle);
    }
    if (config?.providerKind === 'dropbox') {
      if (!dropboxAppKey) throw new Error('이 빌드에는 Dropbox 앱 키가 설정되지 않았습니다.');
      let credential: DropboxCredential;
      if (androidSecureCredentials) {
        const nativeCredential = await getAndroidCloudVaultDropboxCredential();
        if (nativeCredential) {
          credential = parseDropboxCredential(nativeCredential);
        } else if (config.dropboxCredentialEnvelope) {
          credential = await unsealCloudVaultSecret<DropboxCredential>(config.dropboxCredentialEnvelope, passphrase);
          await saveAndroidCloudVaultDropboxCredential(JSON.stringify(credential));
          await saveConfig({ dropboxCredentialEnvelope: undefined });
        } else {
          throw new Error('Android 보안 저장소에 Dropbox 연결 정보가 없습니다. 다시 연결하세요.');
        }
      } else {
        if (!config.dropboxCredentialEnvelope) throw new Error('Dropbox 연결 정보가 없습니다. 다시 연결하세요.');
        credential = await unsealCloudVaultSecret<DropboxCredential>(config.dropboxCredentialEnvelope, passphrase);
      }
      const credentialStore: DropboxCredentialStore = {
        get: async () => credential,
        save: async (next) => {
          credential = next;
          if (androidSecureCredentials) {
            await saveAndroidCloudVaultDropboxCredential(JSON.stringify(next));
          } else {
            const envelope = await sealCloudVaultSecret(next, passphrase);
            await saveConfig({ dropboxCredentialEnvelope: envelope });
          }
        },
      };
      return new DropboxCloudVaultProvider(dropboxAppKey, credentialStore);
    }
    throw new Error('먼저 Cloud Vault 저장 위치를 연결하세요.');
  }, [androidSecureCredentials, config, dropboxAppKey, passphrase, saveConfig, stateStore]);

  const syncNow = useCallback(async () => {
    if (!available || activity !== 'idle') return;
    if (!config?.providerKind) {
      notify('먼저 Cloud Vault 저장 위치를 연결하세요.', 'warning');
      return;
    }
    if (passphrase.length < 12) {
      notify('12자 이상의 Vault 암호를 입력하세요.', 'warning');
      return;
    }
    setActivity('syncing');
    try {
      const provider = await createProvider();
      const report = await service.sync({
        provider,
        passphrase,
        deviceId,
        scope: config.scope,
        backupOnly: serverSyncConnected,
      });
      setLastReport(report);
      await saveConfig({
        lastSyncAt: report.syncedAt,
        lastRemoteRevision: report.remoteRevision,
        lastUploadedBytes: report.uploadedBytes,
        lastError: undefined,
        waitingBookTitles: report.waitingBookTitles,
      });
      if (!serverSyncConnected) await refreshLibrary();
      notify(
        report.waitingForSourceBooks > 0
          ? `동기화했습니다. 같은 원문을 가져오면 ${report.waitingForSourceBooks}개 작품의 기록을 연결할 수 있습니다.`
          : serverSyncConnected
            ? '암호화된 Cloud Vault 백업을 갱신했습니다.'
            : 'Cloud Vault 동기화를 완료했습니다.',
        report.waitingForSourceBooks > 0 ? 'warning' : 'success',
      );
    } catch (error) {
      const message = errorMessage(error) || 'Cloud Vault 동기화에 실패했습니다.';
      await saveConfig({ lastError: message }).catch(() => undefined);
      notify(message, 'danger');
    } finally {
      setActivity('idle');
    }
  }, [
    activity,
    available,
    config,
    createProvider,
    deviceId,
    notify,
    passphrase,
    refreshLibrary,
    saveConfig,
    serverSyncConnected,
    service,
  ]);

  const disconnect = useCallback(async () => {
    if (!available || activity !== 'idle' || !config?.providerKind) return;
    if (!confirm('이 기기에서 Cloud Vault 연결을 해제할까요? 클라우드의 암호화 파일은 삭제하지 않습니다.')) {
      return;
    }
    setActivity('disconnecting');
    try {
      await stateStore.clearDirectoryHandle();
      if (androidSecureCredentials) await deleteAndroidCloudVaultDropboxCredential();
      await saveConfig({
        providerKind: undefined,
        directoryName: undefined,
        dropboxCredentialEnvelope: undefined,
        dropboxAccountLabel: undefined,
        lastError: undefined,
        waitingBookTitles: [],
      });
      setPassphrase('');
      setLastReport(undefined);
      notify('이 기기의 Cloud Vault 연결을 해제했습니다.', 'success');
    } catch (error) {
      notify(errorMessage(error), 'danger');
    } finally {
      setActivity('idle');
    }
  }, [activity, androidSecureCredentials, available, config?.providerKind, confirm, notify, saveConfig, stateStore]);

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
    directoryAvailable: directoryPickerAvailable(),
    dropboxAvailable: Boolean(dropboxAppKey) && !androidSecureCredentials,
    dropboxSetupHint: androidSecureCredentials
      ? 'Android Dropbox 연결은 Custom Tab과 검증된 앱 링크 adapter가 준비되기 전까지 비활성화됩니다.'
      : dropboxAppKey
        ? undefined
        : '배포 빌드에 VITE_DROPBOX_APP_KEY 설정이 필요합니다.',
    backupOnly: serverSyncConnected,
    lastReport,
    setPassphrase,
    setScope,
    selectDirectory,
    connectDropbox,
    syncNow,
    disconnect,
  };
}
