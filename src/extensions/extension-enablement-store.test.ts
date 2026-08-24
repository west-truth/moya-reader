import { describe, expect, it } from 'vitest';
import {
  EXTENSION_ENABLEMENT_SCHEMA_VERSION,
  EXTENSION_ENABLEMENT_STORAGE_KEY,
  ExtensionEnablementStore,
  type ExtensionEnablementStorage,
} from './extension-enablement-store';

class MemoryStorage implements ExtensionEnablementStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('ExtensionEnablementStore', () => {
  it('uses each bundled registration default until the user stores an override', () => {
    const store = new ExtensionEnablementStore(new MemoryStorage());

    expect(store.isEnabled('moya.reader.tools', true)).toBe(true);
    expect(store.isEnabled('moya.optional.tool', false)).toBe(false);
    expect(store.getSnapshot()).toEqual({
      schemaVersion: EXTENSION_ENABLEMENT_SCHEMA_VERSION,
      enabledByExtensionId: {},
    });
  });

  it('persists explicit enablement in a versioned device-local document', () => {
    const storage = new MemoryStorage();
    const first = new ExtensionEnablementStore(storage);

    first.setEnabled('moya.reader.tools', false);
    first.setEnabled('moya.ai.tts', true);

    expect(JSON.parse(storage.values.get(EXTENSION_ENABLEMENT_STORAGE_KEY)!)).toEqual({
      schemaVersion: 1,
      enabledByExtensionId: {
        'moya.reader.tools': false,
        'moya.ai.tts': true,
      },
    });
    const restored = new ExtensionEnablementStore(storage);
    expect(restored.isEnabled('moya.reader.tools', true)).toBe(false);
    expect(restored.isEnabled('moya.ai.tts', false)).toBe(true);
  });

  it.each([
    '{broken json',
    JSON.stringify({ schemaVersion: 2, enabledByExtensionId: { 'moya.reader.tools': false } }),
    JSON.stringify({ schemaVersion: 1, enabledByExtensionId: [] }),
    JSON.stringify({ schemaVersion: 1, enabledByExtensionId: { 'moya.reader.tools': 'no' } }),
    JSON.stringify({ schemaVersion: 1, enabledByExtensionId: { 'invalid id': false } }),
    JSON.stringify({ schemaVersion: 1, enabledByExtensionId: { constructor: false } }),
  ])('fails safely to registration defaults for damaged state: %s', (raw) => {
    const storage = new MemoryStorage();
    storage.values.set(EXTENSION_ENABLEMENT_STORAGE_KEY, raw);
    const store = new ExtensionEnablementStore(storage);

    expect(store.isEnabled('moya.reader.tools', true)).toBe(true);
    expect(store.isEnabled('moya.optional.tool', false)).toBe(false);
    expect(store.getSnapshot().enabledByExtensionId).toEqual({});
  });

  it('keeps explicit choices in memory when localStorage is unavailable', () => {
    const store = new ExtensionEnablementStore(null);

    expect(store.isEnabled('moya.reader.tools', true)).toBe(true);
    expect(() => store.setEnabled('moya.reader.tools', false)).not.toThrow();
    expect(store.isEnabled('moya.reader.tools', true)).toBe(false);
  });

  it('falls back without throwing when localStorage access fails', () => {
    const unavailable: ExtensionEnablementStorage = {
      getItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const store = new ExtensionEnablementStore(unavailable);

    expect(store.isEnabled('moya.ai.tts', false)).toBe(false);
    expect(() => store.setEnabled('moya.ai.tts', true)).not.toThrow();
    expect(store.isEnabled('moya.ai.tts', false)).toBe(true);
  });

  it('rejects invalid ids instead of persisting an unusable override', () => {
    const storage = new MemoryStorage();
    const store = new ExtensionEnablementStore(storage);

    expect(() => store.setEnabled('not an extension', false)).toThrow('Invalid extension id');
    expect(storage.values.has(EXTENSION_ENABLEMENT_STORAGE_KEY)).toBe(false);
  });
});
