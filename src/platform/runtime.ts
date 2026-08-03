export type PlatformRuntimeKind = 'browser' | 'tauri-desktop' | 'tauri-mobile';
export type ProviderExecutionRuntimeKind = 'server' | 'desktop' | 'none';

export interface PlatformRuntimeInfo {
  readonly kind: PlatformRuntimeKind;
  readonly hasTauri: boolean;
  readonly isMobileWebView: boolean;
  readonly userAgent: string;
}

export interface PlatformCapabilities {
  readonly appLifecycle: boolean;
  readonly hardwareBackNavigation: boolean;
  readonly mediaSession: boolean;
  readonly backgroundAudio: boolean;
  readonly wakeLock: boolean;
  readonly orientationLock: boolean;
  readonly brightnessControl: boolean;
  readonly volumeKeyNavigation: boolean;
  readonly nativeFileSave: boolean;
}

interface RuntimeWindowLike {
  readonly __TAURI__?: unknown;
  readonly __TAURI_INTERNALS__?: unknown;
  readonly navigator?: {
    readonly userAgent?: string;
    readonly platform?: string;
    readonly maxTouchPoints?: number;
    readonly mediaSession?: unknown;
    readonly wakeLock?: { readonly request?: unknown };
  };
  readonly screen?: { readonly orientation?: { readonly lock?: unknown } };
}

function runtimeHasTauri(windowLike: RuntimeWindowLike | undefined): boolean {
  return Boolean(windowLike?.__TAURI_INTERNALS__ || windowLike?.__TAURI__);
}

function runtimeLooksMobile(windowLike: RuntimeWindowLike | undefined): boolean {
  const navigator = windowLike?.navigator;
  const userAgent = navigator?.userAgent ?? '';
  const platform = navigator?.platform ?? '';
  const maxTouchPoints = navigator?.maxTouchPoints ?? 0;
  return (
    /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (platform === 'MacIntel' && maxTouchPoints > 1 && /Mobile|Safari/i.test(userAgent))
  );
}

export function detectPlatformRuntime(windowLike?: RuntimeWindowLike): PlatformRuntimeInfo {
  const target = windowLike ?? (typeof window !== 'undefined' ? (window as unknown as RuntimeWindowLike) : undefined);
  const hasTauri = runtimeHasTauri(target);
  const isMobileWebView = hasTauri && runtimeLooksMobile(target);
  return {
    kind: !hasTauri ? 'browser' : isMobileWebView ? 'tauri-mobile' : 'tauri-desktop',
    hasTauri,
    isMobileWebView,
    userAgent: target?.navigator?.userAgent ?? '',
  };
}

export function detectPlatformCapabilities(
  runtime: PlatformRuntimeInfo,
  windowLike?: RuntimeWindowLike,
): PlatformCapabilities {
  const target = windowLike ?? (typeof window !== 'undefined' ? (window as unknown as RuntimeWindowLike) : undefined);
  return {
    appLifecycle: runtime.kind === 'tauri-mobile',
    hardwareBackNavigation: runtime.kind === 'tauri-mobile',
    mediaSession: Boolean(target?.navigator?.mediaSession),
    backgroundAudio: false,
    wakeLock: typeof target?.navigator?.wakeLock?.request === 'function',
    orientationLock: typeof target?.screen?.orientation?.lock === 'function',
    brightnessControl: false,
    volumeKeyNavigation: false,
    nativeFileSave: runtime.hasTauri,
  };
}

export function resolveProviderExecutionRuntime(input: {
  readonly backendMode: 'local' | 'remote';
  readonly platformKind: PlatformRuntimeKind;
  readonly hasRemoteApiClient: boolean;
  readonly hasSyncApiClient: boolean;
}): ProviderExecutionRuntimeKind {
  if (input.hasRemoteApiClient || input.hasSyncApiClient) return 'server';
  if (
    input.backendMode === 'local' &&
    (input.platformKind === 'tauri-desktop' || input.platformKind === 'tauri-mobile')
  )
    return 'desktop';
  return 'none';
}
