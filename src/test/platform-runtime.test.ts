import { describe, expect, it } from 'vitest';
import {
  detectPlatformCapabilities,
  detectPlatformRuntime,
  resolveProviderExecutionRuntime,
} from '../platform/runtime';

describe('platform runtime detection', () => {
  it('keeps plain browser local mode separate from app shells', () => {
    expect(
      detectPlatformRuntime({
        navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }).kind,
    ).toBe('browser');
  });

  it('enables secure local provider controls only for Tauri desktop shells', () => {
    const runtime = detectPlatformRuntime({
      __TAURI_INTERNALS__: {},
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    expect(runtime).toMatchObject({
      kind: 'tauri-desktop',
      hasTauri: true,
      isMobileWebView: false,
    });
  });

  it('recognizes the public Tauri v2 release flag', () => {
    const runtime = detectPlatformRuntime({
      isTauri: true,
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    expect(runtime).toMatchObject({
      kind: 'tauri-desktop',
      hasTauri: true,
      isMobileWebView: false,
    });
  });

  it('recognizes the packaged Tauri production origin', () => {
    const runtime = detectPlatformRuntime({
      location: { hostname: 'tauri.localhost', protocol: 'http:' },
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    expect(runtime).toMatchObject({ kind: 'tauri-desktop', hasTauri: true });
  });

  it('does not treat Android Tauri WebView as the desktop secure-store runtime', () => {
    const runtime = detectPlatformRuntime({
      __TAURI__: {},
      navigator: {
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
      },
    });

    expect(runtime).toMatchObject({
      kind: 'tauri-mobile',
      hasTauri: true,
      isMobileWebView: true,
    });
  });

  it('does not treat iPad Tauri WebView as the desktop secure-store runtime', () => {
    expect(
      detectPlatformRuntime({
        __TAURI_INTERNALS__: {},
        navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
      }).kind,
    ).toBe('tauri-mobile');
  });
});

describe('provider execution runtime selection', () => {
  it('uses the hosted server provider runtime for full remote mode', () => {
    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'remote',
        platformKind: 'browser',
        hasRemoteApiClient: true,
        hasSyncApiClient: true,
      }),
    ).toBe('server');
  });

  it('uses the connected server provider runtime for local sync mode', () => {
    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'browser',
        hasRemoteApiClient: false,
        hasSyncApiClient: true,
      }),
    ).toBe('server');

    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'tauri-mobile',
        hasRemoteApiClient: false,
        hasSyncApiClient: true,
      }),
    ).toBe('server');
  });

  it('uses native secure-store providers only when no server provider client exists', () => {
    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'tauri-desktop',
        hasRemoteApiClient: false,
        hasSyncApiClient: false,
      }),
    ).toBe('desktop');

    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'tauri-desktop',
        hasRemoteApiClient: false,
        hasSyncApiClient: true,
      }),
    ).toBe('server');
  });

  it('uses the Android secure-store provider runtime for Tauri mobile without a server', () => {
    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'tauri-mobile',
        hasRemoteApiClient: false,
        hasSyncApiClient: false,
      }),
    ).toBe('desktop');
  });

  it('does not expose direct local cloud provider controls in plain browser without a server', () => {
    expect(
      resolveProviderExecutionRuntime({
        backendMode: 'local',
        platformKind: 'browser',
        hasRemoteApiClient: false,
        hasSyncApiClient: false,
      }),
    ).toBe('none');
  });
});

describe('platform capability detection', () => {
  it('reports only capabilities exposed by the current web runtime', () => {
    const runtime = detectPlatformRuntime({ navigator: { userAgent: 'Browser' } });
    expect(
      detectPlatformCapabilities(runtime, {
        navigator: {
          userAgent: 'Browser',
          mediaSession: {},
          wakeLock: { request: () => undefined },
        },
        screen: { orientation: { lock: () => undefined } },
      }),
    ).toEqual({
      appLifecycle: false,
      hardwareBackNavigation: false,
      mediaSession: true,
      backgroundAudio: false,
      wakeLock: true,
      orientationLock: true,
      brightnessControl: false,
      volumeKeyNavigation: false,
      nativeFileSave: false,
    });
  });

  it('keeps native-only controls disabled until an adapter implements them', () => {
    const runtime = detectPlatformRuntime({
      __TAURI_INTERNALS__: {},
      navigator: { userAgent: 'Windows' },
    });
    expect(detectPlatformCapabilities(runtime, { navigator: { userAgent: 'Windows' } })).toMatchObject({
      appLifecycle: false,
      hardwareBackNavigation: false,
      backgroundAudio: false,
      brightnessControl: false,
      volumeKeyNavigation: false,
      nativeFileSave: true,
    });
  });

  it('exposes lifecycle and hardware-back boundaries for the Android shell', () => {
    const runtime = detectPlatformRuntime({
      __TAURI_INTERNALS__: {},
      navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) Mobile' },
    });

    expect(detectPlatformCapabilities(runtime, { navigator: { userAgent: 'Android' } })).toMatchObject({
      appLifecycle: true,
      hardwareBackNavigation: true,
    });
  });
});
