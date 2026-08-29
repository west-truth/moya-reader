import { describe, expect, it } from 'vitest';
import { resolveSelfHostedWebNovelMetadataCollectorEndpoint } from './webnovel-metadata-collector';

describe('self-hosted webnovel metadata collector endpoint', () => {
  it('derives the gateway from the existing API base instead of a proxy-specific hostname', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: '/api',
        browserOrigin: 'https://moya.example',
      }),
    ).toBe('https://moya.example/api/integrations/webnovel-metadata');

    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://reader.example/custom-api/',
        browserOrigin: 'https://reader.example',
      }),
    ).toBe('https://reader.example/custom-api/integrations/webnovel-metadata');
  });

  it('keeps local browser builds on the explicit external companion mode', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'local',
        apiBaseUrl: '/api',
        browserOrigin: 'http://127.0.0.1:1421',
      }),
    ).toBeUndefined();
  });

  it('rejects malformed or credential-bearing API bases', () => {
    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://user:password@reader.example/api',
        browserOrigin: 'https://reader.example',
      }),
    ).toBeUndefined();

    expect(
      resolveSelfHostedWebNovelMetadataCollectorEndpoint({
        backendMode: 'remote',
        apiBaseUrl: 'https://reader-api.example/api',
        browserOrigin: 'https://reader.example',
      }),
    ).toBeUndefined();
  });
});
