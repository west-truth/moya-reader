export const MOYA_APP_SHELL_CACHE_PREFIX = 'moya-app-shell-';

export interface WebAppServiceWorkerRegistration {
  unregister(): Promise<boolean>;
}

export interface ClearWebAppRuntimeStateInput {
  readonly registrations: readonly WebAppServiceWorkerRegistration[];
  readonly cacheNames: readonly string[];
  readonly deleteCache: (cacheName: string) => Promise<boolean>;
  readonly deleteAllCaches?: boolean;
}

export interface ClearWebAppRuntimeStateResult {
  readonly unregisteredCount: number;
  readonly deletedCacheNames: readonly string[];
}

export async function clearWebAppRuntimeState(
  input: ClearWebAppRuntimeStateInput,
): Promise<ClearWebAppRuntimeStateResult> {
  const cacheNames = input.deleteAllCaches
    ? [...input.cacheNames]
    : input.cacheNames.filter((cacheName) => cacheName.startsWith(MOYA_APP_SHELL_CACHE_PREFIX));
  const [unregistered, deleted] = await Promise.all([
    Promise.all(input.registrations.map((registration) => registration.unregister())),
    Promise.all(cacheNames.map((cacheName) => input.deleteCache(cacheName))),
  ]);
  return {
    unregisteredCount: unregistered.filter(Boolean).length,
    deletedCacheNames: cacheNames.filter((_, index) => deleted[index]),
  };
}
