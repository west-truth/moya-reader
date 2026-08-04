import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceProfile } from '@noveldesk/contracts';
import { LocalEndpointTTSProvider } from './local-endpoint-tts-provider.js';
import { createServerTTSSynthesisProvider } from './server-tts-provider-factory.js';

const voiceProfile: VoiceProfile = {
  id: 'voice_1',
  novelId: 'book_1',
  role: 'narrator',
  providerId: 'local-endpoint',
  providerVoiceId: 'narrator',
  label: 'Narrator',
  language: 'ko-KR',
  tone: 'calm',
  speed: 1,
  isUserSelected: true,
};

describe('local endpoint TTS egress policy', () => {
  it.each(['http://10.0.0.7:9010/synthesize', 'https://tts.example/synthesize'])(
    'blocks non-loopback endpoint %s unless its host is explicitly allowed',
    async (endpointUrl) => {
      const fetchImpl = vi.fn();
      const provider = new LocalEndpointTTSProvider({ endpointUrl, fetchImpl });

      await expect(provider.synthesize({ text: 'hello', voiceProfile })).rejects.toThrow(
        'Local TTS endpoint host is not permitted',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects non-http endpoint protocols before fetching', async () => {
    const fetchImpl = vi.fn();
    const provider = new LocalEndpointTTSProvider({ endpointUrl: 'file:///etc/passwd', fetchImpl });

    await expect(provider.synthesize({ text: 'hello', voiceProfile })).rejects.toThrow(
      'Local TTS endpoint must use http or https',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows loopback endpoints and disables automatic redirects', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      capturedInit = init;
      return new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize',
      fetchImpl,
    });

    await provider.synthesize({ text: 'hello', voiceProfile });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(capturedInit).toMatchObject({ redirect: 'manual' });
  });

  it('allows an exact allowlisted Docker or LAN hostname to resolve to a private address', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([7]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    const lookup = vi.fn(async () => [{ address: '10.0.0.7', family: 4 as const }]);
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://tts.internal:9010/synthesize',
      allowedHosts: ['tts.internal'],
      lookup,
      fetchImpl,
    });

    await expect(provider.synthesize({ text: 'hello', voiceProfile })).resolves.toMatchObject({
      contentType: 'audio/mpeg',
    });
    expect(lookup).toHaveBeenCalledWith('tts.internal');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('requires every DNS result for an allowlisted hostname to avoid protected address ranges', async () => {
    const fetchImpl = vi.fn();
    const lookup = vi.fn(async () => [
      { address: '10.0.0.7', family: 4 as const },
      { address: '169.254.169.254', family: 4 as const },
    ]);
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://tts.internal:9010/synthesize',
      allowedHosts: ['tts.internal'],
      lookup,
      fetchImpl,
    });

    await expect(provider.synthesize({ text: 'hello', voiceProfile })).rejects.toThrow(
      'Local TTS endpoint resolved to a prohibited address',
    );
    expect(lookup).toHaveBeenCalledWith('tts.internal');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://224.0.0.1:9010/synthesize',
    'http://0.0.0.0:9010/synthesize',
  ])('blocks protected address %s even when explicitly allowlisted', async (endpointUrl) => {
    const fetchImpl = vi.fn();
    const host = new URL(endpointUrl).hostname;
    const provider = new LocalEndpointTTSProvider({ endpointUrl, allowedHosts: [host], fetchImpl });

    await expect(provider.synthesize({ text: 'hello', voiceProfile })).rejects.toThrow(
      'Local TTS endpoint resolved to a prohibited address',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the admin host allowlist from provider environment config through the factory', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([8]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );
    const provider = createServerTTSSynthesisProvider({
      providerId: 'local-endpoint',
      env: {
        TTS_PROVIDER_ENABLED: 'local-endpoint',
        TTS_LOCAL_ENDPOINT_URL: 'http://192.168.1.50:9010/synthesize',
        LOCAL_TTS_ALLOWED_HOSTS: 'host.docker.internal, 192.168.1.50',
      },
      fetchImpl,
    });

    await expect(provider.synthesize({ text: 'hello', voiceProfile })).resolves.toMatchObject({
      contentType: 'audio/mpeg',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('pins an allowlisted hostname and does not follow redirects to a prohibited address', async () => {
    let requestCount = 0;
    let receivedHost: string | undefined;
    const server = createServer((request, response) => {
      requestCount += 1;
      receivedHost = request.headers.host;
      response.statusCode = 302;
      response.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      response.end('token=redirect-body-secret');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP test listener');
      const provider = new LocalEndpointTTSProvider({
        endpointUrl: `http://tts.internal:${address.port}/synthesize`,
        allowedHosts: ['tts.internal'],
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      const error = await provider.synthesize({ text: 'hello', voiceProfile }).catch((caught: unknown) => caught);
      const message = error instanceof Error ? error.message : String(error);

      expect(message).toBe('Local TTS endpoint request failed with status 302');
      expect(message).not.toContain('169.254.169.254');
      expect(message).not.toContain('redirect-body-secret');
      expect(requestCount).toBe(1);
      expect(receivedHost).toBe(`tts.internal:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('does not include endpoint credentials or response bodies in failures', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('token=response-secret Authorization=Bearer leaked', { status: 503 }),
    );
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize?token=url-secret',
      fetchImpl,
    });

    const error = await provider.synthesize({ text: 'hello', voiceProfile }).catch((caught: unknown) => caught);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toBe('Local TTS endpoint request failed with status 503');
    expect(message).not.toContain('url-secret');
    expect(message).not.toContain('response-secret');
    expect(message).not.toContain('Authorization');
  });

  it('removes secret-like local endpoint metadata from synthesis results', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audioBase64: Buffer.from([4, 5, 6]).toString('base64'),
            requestId: 'request-metadata-secret',
            metadata: {
              latencyMs: 12,
              diagnostic: 'request-metadata-secret',
              apiKey: 'metadata-secret',
              nested: { engine: 'local-v1', authorization: 'Bearer metadata-secret' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize?token=request-metadata-secret',
      fetchImpl,
    });

    const result = await provider.synthesize({ text: 'hello', voiceProfile });

    expect(result.providerMetadata).toEqual({
      latencyMs: 12,
      diagnostic: '[redacted]',
      nested: { engine: 'local-v1' },
    });
    expect(result.providerRequestId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('metadata-secret');
  });

  it('keeps a caught network failure as the cause without exposing it in the safe message', async () => {
    const rawError = new Error('fetch failed for http://127.0.0.1:9010/?token=network-secret');
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw rawError;
    });
    const provider = new LocalEndpointTTSProvider({
      endpointUrl: 'http://127.0.0.1:9010/synthesize?token=url-secret',
      fetchImpl,
    });

    const error = await provider.synthesize({ text: 'hello', voiceProfile }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Local TTS endpoint network request failed');
    expect((error as Error).message).not.toContain('network-secret');
    expect((error as Error).cause).toBe(rawError);
  });
});
