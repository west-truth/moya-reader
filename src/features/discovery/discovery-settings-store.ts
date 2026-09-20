import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import {
  normalizeDiscoveryConfig,
  type DiscoveryConfig,
  type DiscoverySettings,
} from '../../integration-settings/discovery-settings';
import { configKey, emptyConfig } from './discovery-config';

type Client = Pick<RemoteApiClient, 'getDiscoverySettings' | 'saveDiscoverySettings'>;
const conflict = '다른 기기에서 탐색 구성이 변경됐습니다. 최신 구성을 확인한 뒤 다시 편집해 주세요.';
const read = (storage: Storage, key: string) => {
  try {
    return normalizeDiscoveryConfig(JSON.parse(storage.getItem(key) ?? 'null'));
  } catch {
    return;
  }
};

export class DiscoverySettingsStore {
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private mounted = 0;
  private revision = 0;
  private loading?: Promise<void>;
  private legacy?: DiscoveryConfig;
  private readonly key: string;
  private snapshot: { config: DiscoveryConfig; ready: boolean; saving: boolean; error: string };

  constructor(
    scope: string,
    private readonly client?: Client,
    private readonly storage: Storage = localStorage,
  ) {
    this.key = configKey(scope);
    this.legacy = read(storage, this.key);
    this.snapshot = {
      config: (client && read(storage, `${this.key}:account-cache`)) || this.legacy || emptyConfig(),
      ready: !client,
      saving: false,
      error: '',
    };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    if (this.lifetime.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private signal() {
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]);
  }
  private accept(settings: DiscoverySettings) {
    const config = normalizeDiscoveryConfig(settings.config);
    if (!config || !Number.isSafeInteger(settings.revision) || settings.revision < 1)
      throw new Error('invalid discovery settings');
    if (this.lifetime.signal.aborted) return;
    const changed = !this.snapshot.ready || this.revision !== settings.revision;
    this.revision = settings.revision;
    this.legacy = undefined;
    try {
      this.storage.setItem(`${this.key}:account-cache`, JSON.stringify(config));
    } catch {
      /* Server save remains authoritative. */
    }
    this.publish({ ...(changed ? { config } : {}), ready: true, error: '' });
  }
  private load(): Promise<void> {
    if (!this.client || this.lifetime.signal.aborted) return Promise.resolve();
    if (this.loading) return this.loading;
    const client = this.client;
    this.loading = (async () => {
      try {
        const { settings } = await client.getDiscoverySettings(this.signal());
        if (this.lifetime.signal.aborted) return;
        if (settings) this.accept(settings);
        else if (this.legacy) {
          try {
            const result = await client.saveDiscoverySettings(this.legacy, 0, this.signal());
            this.accept(result.settings);
          } catch (error) {
            if ((error as { status?: number })?.status !== 409) throw error;
            const winner = await client.getDiscoverySettings(this.signal());
            if (!winner.settings) throw error;
            this.accept(winner.settings);
          }
        } else {
          this.revision = 0;
          this.publish({ ready: true, error: '' });
        }
      } catch {
        this.publish({ error: '탐색 구성을 동기화하지 못했습니다. 다시 시도해 주세요.' });
      }
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  refresh = () => (this.snapshot.saving ? Promise.resolve() : this.load());
  mount() {
    this.mounted++;
    void this.refresh();
    return () => {
      this.mounted--;
      // React StrictMode replays setup before this microtask.
      queueMicrotask(() => {
        if (!this.mounted) this.lifetime.abort();
      });
    };
  }
  save = async (next: DiscoveryConfig, base: DiscoveryConfig = this.snapshot.config) => {
    if (this.snapshot.saving) throw new Error('저장 중입니다. 잠시 후 다시 시도해 주세요.');
    const config = normalizeDiscoveryConfig(next);
    if (!config) throw new Error('탐색 구성의 크기나 항목을 확인해 주세요.');
    this.publish({ saving: true });
    try {
      if (this.loading) await this.loading;
      if (!this.snapshot.ready) await this.load();
      this.lifetime.signal.throwIfAborted();
      if (!this.snapshot.ready) throw new Error('서버에 연결한 뒤 다시 저장해 주세요.');
      if (JSON.stringify(base) !== JSON.stringify(this.snapshot.config)) throw new Error(conflict);
      if (!this.client) {
        this.storage.setItem(this.key, JSON.stringify(config));
        this.publish({ config, error: '' });
      } else {
        try {
          this.accept((await this.client.saveDiscoverySettings(config, this.revision, this.signal())).settings);
          this.lifetime.signal.throwIfAborted();
        } catch (error) {
          // A lost response may still have committed. Read before permitting another write.
          this.publish({ ready: false });
          await this.load();
          if ((error as { status?: number })?.status === 409)
            throw Object.assign(new Error(conflict), { cause: error });
          throw Object.assign(new Error('저장을 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.'), {
            cause: error,
          });
        }
      }
    } finally {
      this.publish({ saving: false });
    }
  };
}
