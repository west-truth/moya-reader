import { describe, expect, it, vi } from 'vitest';
import { DiscoverySettingsStore } from './discovery-settings-store';
import { configKey, newTab, type DiscoveryConfig } from './discovery-config';
import { normalizeDiscoveryConfig, type DiscoverySettings } from '../../integration-settings/discovery-settings';

const config = (title: string): DiscoveryConfig => ({ version: 1, tabs: [{ ...newTab(title), id: 'tab' }] });
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } as Storage;
};
function server(initial?: DiscoverySettings) {
  let document = initial;
  return {
    getDiscoverySettings: vi.fn(async () => ({ settings: structuredClone(document) })),
    saveDiscoverySettings: vi.fn(async (config: DiscoveryConfig, expectedRevision: number) => {
      if ((document?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      document = {
        config: structuredClone(config),
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      return { settings: structuredClone(document) };
    }),
  };
}

describe('account discovery configuration', () => {
  it('does not upload fresh defaults and migrates the first edited device for all devices', async () => {
    const api = server();
    const firstStorage = storage();
    const first = new DiscoverySettingsStore('account', api, firstStorage);
    await first.refresh();
    expect(api.saveDiscoverySettings).not.toHaveBeenCalled();
    const legacy = config('기존 탭');
    const secondStorage = storage();
    secondStorage.setItem(configKey('account'), JSON.stringify(legacy));
    const second = new DiscoverySettingsStore('account', api, secondStorage);
    await second.refresh();
    await first.refresh();
    expect(first.getSnapshot().config).toEqual(legacy);
    expect(second.getSnapshot().config).toEqual(legacy);
    expect(secondStorage.getItem(configKey('account'))).toBe(JSON.stringify(legacy));
    expect(api.saveDiscoverySettings).toHaveBeenCalledTimes(1);
  });

  it('shares edits and rejects stale edits, including drafts opened before a background refresh', async () => {
    const api = server({ config: config('서버'), revision: 1, updatedAt: '' });
    const a = new DiscoverySettingsStore('account', api, storage());
    const b = new DiscoverySettingsStore('account', api, storage());
    await Promise.all([a.refresh(), b.refresh()]);
    const staleDraftBase = b.getSnapshot().config;
    await a.save(config('휴대폰'));
    await expect(b.save(config('PC'))).rejects.toThrow('다른 기기');
    expect(b.getSnapshot().config.tabs[0]?.title).toBe('휴대폰');
    await expect(b.save(config('오래된 편집'), staleDraftBase)).rejects.toThrow('다른 기기');
    await b.save(config('최신 편집'));
    await a.refresh();
    expect(a.getSnapshot().config.tabs[0]?.title).toBe('최신 편집');
  });

  it('keeps one winner when two legacy devices migrate concurrently, preserving both local backups', async () => {
    const api = server();
    const sa = storage(),
      sb = storage();
    sa.setItem(configKey('same'), JSON.stringify(config('A')));
    sb.setItem(configKey('same'), JSON.stringify(config('B')));
    const a = new DiscoverySettingsStore('same', api, sa);
    const b = new DiscoverySettingsStore('same', api, sb);
    await Promise.all([a.refresh(), b.refresh()]);
    expect(a.getSnapshot().config).toEqual(b.getSnapshot().config);
    expect(JSON.parse(sb.getItem(configKey('same'))!).tabs[0].title).toBe('B');
    expect(api.saveDiscoverySettings).toHaveBeenCalledTimes(2);
  });

  it('uses cached layout offline without uploading over an unread server document; reloads ambiguous saves', async () => {
    const api = server({ config: config('서버'), revision: 1, updatedAt: '' });
    const device = storage();
    device.setItem(`${configKey('account')}:account-cache`, JSON.stringify(config('캐시')));
    api.getDiscoverySettings.mockRejectedValue(new Error('offline'));
    const store = new DiscoverySettingsStore('account', api, device);
    await store.refresh();
    expect(store.getSnapshot().config.tabs[0]?.title).toBe('캐시');
    await expect(store.save(config('로컬 수정'))).rejects.toThrow('연결');
    expect(api.saveDiscoverySettings).not.toHaveBeenCalled();
    api.getDiscoverySettings.mockResolvedValue({ settings: { config: config('서버'), revision: 1, updatedAt: '' } });
    await store.refresh();
    api.saveDiscoverySettings.mockRejectedValueOnce(new Error('response lost'));
    await expect(store.save(config('수정'))).rejects.toThrow('저장을 확인');
    expect(store.getSnapshot().saving).toBe(false);
    expect(store.getSnapshot().config.tabs[0]?.title).toBe('서버');
  });

  it('cancels detached account loads and keeps local-only mode functional', async () => {
    const api = server();
    let resolve!: (value: { settings: DiscoverySettings }) => void;
    api.getDiscoverySettings.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const device = storage();
    const store = new DiscoverySettingsStore('old-account', api, device);
    const detach = store.mount();
    detach();
    await Promise.resolve();
    resolve({ settings: { config: config('늦은 응답'), revision: 1, updatedAt: '' } });
    await store.refresh();
    expect(device.getItem(`${configKey('old-account')}:account-cache`)).toBeNull();
    const local = new DiscoverySettingsStore('local', undefined, device);
    await local.save(config('로컬'));
    expect(JSON.parse(device.getItem(configKey('local'))!).tabs[0].title).toBe('로컬');
  });

  it('roundtrips pins and grouped filters, strips transient data, and rejects duplicate/oversized input', () => {
    const input = config('고정');
    input.tabs[0]!.pinnedSourceId = 'source';
    input.tabs[0]!.sections = [
      {
        id: 'section',
        sourceId: 'source',
        title: '',
        mode: 'latest',
        filters: [
          { position: 0, value: '판타지' },
          { position: 1, groupPosition: 0, value: true },
          { position: 2, value: { index: 0, ascending: false } },
        ],
        filterSignature: 'schema',
      },
    ];
    expect(normalizeDiscoveryConfig({ ...input, query: 'secret', cache: ['cover'] })).toEqual(input);
    expect(normalizeDiscoveryConfig({ ...input, tabs: [input.tabs[0], input.tabs[0]] })).toBeUndefined();
    expect(normalizeDiscoveryConfig(config('x'.repeat(1025)))).toBeUndefined();
  });
});
