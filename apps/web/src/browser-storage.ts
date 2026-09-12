export interface BrowserStorageStatus {
  usage?: number;
  quota?: number;
  persistent?: boolean;
  canRequestPersistence: boolean;
}

export async function readBrowserStorage(storage = globalThis.navigator?.storage): Promise<BrowserStorageStatus> {
  const [estimate, persistent] = await Promise.all([storage?.estimate?.(), storage?.persisted?.()]);
  return {
    usage: estimate?.usage,
    quota: estimate?.quota,
    persistent,
    canRequestPersistence: typeof storage?.persist === 'function',
  };
}

export async function requestBrowserPersistence(storage = globalThis.navigator?.storage): Promise<boolean | undefined> {
  return storage?.persist?.();
}
