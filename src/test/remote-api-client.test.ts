import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mapServerProviderJob,
  mapServerSyncEvent,
  mapServerTTSCacheItem,
  mapServerVoiceProfile,
  RemoteApiClient,
  RemoteApiRequestTimeoutError,
} from '../services/remote/remote-api-client';
import { RemoteApiError } from '../services/remote/remote-api-contracts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RemoteApiClient auth headers', () => {
  it('requires a trash-inclusive response on every page before using a catalog for link cleanup', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ books: [{ id: 'active' }], nextCursor: '1000', includesTrash: true }))
      .mockResolvedValueOnce(
        jsonResponse({ books: [{ id: 'trashed', deleted_at: '2026-08-31' }], includesTrash: true }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');
    expect((await client.listBooks({ includeTrash: true })).books).toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/books?includeTrash=true', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/books?limit=1000&cursor=1000&includeTrash=true',
      expect.any(Object),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ books: [] }));
    await expect(client.listBooks({ includeTrash: true })).rejects.toThrow('서버를 업데이트');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies the hosted account boundary when a protected request loses its session', async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })),
    );
    const client = new RemoteApiClient('/api', { onUnauthorized: unauthorized });

    await expect(client.listBooks()).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it('exposes a server JSON error as a readable message while preserving its payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'book metadata revision changed', actualRevision: 'revision-3' }), {
            status: 409,
          }),
      ),
    );
    const client = new RemoteApiClient('/api');

    const failure = await client.listBooks().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RemoteApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'book metadata revision changed',
      payload: { error: 'book metadata revision changed', actualRevision: 'revision-3' },
    });
  });

  it('adds a bearer token from the auth token provider', async () => {
    let token = 'first-token';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ books: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api', { getAuthToken: () => token });

    await client.listBooks();
    token = 'second-token';
    await client.listBooks();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/books',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer first-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/books',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer second-token' }),
      }),
    );
  });

  it('omits Authorization when no token is available', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ books: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api', { getAuthToken: () => '' });

    await client.listBooks();

    const init = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('reads hosted cover metadata from the cover response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Blob(['jpeg'], { type: 'image/jpeg' }), {
            status: 200,
            headers: {
              'Content-Type': 'image/jpeg',
              'Content-Length': '4',
              'X-Asset-Id': 'cover_archive',
              'X-Asset-Provenance': 'archive_embedded',
              'X-Asset-Status': 'active',
              'X-Asset-File-Name': 'cover%20page.jpg',
              'X-Asset-Content-Hash': 'sha256:archive',
              'X-Asset-Pixel-Width': '800',
              'X-Asset-Pixel-Height': '1200',
              'X-Asset-Created-At': '2026-08-30T00:00:00.000Z',
            },
          }),
      ),
    );
    const client = new RemoteApiClient('/api');

    await expect(client.getBookCover('book-1')).resolves.toMatchObject({
      metadata: {
        id: 'cover_archive',
        book_id: 'book-1',
        provenance: 'archive_embedded',
        file_name: 'cover page.jpg',
        content_hash: 'sha256:archive',
        pixel_width: 800,
        pixel_height: 1200,
      },
    });
  });

  it('continues through every hosted library page and rejects a repeated cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ books: [{ id: 'book-1' }], nextCursor: '1000' }))
      .mockResolvedValueOnce(jsonResponse({ books: [{ id: 'book-2' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.listBooks()).resolves.toEqual({ books: [{ id: 'book-1' }, { id: 'book-2' }] });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/books', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/books?limit=1000&cursor=1000', expect.any(Object));

    fetchMock
      .mockReset()
      .mockResolvedValueOnce(jsonResponse({ books: [], nextCursor: '1000' }))
      .mockResolvedValueOnce(jsonResponse({ books: [], nextCursor: '1000' }));
    await expect(client.listBooks()).rejects.toThrow('repeated a library cursor');
  });

  it('does not set a JSON content type on the bodyless upload completion request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ jobId: 'job_1', statusUrl: '/api/import-jobs/job_1' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api', { getAuthToken: () => 'reader-token' });

    await expect(client.completeUpload('upload_1')).resolves.toEqual({
      jobId: 'job_1',
      statusUrl: '/api/import-jobs/job_1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/uploads/upload_1/complete',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer reader-token' });
  });

  it('keeps the JSON content type when a JSON request body is present', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ uploadId: 'upload_1', chunkUrlTemplate: '/api/uploads/upload_1/chunks/{chunkIndex}' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await client.initUpload({
      fileName: 'novel.txt',
      sizeBytes: 12,
      contentType: 'text/plain',
      encoding: 'utf-8',
      totalChunks: 1,
    });

    const init = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(
      JSON.stringify({
        fileName: 'novel.txt',
        sizeBytes: 12,
        contentType: 'text/plain',
        encoding: 'utf-8',
        totalChunks: 1,
      }),
    );
  });

  it('uses a dedicated non-fallback endpoint for approved enrichment covers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        cover: { id: 'approved-cover' },
        previousCover: null,
        metadataRevision: 4,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');
    const blob = new Blob(['png'], { type: 'image/png' });

    await client.saveApprovedEnrichmentBookCover('book-1', blob, {
      fileName: 'cover.png',
      contentType: 'image/png',
      contentHash: 'sha256:cover',
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'contain',
      positionX: 50,
      positionY: 50,
      expectedMetadataRevision: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book-1/cover/approved-enrichment',
      expect.objectContaining({
        method: 'PUT',
        body: blob,
        headers: expect.objectContaining({ 'X-Expected-Metadata-Revision': '3' }),
      }),
    );
  });

  it('retries capability discovery after a transient failure instead of caching the rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          contractVersion: 1,
          idContract: 'v1-legacy',
          hashContract: 'v1-legacy',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.getSyncCapabilities()).rejects.toMatchObject({ status: 503 });
    await expect(client.getSyncCapabilities()).resolves.toMatchObject({ contractVersion: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts and classifies a request that never returns response headers', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api', { requestTimeoutMs: 5 });

    await expect(client.listBooks()).rejects.toBeInstanceOf(RemoteApiRequestTimeoutError);
  });

  it('maps server sync revision metadata when present', () => {
    expect(
      mapServerSyncEvent({
        id: 'event-1',
        type: 'reading_position_updated',
        device_id: 'device-a',
        book_id: 'book-1',
        entity_id: 'reading_position_book-1',
        payload: { position: { chapterId: 'chapter-1' } },
        revision: {
          entityType: 'reading_position',
          entityId: 'reading_position_book-1',
          novelId: 'book-1',
          localSequence: 3,
          updatedAt: '2026-07-05T00:00:00.000Z',
          payloadHash: 'hash-position',
        },
        created_at: '2026-07-05T00:00:00.000Z',
      }),
    ).toMatchObject({
      id: 'event-1',
      revision: {
        entityType: 'reading_position',
        entityId: 'reading_position_book-1',
        localSequence: 3,
        payloadHash: 'hash-position',
      },
    });
  });

  it('maps and writes hosted AI character and segment data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/books/book_1/characters') && init?.method === undefined) {
        return jsonResponse({
          characters: [
            {
              id: 'char_1',
              book_id: 'book_1',
              canonical_name: '강현우',
              aliases: ['현우'],
              color: '#3b82f6',
              confidence: 0.91,
              is_user_confirmed: false,
            },
          ],
        });
      }
      if (url.endsWith('/books/book_1/character-graph') && init?.method === undefined) {
        return jsonResponse({
          graph: {
            novelId: 'book_1',
            characters: [
              {
                id: 'char_1',
                book_id: 'book_1',
                canonical_name: 'Hero',
                aliases: ['H'],
                color: '#123456',
                confidence: 0.9,
                is_user_confirmed: true,
              },
            ],
            relations: [
              {
                id: 'rel_1',
                book_id: 'book_1',
                source_character_id: 'char_1',
                target_character_id: 'char_2',
                relation_label: 'mentor',
                terms_used_by_source: ['teacher'],
                terms_used_by_target: ['student'],
                confidence: 0.7,
                evidence: ['chapter_1'],
              },
            ],
          },
        });
      }
      if (url.endsWith('/books/book_1/character-graph') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ ok: true, graph: body.graph });
      }
      if (url.endsWith('/chapters/chapter_1/segments') && init?.method === undefined) {
        return jsonResponse({
          segments: [
            {
              id: 'seg_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              paragraph_id: 'paragraph_1',
              segment_index: 0,
              start_offset: 0,
              end_offset: 4,
              segment_text_hash: 'hash_seg',
              segment_type: 'quoted_dialogue',
              speaker_id: 'char_1',
              candidate_speakers: ['char_1'],
              listener_ids: [],
              emotion: 'neutral',
              confidence: 0.88,
              is_user_corrected: false,
            },
          ],
        });
      }
      if (url.endsWith('/books/book_1/voice-profiles') && init?.method === undefined) {
        return jsonResponse({
          voiceProfiles: [
            {
              id: 'voice_char_1',
              book_id: 'book_1',
              character_id: 'char_1',
              role: 'character',
              provider_id: 'system',
              provider_voice_id: 'ko-KR-local',
              label: '강현우 음성',
              language: 'ko-KR',
              speed: 1.05,
              provider_options: { source: 'manual' },
              is_user_selected: true,
            },
          ],
        });
      }
      if (url.endsWith('/books/book_1/corrections?chapterId=chapter_1') && init?.method === undefined) {
        return jsonResponse({
          corrections: [
            {
              id: 'correction_1',
              book_id: 'book_1',
              chapter_id: 'chapter_1',
              segment_id: 'seg_1',
              correction_type: 'speaker',
              before_json: { speakerId: 'unknown' },
              after_json: { speakerId: 'char_1' },
              apply_scope: 'chapter',
              created_at: '2026-07-05T00:00:00.000Z',
            },
          ],
        });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.listCharacters('book_1')).resolves.toEqual({
      characters: [expect.objectContaining({ id: 'char_1', novelId: 'book_1', canonicalName: '강현우' })],
    });
    await expect(client.listCharacterGraph('book_1')).resolves.toEqual({
      graph: {
        novelId: 'book_1',
        characters: [expect.objectContaining({ id: 'char_1', canonicalName: 'Hero' })],
        relations: [
          expect.objectContaining({
            id: 'rel_1',
            novelId: 'book_1',
            sourceCharacterId: 'char_1',
            targetCharacterId: 'char_2',
            relationLabel: 'mentor',
            termsUsedBySource: ['teacher'],
            termsUsedByTarget: ['student'],
            confidence: 0.7,
            evidence: ['chapter_1'],
          }),
        ],
      },
    });
    await expect(client.listSegments('chapter_1')).resolves.toEqual({
      segments: [
        expect.objectContaining({ id: 'seg_1', novelId: 'book_1', chapterId: 'chapter_1', speakerId: 'char_1' }),
      ],
    });
    await expect(client.listVoiceProfiles('book_1')).resolves.toEqual({
      voiceProfiles: [
        expect.objectContaining({
          id: 'voice_char_1',
          novelId: 'book_1',
          characterId: 'char_1',
          providerId: 'system',
          providerVoiceId: 'ko-KR-local',
          providerOptions: { source: 'manual' },
        }),
      ],
    });
    await expect(client.listCorrections('book_1', { chapterId: 'chapter_1' })).resolves.toEqual({
      corrections: [
        expect.objectContaining({
          id: 'correction_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          segmentId: 'seg_1',
          correctionType: 'speaker',
          afterJson: JSON.stringify({ speakerId: 'char_1' }),
        }),
      ],
    });

    await client.saveCharacters('book_1', [
      {
        id: 'char_1',
        novelId: 'book_1',
        canonicalName: '강현우',
        aliases: ['현우'],
        color: '#3b82f6',
        confidence: 0.91,
        isUserConfirmed: false,
      },
    ]);
    await client.saveCharacterGraph('book_1', {
      novelId: 'book_1',
      characters: [
        {
          id: 'char_1',
          novelId: 'book_1',
          canonicalName: 'Hero',
          aliases: ['H'],
          color: '#123456',
          confidence: 0.9,
          isUserConfirmed: true,
        },
        {
          id: 'char_2',
          novelId: 'book_1',
          canonicalName: 'Mentor',
          aliases: [],
          color: '#654321',
          confidence: 0.8,
          isUserConfirmed: false,
        },
      ],
      relations: [
        {
          id: 'rel_1',
          novelId: 'book_1',
          sourceCharacterId: 'char_1',
          targetCharacterId: 'char_2',
          relationLabel: 'mentor',
          termsUsedBySource: ['teacher'],
          termsUsedByTarget: ['student'],
          confidence: 0.7,
          evidence: ['chapter_1'],
        },
      ],
    });
    await client.saveSegments(
      'chapter_1',
      [
        {
          id: 'seg_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          paragraphId: 'paragraph_1',
          segmentIndex: 0,
          startOffset: 0,
          endOffset: 4,
          segmentTextHash: 'hash_seg',
          type: 'quoted_dialogue',
          speakerId: 'char_1',
          candidateSpeakers: ['char_1'],
          listenerIds: [],
          emotion: 'neutral',
          confidence: 0.88,
          isUserCorrected: false,
        },
      ],
      { expectedRevision: 'segments-revision' },
    );
    await client.saveVoiceProfiles('book_1', [
      {
        id: 'voice_char_1',
        novelId: 'book_1',
        characterId: 'char_1',
        role: 'character',
        providerId: 'system',
        providerVoiceId: 'ko-KR-local',
        label: '강현우 음성',
        language: 'ko-KR',
        speed: 1.05,
        providerOptions: { source: 'manual' },
        isUserSelected: true,
      },
    ]);
    await client.saveCorrection({
      id: 'correction_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      correctionType: 'speaker',
      afterJson: JSON.stringify({ speakerId: 'char_1' }),
      applyScope: 'chapter',
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    await client.deleteCorrection('book_1', 'correction_1', { expectedRevision: 'correction-revision' });

    expect(fetchMock).toHaveBeenCalledWith('/api/books/book_1/characters', expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/character-graph',
      expect.objectContaining({ method: 'PUT' }),
    );
    const graphSaveCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/books/book_1/character-graph') && (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(JSON.parse(String((graphSaveCall?.[1] as RequestInit).body))).toMatchObject({
      graph: {
        relations: [expect.objectContaining({ id: 'rel_1', sourceCharacterId: 'char_1', targetCharacterId: 'char_2' })],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/voice-profiles',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chapters/chapter_1/segments',
      expect.objectContaining({ method: 'PUT' }),
    );
    const segmentSaveCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/chapters/chapter_1/segments') && (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(JSON.parse(String((segmentSaveCall?.[1] as RequestInit).body))).toMatchObject({
      expectedRevision: 'segments-revision',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/corrections',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/corrections/correction_1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    const correctionDeleteCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/books/book_1/corrections/correction_1') &&
        (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(JSON.parse(String((correctionDeleteCall?.[1] as RequestInit).body))).toEqual({
      expectedRevision: 'correction-revision',
    });
  });

  it('maps hosted voice profile rows from snake_case and camelCase payloads', () => {
    expect(
      mapServerVoiceProfile({
        id: 'voice_narrator',
        book_id: 'book_1',
        role: 'narrator',
        provider_id: 'system',
        provider_voice_id: 'ko-KR-narrator',
        label: 'Narrator',
        speed: '1.1',
        provider_options: { source: 'server' },
        is_user_selected: true,
      }),
    ).toMatchObject({
      id: 'voice_narrator',
      novelId: 'book_1',
      role: 'narrator',
      providerId: 'system',
      providerVoiceId: 'ko-KR-narrator',
      speed: 1.1,
      providerOptions: { source: 'server' },
      isUserSelected: true,
    });
  });

  it('maps and requests hosted provider analysis jobs', async () => {
    expect(
      mapServerProviderJob({
        id: 'provider_job_1',
        book_id: 'book_1',
        chapter_id: 'chapter_1',
        job_type: 'chapter_segment_labeling',
        provider_id: 'mock',
        model_id: 'mock-segment-labeler-v1',
        input_hash: 'input_hash',
        status: 'queued',
        stage: 'queued',
        progress: { paragraphCount: 2 },
        created_at: '2026-07-05T00:00:00.000Z',
        updated_at: '2026-07-05T00:00:00.000Z',
      }),
    ).toMatchObject({
      id: 'provider_job_1',
      novelId: 'book_1',
      chapterId: 'chapter_1',
      type: 'chapter_segment_labeling',
      providerId: 'mock',
      status: 'queued',
      stage: 'queued',
      progress: { paragraphCount: 2 },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/books/book_1/analysis-jobs')) {
        return jsonResponse({
          job: {
            id: 'provider_job_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            type: 'chapter_segment_labeling',
            providerId: 'mock',
            modelId: 'mock-segment-labeler-v1',
            inputHash: 'input_hash',
            status: 'queued',
            stage: 'queued',
            progress: {},
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/provider-jobs/provider_job_1/cancel')) {
        return jsonResponse({
          job: {
            id: 'provider_job_1',
            novelId: 'book_1',
            chapterId: 'chapter_1',
            type: 'chapter_segment_labeling',
            providerId: 'mock',
            inputHash: 'input_hash',
            status: 'cancelled',
            stage: 'cancelled',
            progress: { cancelled: true },
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:02:00.000Z',
            finishedAt: '2026-07-05T00:02:00.000Z',
            errorCode: 'provider_job_cancelled',
          },
        });
      }
      return jsonResponse({
        job: {
          id: 'provider_job_1',
          novelId: 'book_1',
          chapterId: 'chapter_1',
          type: 'chapter_segment_labeling',
          providerId: 'mock',
          inputHash: 'input_hash',
          status: 'succeeded',
          stage: 'ready',
          progress: { segmentCount: 2 },
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:01:00.000Z',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.enqueueAnalysisJob({ bookId: 'book_1', chapterId: 'chapter_1' })).resolves.toEqual({
      job: expect.objectContaining({ id: 'provider_job_1', status: 'queued' }),
    });
    await expect(client.getProviderJob('provider_job_1')).resolves.toEqual({
      job: expect.objectContaining({ id: 'provider_job_1', status: 'succeeded', stage: 'ready' }),
    });
    await expect(client.cancelProviderJob('provider_job_1')).resolves.toEqual({
      job: expect.objectContaining({ id: 'provider_job_1', status: 'cancelled', stage: 'cancelled' }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/analysis-jobs',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/provider-jobs/provider_job_1', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/provider-jobs/provider_job_1/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends bundle and graph merge analysis payloads', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        job: {
          id: 'provider_job_graph',
          novelId: 'book_1',
          type: 'character_graph_merge',
          providerId: 'mock',
          inputHash: 'input_hash',
          status: 'queued',
          progress: {},
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await client.enqueueAnalysisJob({
      bookId: 'book_1',
      chapterIds: ['chapter_1', 'chapter_2'],
      providerId: 'mock',
      modelId: 'mock-segment-labeler-v1',
      jobType: 'character_bundle_analysis',
      sourceContext: { bundleId: 'bundle_1', entryChapterId: 'chapter_1' },
    });
    await client.enqueueAnalysisJob({
      bookId: 'book_1',
      providerId: 'mock',
      jobType: 'character_graph_merge',
      discoveredGraph: { novelId: 'book_1', characters: [], relations: [] },
      sourceContext: { bundleId: 'bundle_1', sourceJobId: 'provider_job_bundle' },
    });

    const bundleBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(bundleBody).toMatchObject({
      chapterIds: ['chapter_1', 'chapter_2'],
      providerId: 'mock',
      modelId: 'mock-segment-labeler-v1',
      jobType: 'character_bundle_analysis',
      sourceContext: { bundleId: 'bundle_1', entryChapterId: 'chapter_1' },
    });
    expect(bundleBody.chapterId).toBeUndefined();

    const mergeBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(mergeBody).toMatchObject({
      providerId: 'mock',
      jobType: 'character_graph_merge',
      discoveredGraph: { novelId: 'book_1', characters: [], relations: [] },
      sourceContext: { bundleId: 'bundle_1', sourceJobId: 'provider_job_bundle' },
    });
    expect(mergeBody.chapterId).toBeUndefined();
    expect(mergeBody.chapterIds).toBeUndefined();
  });

  it('loads a whole-book AI workflow plan with planner options', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(String(input)).toBe(
        '/api/books/book_1/analysis-workflow-plan?maxBundleChapters=3&targetLabelingCharacters=8000',
      );
      return jsonResponse({
        plan: {
          novelId: 'book_1',
          totalChapters: 1,
          totalCharacters: 12000,
          stages: [
            { id: 'character_graph_bootstrap', itemIds: ['bundle_1'] },
            { id: 'chapter_labeling', dependsOn: 'character_graph_bootstrap', itemIds: ['window_1'] },
            { id: 'tts_ready_preparation', dependsOn: 'chapter_labeling', itemIds: ['chapter_1'] },
          ],
          bundleWindows: [
            {
              id: 'bundle_1',
              bundleId: 'bundle_1',
              sequence: 0,
              chapterIds: ['chapter_1'],
              startChapterIndex: 1,
              endChapterIndex: 1,
              characterCount: 12000,
              textHashFingerprint: 'hash',
            },
          ],
          labelingChapters: [
            {
              chapterId: 'chapter_1',
              chapterIndex: 1,
              textHash: 'chapter_hash',
              dependsOnGraph: true,
              windows: [
                {
                  id: 'window_1',
                  sequence: 0,
                  chapterId: 'chapter_1',
                  chapterIndex: 1,
                  paragraphIds: ['p1'],
                  startParagraphIndex: 0,
                  endParagraphIndex: 0,
                  characterCount: 8000,
                  textHashFingerprint: 'paragraph_hash',
                  dependsOnGraph: true,
                },
              ],
            },
          ],
          labelingWindows: [
            {
              id: 'window_1',
              sequence: 0,
              chapterId: 'chapter_1',
              chapterIndex: 1,
              paragraphIds: ['p1'],
              startParagraphIndex: 0,
              endParagraphIndex: 0,
              characterCount: 8000,
              textHashFingerprint: 'paragraph_hash',
              dependsOnGraph: true,
            },
          ],
          ttsReady: {
            chapterIds: ['chapter_1'],
            dependsOnLabelingWindowIds: ['window_1'],
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const response = await client.getBookAIWorkflowPlan('book_1', {
      maxBundleChapters: 3,
      targetLabelingCharacters: 8000,
    });

    expect(response.plan.labelingWindows[0].paragraphIds).toEqual(['p1']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/book_1/analysis-workflow-plan?maxBundleChapters=3&targetLabelingCharacters=8000',
      expect.any(Object),
    );
  });

  it('sends and restores hosted book AI workflow definition identity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/books/book_1/analysis-workflows');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        providerId: 'mock',
        workflowDefinitionId: 'moya.ai.tts.book-preparation',
        workflowVersion: '1.0.0',
      });
      return jsonResponse({
        workflow: {
          id: 'workflow_1',
          novelId: 'book_1',
          workflowType: 'book_ai_tts',
          workflow_definition_id: 'moya.ai.tts.book-preparation',
          workflow_version: '1.0.0',
          providerId: 'mock',
          planHash: 'plan_hash',
          status: 'running',
          stage: 'building_graph',
          jobs: [],
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          plan: {
            novelId: 'book_1',
            totalChapters: 0,
            totalCharacters: 0,
            stages: [],
            bundleWindows: [],
            labelingChapters: [],
            labelingWindows: [],
            ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const response = await client.startBookAIWorkflow({
      bookId: 'book_1',
      providerId: 'mock',
      workflowDefinitionId: 'moya.ai.tts.book-preparation',
      workflowVersion: '1.0.0',
    });

    expect(response.workflow).toMatchObject({
      id: 'workflow_1',
      workflowDefinitionId: 'moya.ai.tts.book-preparation',
      workflowVersion: '1.0.0',
      planHash: 'plan_hash',
    });
  });

  it('retries hosted book AI workflows through the workflow retry endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ action: 'retry_same_request' }));
      expect(String(input)).toBe('/api/analysis-workflows/workflow_1/retry');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        workflow: {
          id: 'workflow_1',
          novelId: 'book_1',
          workflowType: 'book_ai_tts',
          providerId: 'mock',
          modelId: 'mock-segment-labeler-v1',
          planHash: 'plan_hash',
          status: 'running',
          stage: 'labeling_chapters',
          progress: { retryCount: 1 },
          jobs: [],
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z',
          plan: {
            novelId: 'book_1',
            totalChapters: 1,
            totalCharacters: 8000,
            stages: [],
            bundleWindows: [],
            labelingChapters: [],
            labelingWindows: [],
            ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const response = await client.retryBookAIWorkflow('workflow_1');

    expect(response.workflow).toMatchObject({
      id: 'workflow_1',
      status: 'running',
      stage: 'labeling_chapters',
      progress: { retryCount: 1 },
    });
  });

  it('cancels hosted book AI workflows through the workflow cancel endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/analysis-workflows/workflow_1/cancel');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        workflow: {
          id: 'workflow_1',
          novelId: 'book_1',
          workflowType: 'book_ai_tts',
          providerId: 'mock',
          modelId: 'mock-segment-labeler-v1',
          planHash: 'plan_hash',
          status: 'cancelled',
          stage: 'cancelled',
          progress: { cancelled: true, cancelledProviderJobIds: ['provider_job_1'] },
          jobs: [],
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z',
          plan: {
            novelId: 'book_1',
            totalChapters: 1,
            totalCharacters: 8000,
            stages: [],
            bundleWindows: [],
            labelingChapters: [],
            labelingWindows: [],
            ttsReady: { chapterIds: [], dependsOnLabelingWindowIds: [] },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const response = await client.cancelBookAIWorkflow('workflow_1');

    expect(response.workflow).toMatchObject({
      id: 'workflow_1',
      status: 'cancelled',
      stage: 'cancelled',
      progress: { cancelled: true, cancelledProviderJobIds: ['provider_job_1'] },
    });
  });

  it('refreshes hosted book AI workflow TTS cache readiness', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/analysis-workflows/workflow_1/tts-cache-readiness');
      expect(init?.method).toBe('POST');
      return jsonResponse({
        workflow: {
          id: 'workflow_1',
          novelId: 'book_1',
          workflowType: 'book_ai_tts',
          providerId: 'mock',
          modelId: 'mock-segment-labeler-v1',
          planHash: 'plan_hash',
          status: 'succeeded',
          stage: 'audio_cache_ready',
          progress: {
            ttsCacheReadiness: {
              ok: true,
              metrics: {
                cacheableSegmentCount: 4,
                cachedSegmentCount: 4,
                missingCachedSegmentCount: 0,
              },
            },
          },
          jobs: [],
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z',
          plan: {
            novelId: 'book_1',
            totalChapters: 1,
            totalCharacters: 8000,
            stages: [],
            bundleWindows: [],
            labelingChapters: [],
            labelingWindows: [],
            ttsReady: { chapterIds: ['chapter_1'], dependsOnLabelingWindowIds: [] },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const response = await client.refreshBookAIWorkflowTTSCacheReadiness('workflow_1');

    expect(response.workflow).toMatchObject({
      id: 'workflow_1',
      status: 'succeeded',
      stage: 'audio_cache_ready',
      progress: {
        ttsCacheReadiness: {
          ok: true,
          metrics: {
            cachedSegmentCount: 4,
          },
        },
      },
    });
  });

  it('reads and mutates durable analysis review drafts through revisioned endpoints', async () => {
    const review = {
      id: 'review_1',
      reviewRevision: 1,
      status: 'open',
      candidate: { characters: [], segments: [] },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/analysis-workflows/workflow_1/reviews')) return jsonResponse({ reviews: [review] });
      if (url.endsWith('/analysis-review-artifacts/review_1/decisions')) {
        const body = JSON.parse(String(init?.body));
        expect(init?.method).toBe('POST');
        if (body.action === 'save_draft') {
          expect(body).toEqual({
            action: 'save_draft',
            expectedReviewRevision: 1,
            candidate: review.candidate,
            editIntents: {},
          });
          return jsonResponse({ review: { ...review, status: 'editing', reviewRevision: 2 } });
        }
        if (body.action === 'approve') {
          expect(body).toEqual({ action: 'approve', expectedReviewRevision: 2 });
          return jsonResponse({ review: { ...review, status: 'promoted', reviewRevision: 4 } });
        }
        expect(body).toEqual({ action: 'reject', expectedReviewRevision: 2, reason: 'invalid attribution' });
        return jsonResponse({ review: { ...review, status: 'rejected', reviewRevision: 3 } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.listBookAIWorkflowReviews('workflow_1')).resolves.toEqual({ reviews: [review] });
    await expect(
      client.saveAnalysisReviewDraft('review_1', {
        expectedReviewRevision: 1,
        candidate: review.candidate,
        editIntents: {},
      }),
    ).resolves.toMatchObject({ review: { status: 'editing', reviewRevision: 2 } });
    await expect(client.approveAnalysisReviewArtifact('review_1', 2)).resolves.toMatchObject({
      review: { status: 'promoted', reviewRevision: 4 },
    });
    await expect(
      client.rejectAnalysisReviewArtifact('review_1', {
        expectedReviewRevision: 2,
        reason: 'invalid attribution',
      }),
    ).resolves.toMatchObject({ review: { status: 'rejected', reviewRevision: 3 } });
  });

  it('maps provider catalog and resolves hosted TTS cache jobs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/providers')) {
        return jsonResponse({
          aiProviders: [
            {
              providerId: 'openai',
              displayName: 'OpenAI',
              kind: 'llm',
              executionTarget: 'server_worker',
              secretPolicy: 'server_env_only',
              implemented: false,
              enabled: true,
              secretConfigured: true,
              models: [],
              capabilities: { supportsStructuredOutput: true },
            },
          ],
          ttsProviders: [
            {
              providerId: 'openai-tts',
              displayName: 'OpenAI TTS',
              kind: 'tts',
              executionTarget: 'server_worker',
              secretPolicy: 'server_env_only',
              implemented: true,
              enabled: true,
              secretConfigured: true,
              models: [],
              capabilities: { supportsAudioCache: true },
            },
          ],
        });
      }
      if (url.endsWith('/provider-settings') && (!init || init.method === undefined || init.method === 'GET')) {
        return jsonResponse({
          settings: {
            llmLabeling: {
              scope: 'llm_labeling',
              defaultProviderId: 'openai',
              enabledProviderIds: ['openai'],
              modelByProvider: { openai: 'gpt-labeler' },
              providerOptionsByProvider: { openai: { temperature: 0.1 } },
              updatedAt: '2026-07-06T00:00:00.000Z',
            },
            ttsSynthesis: {
              scope: 'tts_synthesis',
              defaultProviderId: 'openai-tts',
              enabledProviderIds: ['system', 'openai-tts'],
              modelByProvider: { 'openai-tts': 'tts-model-a' },
              providerOptionsByProvider: {},
            },
          },
          catalog: { aiProviders: [], ttsProviders: [] },
        });
      }
      if (url.endsWith('/provider-settings/llm_labeling') && init?.method === 'PUT') {
        return jsonResponse({
          settings: {
            scope: 'llm_labeling',
            defaultProviderId: 'openai',
            enabledProviderIds: ['openai'],
            modelByProvider: { openai: 'gpt-labeler-2' },
            providerOptionsByProvider: { openai: { temperature: 0.2 } },
          },
          catalog: { aiProviders: [], ttsProviders: [] },
        });
      }
      if (url.endsWith('/chapters/chapter_1/tts-cache/resolve') && init?.method === 'POST') {
        return jsonResponse({
          cacheHit: false,
          cacheKey: 'tts_cache_key',
          optionsHash: 'opts_hash',
          job: {
            id: 'provider_job_tts',
            book_id: 'book_1',
            chapter_id: 'chapter_1',
            job_type: 'tts_synthesis',
            provider_id: 'openai-tts',
            model_id: 'tts-model-a',
            input_hash: 'input_hash',
            status: 'queued',
            stage: 'queued',
            progress: { ttsCache: { cacheKey: 'tts_cache_key' } },
            created_at: '2026-07-05T00:00:00.000Z',
            updated_at: '2026-07-05T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/chapters/chapter_1/tts-cache/tts_cache_key/audio')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    await expect(client.listProviders()).resolves.toEqual({
      aiProviders: [expect.objectContaining({ providerId: 'openai', secretConfigured: true })],
      ttsProviders: [expect.objectContaining({ providerId: 'openai-tts', capabilities: { supportsAudioCache: true } })],
    });
    await expect(client.getProviderSettings()).resolves.toEqual({
      settings: expect.objectContaining({
        llmLabeling: expect.objectContaining({
          defaultProviderId: 'openai',
          modelByProvider: { openai: 'gpt-labeler' },
        }),
      }),
      catalog: { aiProviders: [], ttsProviders: [] },
      secretStatuses: [],
    });
    await expect(
      client.saveProviderSettings('llm_labeling', {
        defaultProviderId: 'openai',
        modelByProvider: { openai: 'gpt-labeler-2' },
        providerOptionsByProvider: { openai: { temperature: 0.2 } },
      }),
    ).resolves.toEqual({
      settings: expect.objectContaining({
        defaultProviderId: 'openai',
        modelByProvider: { openai: 'gpt-labeler-2' },
      }),
      catalog: { aiProviders: [], ttsProviders: [] },
      secretStatuses: [],
    });
    await expect(
      client.resolveTTSCache('chapter_1', {
        providerId: 'openai-tts',
        providerModel: 'tts-model-a',
        voiceProfileId: 'voice_openai_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: 'text_hash',
        providerOptions: { speed: 1 },
      }),
    ).resolves.toEqual({
      cacheHit: false,
      cacheKey: 'tts_cache_key',
      optionsHash: 'opts_hash',
      job: expect.objectContaining({ id: 'provider_job_tts', type: 'tts_synthesis' }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chapters/chapter_1/tts-cache/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(client.ttsCacheAudioUrl('chapter_1', 'tts_cache_key')).toBe(
      '/api/chapters/chapter_1/tts-cache/tts_cache_key/audio',
    );
    const audio = await client.fetchTTSCacheAudio('chapter_1', 'tts_cache_key');
    expect(audio.type).toBe('audio/mpeg');
  });

  it('maps hosted TTS cache rows from snake_case payloads', () => {
    expect(
      mapServerTTSCacheItem({
        id: 'cache_1',
        book_id: 'book_1',
        chapter_id: 'chapter_1',
        cache_key: 'tts_cache',
        provider_id: 'openai-tts',
        provider_model: 'tts-model-a',
        provider_version: 'v1',
        voice_profile_id: 'voice_1',
        speaker_id: 'char_1',
        segment_ids: ['seg_1'],
        input_text_hash: 'text_hash',
        options_hash: 'opts_hash',
        audio_object_key: 'tts/cache_1.mp3',
        content_type: 'audio/mpeg',
        byte_size: '1234',
        audio_hash: 'audio_hash',
        duration_ms: '3210',
        created_at: '2026-07-05T00:00:00.000Z',
        updated_at: '2026-07-05T00:01:00.000Z',
      }),
    ).toMatchObject({
      id: 'cache_1',
      novelId: 'book_1',
      providerId: 'openai-tts',
      providerModel: 'tts-model-a',
      byteSize: 1234,
      durationMs: 3210,
      segmentIds: ['seg_1'],
    });
  });
});

describe('RemoteApiClient snapshot revision contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const book = {
    id: 'book_snapshot',
    title: 'Snapshot Book',
    source_file_name: 'snapshot.txt',
    source_encoding: 'utf-8',
    normalized_text_hash: 'snapshot-content-hash',
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
    total_chapters: 1,
    total_characters: 4,
    total_paragraphs: 1,
    cover_seed: 1,
  };
  const chapter = {
    id: 'chapter_snapshot',
    book_id: 'book_snapshot',
    chapter_index: 1,
    title: '1화',
    text_hash: 'chapter-hash',
    raw_start_offset: 0,
    raw_end_offset: 4,
    character_count: 4,
    paragraph_count: 1,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
  const paragraph = {
    id: 'paragraph_snapshot',
    novelId: 'book_snapshot',
    chapterId: 'chapter_snapshot',
    index: 1,
    text: 'body',
    startOffsetInChapter: 0,
    endOffsetInChapter: 4,
    textHash: 'paragraph-hash',
  };
  const page = {
    id: 'page_snapshot',
    book_id: 'book_snapshot',
    chapter_id: 'chapter_snapshot',
    page_index: 0,
    start_paragraph_index: 1,
    end_paragraph_index: 1,
    paragraphs: [paragraph],
    text_hash: 'page-hash',
  };

  it('pins chapter, page, and final manifest requests to an advertised source revision', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/books/book_snapshot/manifest') {
        return jsonResponse({ book, readingPosition: null, content_revision_id: 'revision-1' });
      }
      if (url.includes('/books/book_snapshot/chapters')) {
        return jsonResponse({ chapters: [chapter], content_revision_id: 'revision-1' });
      }
      if (url.includes('/chapters/chapter_snapshot/pages')) {
        return jsonResponse({ pages: [page], content_revision_id: 'revision-1' });
      }
      if (url.includes('/books/book_snapshot/manifest?')) {
        return jsonResponse({ book, readingPosition: null, content_revision_id: 'revision-1' });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new RemoteApiClient('/api');

    const snapshot = await client.getBookSnapshotStream('book_snapshot');
    const pages = [];
    for await (const batch of snapshot?.pageBatches ?? []) pages.push(...batch);

    expect(snapshot).toMatchObject({
      sourceRevision: 'revision-1',
      contentHash: 'snapshot-content-hash',
      expectedChapterCount: 1,
      expectedPageCount: 1,
      expectedParagraphCount: 1,
    });
    expect(pages).toMatchObject([{ id: 'page_snapshot', paragraphs: [{ id: 'paragraph_snapshot' }] }]);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/books/book_snapshot/manifest',
      '/api/books/book_snapshot/chapters?contentRevisionId=revision-1',
      '/api/chapters/chapter_snapshot/pages?from=0&count=20&contentRevisionId=revision-1',
      '/api/books/book_snapshot/manifest?contentRevisionId=revision-1',
    ]);
  });

  it('rejects a page response from a different source revision', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/books/book_snapshot/manifest') {
        return jsonResponse({ book, readingPosition: null, content_revision_id: 'revision-1' });
      }
      if (url.includes('/books/book_snapshot/chapters')) {
        return jsonResponse({ chapters: [chapter], content_revision_id: 'revision-1' });
      }
      return jsonResponse({ pages: [page], content_revision_id: 'revision-2' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await new RemoteApiClient('/api').getBookSnapshotStream('book_snapshot');

    await expect(
      (async () => {
        for await (const _batch of snapshot?.pageBatches ?? []) {
          // Consume the stream so the pinned response is validated.
        }
      })(),
    ).rejects.toMatchObject({ name: 'RemoteSnapshotRevisionMismatchError' });
  });
});
