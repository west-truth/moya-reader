import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTextServerEndpoint, TextServerClient, textServerNamespace } from './text-server-client';
import { TextServerRequestError } from './text-server-errors';

afterEach(() => vi.useRealTimers());
const namespace = textServerNamespace({ instanceId: 'server', dataNamespace: 'data' });
const headers = { 'Content-Type': 'text/plain;charset=utf-8', 'X-Moya-Source-Namespace': namespace };

describe('TextServerClient', () => {
  it('keeps exact UTF-8 bytes and a revision, with direct credentials isolated to the selected endpoint', async () => {
    const bytes = new TextEncoder().encode('\ufeff제목\r\n\u00a0 문단  \n');
    const fetchImpl = vi.fn(async () => new Response(bytes, { headers: { ...headers, ETag: '"r1"' } }));
    const client = new TextServerClient({
      endpoint: 'https://text.test',
      token: 'secret',
      fetchImpl,
      expectedNamespace: namespace,
    });
    const result = await client.content('/v1/content', new AbortController().signal);
    expect(result.bytes).toEqual(bytes);
    expect(result.revision).toBe('"r1"');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://text.test/v1/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer secret' },
        credentials: 'omit',
        redirect: 'error',
      }),
    );
  });

  it.each([
    [401, 'authentication_required', '텍스트 서버 연결 키'],
    [502, 'content_provider_authentication_required', '제공자 연결 키'],
    [403, 'source_access_required', '회차 이용 권한'],
    [409, 'source_verification_required', '확인 절차'],
    [503, 'content_provider_not_configured', '제공자 설정'],
    [503, 'text_source_server_not_configured', '서버 관리자'],
    [504, 'content_provider_request_timeout', '시간이 초과'],
    [503, 'content_provider_busy', '잠시 기다린'],
    [502, 'content_provider_invalid_manifest', '올바른 회차 원문'],
    [404, 'not_found', '목록을 새로고침'],
  ])('gives a local action for HTTP %s / %s without exposing server diagnostics', async (status, code, action) => {
    const response = new Response(JSON.stringify({ error: code, detail: 'secret cookie and private provider body' }), {
      status: Number(status),
      headers: { 'Content-Type': 'application/json' },
    });
    const client = new TextServerClient({ endpoint: 'https://text.test', fetchImpl: vi.fn(async () => response) });
    const error = await client.content('/v1/content', new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TextServerRequestError);
    expect((error as Error).message).toContain(action);
    expect((error as Error).message).not.toContain('secret');
  });

  it('distinguishes a managed app session failure from a downstream provider authentication failure', async () => {
    const managedFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'content_provider_authentication_required' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new TextServerClient({ endpoint: 'managed', managedFetch });
    await expect(client.json('/v1/health', new AbortController().signal)).rejects.toThrow('모야 로그인');
    await expect(client.content('/v1/content', new AbortController().signal)).rejects.toThrow('제공자 연결 키');
  });

  it.each([null, '', '\ufeff \r\n\u00a0 '])(
    'rejects a missing or blank successful TXT body before import',
    async (body) => {
      const client = new TextServerClient({
        endpoint: 'https://text.test',
        fetchImpl: vi.fn(async () => new Response(body, { headers })),
      });
      await expect(client.content('/v1/content', new AbortController().signal)).rejects.toThrow('회차 본문');
    },
  );

  it.each(['declared', 'streamed'])(
    'bounds a %s error body to 8 KiB and cancels it without using a partial code',
    async (mode) => {
      const cancel = vi.fn();
      const body = new TextEncoder().encode(
        JSON.stringify({ error: 'source_access_required', detail: 'secret'.repeat(2000) }),
      );
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(body);
        },
        cancel,
      });
      const response = new Response(stream, {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          ...(mode === 'declared' ? { 'Content-Length': String(body.byteLength) } : {}),
        },
      });
      const client = new TextServerClient({ endpoint: 'https://text.test', fetchImpl: vi.fn(async () => response) });
      await expect(client.content('/v1/content', new AbortController().signal)).rejects.toThrow(
        '요청을 완료하지 못했습니다',
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, textServerNamespace({ instanceId: 'other', dataNamespace: 'data' })])(
    'rejects missing or changed namespace without reading source bytes',
    async (value) => {
      const cancel = vi.fn();
      const stream = new ReadableStream({ cancel });
      const client = new TextServerClient({
        endpoint: 'https://text.test',
        expectedNamespace: namespace,
        fetchImpl: vi.fn(
          async () =>
            new Response(stream, {
              headers: { 'Content-Type': 'text/plain', ...(value ? { 'X-Moya-Source-Namespace': value } : {}) },
            }),
        ),
      });
      await expect(client.content('/v1/content', new AbortController().signal)).rejects.toThrow('범위');
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('stops an oversized streamed body even when Content-Length is absent', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const client = new TextServerClient({
      endpoint: 'https://text.test',
      fetchImpl: vi.fn(async () => new Response(stream, { headers })),
    });
    await expect(client.content('/v1/content', new AbortController().signal)).rejects.toThrow('크기 한도');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['abort', 200],
    ['idle', 200],
    ['abort', 502],
    ['idle', 502],
  ] as const)('cancels a stalled reader on %s with HTTP %s', async (reason, status) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    const client = new TextServerClient({
      endpoint: 'https://text.test',
      readTimeoutMs: 20,
      fetchImpl: vi.fn(
        async () =>
          new Response(stream, { status, headers: status === 200 ? headers : { 'Content-Type': 'application/json' } }),
      ),
    });
    const abort = new AbortController();
    const pending = client.content('/v1/content', abort.signal);
    const rejected =
      reason === 'idle'
        ? expect(pending).rejects.toThrow('시간')
        : expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'abort') abort.abort();
    else await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards error bodies and unsafe response types without exposing provider messages', async () => {
    for (const response of [
      new Response('cookie=secret private-body', { status: 500 }),
      new Response('<html>login secret</html>', { headers: { 'Content-Type': 'text/html' } }),
    ]) {
      const client = new TextServerClient({ endpoint: 'https://text.test', fetchImpl: vi.fn(async () => response) });
      await expect(client.content('/v1/content', new AbortController().signal)).rejects.not.toThrow('secret');
    }
    expect(normalizeTextServerEndpoint('http://127.0.0.1:4567/')).toBe('http://127.0.0.1:4567');
    for (const endpoint of [
      'https://user:secret@text.test',
      'http://public.test',
      'file:///tmp/file',
      'https://text.test?token=secret',
    ]) {
      expect(() => normalizeTextServerEndpoint(endpoint)).toThrow();
    }
  });
});
