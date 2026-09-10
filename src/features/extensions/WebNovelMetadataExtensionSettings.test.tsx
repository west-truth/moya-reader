import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebNovelMetadataCollectorBroker } from '../../services/webnovel-metadata-collector-broker';
import { WebNovelMetadataExtensionSettings } from './WebNovelMetadataExtensionSettings';

describe('WebNovelMetadataExtensionSettings', () => {
  it.each([false, true])(
    'keeps platform-specific controls compatible with public search capability: %s',
    (publicSearch) => {
      const snapshot = {
        revision: 1,
        connectionState: 'connected' as const,
        settings: {
          endpoint: 'https://collector.example',
          includeAdult: false,
          automaticLookup: false,
          automaticApply: 'off' as const,
        },
        health: {
          status: 'ok' as const,
          service: 'webnovel-metadata-collector' as const,
          version: '1.0.0',
          apiVersion: 1 as const,
          capabilities: {
            resolve: { version: 1 as const },
            batchResolve: { version: 1 as const, maxItems: 50 },
            coverRef: {
              version: 1 as const,
              path: '/api/v1/covers/{cover_ref}' as const,
              ttlSeconds: 900,
              maxBytes: 10 * 1024 * 1024,
              contentTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
            },
            adultAuth: {
              version: 1 as const,
              available: true,
              browserPresentation: 'local_window' as const,
              platforms: ['naver_series', 'kakao_page', 'novelpia', 'ridi'] as const,
              directLoginPlatforms: ['novelpia'] as const,
              publicSearchPlatforms: publicSearch ? (['kakao_page', 'ridi'] as const) : undefined,
            },
          },
        },
        auth: {
          available: true,
          browserRunning: false,
          browserPresentation: 'local_window' as const,
          enabledPlatforms: [],
          rememberedCredentialPlatforms: [],
        },
      };
      const broker = {
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        updateSettings: vi.fn(),
        resetSettings: vi.fn(() => snapshot.settings),
        connect: vi.fn(),
        openAuthBrowser: vi.fn(),
        setAuthPlatformEnabled: vi.fn(),
        configureNovelpiaCredentials: vi.fn(),
        configureNovelpiaLoginKey: vi.fn(),
        closeAuthBrowser: vi.fn(),
        clearAuthSession: vi.fn(),
        refreshAuthStatus: vi.fn(),
      } as unknown as WebNovelMetadataCollectorBroker;
      const markup = renderToStaticMarkup(
        <WebNovelMetadataExtensionSettings
          broker={broker}
          extensionEnabled
          libraryCount={12}
          confirm={() => true}
          automation={{
            progress: { state: 'idle', total: 0, completed: 0, matched: 0, applied: 0, failed: 0, skipped: 0 },
            busy: false,
            runLibraryBatch: vi.fn(async () => undefined),
            cancel: vi.fn(),
          }}
        />,
      );

      expect(markup).toContain('웹소설 정보 수집기');
      expect(markup).toContain('새로 가져온 작품 자동 검색');
      expect(markup).toContain('새 작품에도 자동 적용');
      expect(markup).toContain('재배포·상업적 이용 권리는 확인되지');
      expect(markup).toContain('전체 라이브러리 자동 채우기');
      expect(markup).toContain('부족한 정보 자동 채우기');
      expect(markup).toContain('19세 검색 결과 포함');
      expect(markup).toContain('노벨피아');
      expect(markup).toContain('로그인 설정');
      expect(markup).toContain('로그인 완료·사용');
      expect(markup).toContain('로그인 연결을 서버에 보관');
      expect(markup).toContain('검색할 작품 제목과 작가명이 전송됩니다.');
      expect(markup.match(/로그인 완료·사용/g)).toHaveLength(publicSearch ? 1 : 3);
      if (publicSearch) {
        expect(markup).toContain('카카오페이지 19세 검색 사용');
        expect(markup).toContain('리디 19세 검색 사용');
        expect(markup.match(/로그인 없이 작품 정보 검색/g)).toHaveLength(2);
      }
    },
  );

  it('hides endpoint configuration for the bundled desktop collector', () => {
    const snapshot = {
      revision: 1,
      connectionState: 'connected' as const,
      settings: {
        endpoint: 'http://127.0.0.1:8000',
        includeAdult: false,
        automaticLookup: false,
        automaticApply: 'off' as const,
      },
    };
    const broker = {
      connectionMode: 'managed' as const,
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      connect: vi.fn(),
      updateSettings: vi.fn(),
    } as unknown as WebNovelMetadataCollectorBroker;

    const markup = renderToStaticMarkup(
      <WebNovelMetadataExtensionSettings
        broker={broker}
        extensionEnabled
        libraryCount={0}
        confirm={() => true}
        automation={{
          progress: { state: 'idle', total: 0, completed: 0, matched: 0, applied: 0, failed: 0, skipped: 0 },
          busy: false,
          runLibraryBatch: vi.fn(async () => undefined),
          cancel: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain('내장 정보 수집기');
    expect(markup).toContain('다시 연결');
    expect(markup).not.toContain('도우미 주소');
    expect(markup).not.toContain('127.0.0.1:8000');
  });

  it('uses a single login action for the managed self-host remote browser', () => {
    const snapshot = {
      revision: 1,
      connectionState: 'connected' as const,
      settings: {
        endpoint: 'https://moya.example/api/integrations/webnovel-metadata',
        includeAdult: false,
        automaticLookup: false,
        automaticApply: 'off' as const,
      },
      health: {
        status: 'ok' as const,
        service: 'webnovel-metadata-collector' as const,
        version: '0.1.0',
        apiVersion: 1 as const,
        capabilities: {
          resolve: { version: 1 as const },
          batchResolve: { version: 1 as const, maxItems: 50 },
          coverRef: {
            version: 1 as const,
            path: '/api/v1/covers/{cover_ref}' as const,
            ttlSeconds: 900,
            maxBytes: 10 * 1024 * 1024,
            contentTypes: ['image/jpeg'] as const,
          },
          adultAuth: {
            version: 1 as const,
            available: true,
            browserPresentation: 'remote_frame' as const,
            platforms: ['naver_series'] as const,
          },
        },
      },
      auth: {
        available: true,
        browserRunning: false,
        browserPresentation: 'remote_frame' as const,
        enabledPlatforms: [],
      },
    };
    const broker = {
      connectionMode: 'managed' as const,
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      updateSettings: vi.fn(),
      connect: vi.fn(),
      openAuthBrowser: vi.fn(),
      setAuthPlatformEnabled: vi.fn(),
      closeAuthBrowser: vi.fn(),
      clearAuthSession: vi.fn(),
      refreshAuthStatus: vi.fn(),
    } as unknown as WebNovelMetadataCollectorBroker;

    const markup = renderToStaticMarkup(
      <WebNovelMetadataExtensionSettings
        broker={broker}
        extensionEnabled
        libraryCount={0}
        confirm={() => true}
        automation={{
          progress: { state: 'idle', total: 0, completed: 0, matched: 0, applied: 0, failed: 0, skipped: 0 },
          busy: false,
          runLibraryBatch: vi.fn(async () => undefined),
          cancel: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain('로그인 연결을 서버에 보관');
    expect(markup).toContain('네이버 시리즈');
    expect(markup).not.toContain('로그인 완료·사용');
    expect(markup).not.toContain('도우미 주소');
  });
});
