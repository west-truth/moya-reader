import { describe, expect, it, vi } from 'vitest';
import { buildTTSRenderSpec, ttsRenderSpecHash } from '../../providers/tts-render-spec';
import type { VoiceProfile } from '../../domain/types';
import { TauriNativeTTSCacheGateway } from './native-tts-cache-gateway';

const voiceProfile: VoiceProfile = {
  id: 'voice-1',
  novelId: 'book-1',
  characterId: 'character-1',
  role: 'character',
  providerId: 'openai-tts',
  providerVoiceId: 'alloy',
  label: 'Character',
  speed: 1,
  pitch: 1,
  isUserSelected: true,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
};

function renderInput() {
  const renderSpec = buildTTSRenderSpec({
    novelId: 'book-1',
    chapterId: 'chapter-1',
    contentRevision: 'revision-1',
    chapterTextHash: 'sha256:chapter',
    speakerId: 'character-1',
    voiceProfile,
    segmentAnchors: [
      {
        segmentId: 'segment-1',
        paragraphId: 'paragraph-1',
        startOffset: 0,
        endOffset: 5,
        segmentTextHash: 'sha256:segment',
      },
    ],
    inputTextHash: 'sha256:text',
    providerOptionsHash: 'sha256:options',
  });
  return {
    operationId: 'operation-1',
    contentRevision: 'revision-1',
    renderSpec,
    renderSpecHash: ttsRenderSpecHash(renderSpec),
    recoveryPolicy: { network: 'unmetered' as const, charging: 'required' as const },
    synthesis: {
      providerId: 'openai-tts',
      text: 'Hello',
      voiceId: 'alloy',
      speed: 1,
      format: 'mp3' as const,
      providerOptions: {},
    },
  };
}

describe('TauriNativeTTSCacheGateway', () => {
  it('maps canonical render and readiness command contracts', async () => {
    const input = renderInput();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'native_tts_cache_readiness') {
        return {
          ok: true,
          planned: 1,
          ready: 1,
          missing: 0,
          byteSize: 3,
          readyRenderSpecHashes: [input.renderSpecHash],
          missingRenderSpecHashes: [],
          evidenceHash: 'sha256:evidence',
          checkedAtMs: 1,
        };
      }
      return {
        cacheKey: 'cache-1',
        renderSpecHash: input.renderSpecHash,
        contentRevision: 'revision-1',
        cacheHit: true,
        synthesis: {
          providerId: 'openai-tts',
          contentType: 'audio/mpeg',
          audioBase64: 'AQID',
          byteSize: 3,
        },
      };
    });
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    const rendered = await gateway.render(input, new AbortController().signal);
    const readiness = await gateway.inspect({
      novelId: 'book-1',
      contentRevision: 'revision-1',
      expected: [{ renderSpec: input.renderSpec, renderSpecHash: input.renderSpecHash }],
    });

    expect(rendered.cacheHit).toBe(true);
    expect(new Uint8Array(rendered.synthesis.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(readiness.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      'native_tts_render_cached',
      expect.objectContaining({
        request: expect.objectContaining({
          operationId: 'operation-1',
          recoveryPolicy: { network: 'unmetered', charging: 'required' },
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'native_tts_cache_readiness',
      expect.objectContaining({ request: expect.objectContaining({ novelId: 'book-1' }) }),
    );
  });

  it('passes cache quota and protected keys to native cleanup', async () => {
    const invoke = vi.fn(async () => ({
      beforeBytes: 100,
      afterBytes: 80,
      removedBytes: 20,
      removedItems: 1,
      retainedItems: 2,
    }));
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    const result = await gateway.prune({ maxBytes: 80, protectedCacheKeys: ['cache-pinned'] });

    expect(result.removedItems).toBe(1);
    expect(invoke).toHaveBeenCalledWith('native_tts_cache_prune', {
      request: { maxBytes: 80, protectedCacheKeys: ['cache-pinned'] },
    });
  });

  it('lists durable native render jobs for recovery coordination', async () => {
    const pending = [
      {
        operationId: 'operation-1',
        novelId: 'book-1',
        chapterId: 'chapter-1',
        providerId: 'local-endpoint',
        renderSpecHash: 'sha256:render',
        state: 'retry_wait' as const,
        attemptCount: 2,
        updatedAtMs: 1000,
        nextAttemptAtMs: 13000,
        failureKind: 'transient' as const,
      },
    ];
    const invoke = vi.fn(async () => pending);
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    await expect(gateway.pendingJobs()).resolves.toEqual(pending);
    expect(invoke).toHaveBeenCalledWith('native_tts_pending_jobs');
  });

  it('maps cache evidence used to reconcile headless Android completion', async () => {
    const evidence = [{ renderSpecHash: 'sha256:render', cacheKey: 'tts_cache', byteSize: 42 }];
    const invoke = vi.fn(async () => evidence);
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );

    await expect(gateway.evidence(['sha256:render', 'sha256:render'])).resolves.toEqual(evidence);
    expect(invoke).toHaveBeenCalledWith('native_tts_cache_evidence', {
      request: { renderSpecHashes: ['sha256:render'] },
    });
  });

  it('forwards AbortSignal cancellation to the native operation registry', async () => {
    const input = renderInput();
    let resolveRender!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => {
      if (command === 'native_tts_render_cached') return new Promise((resolve) => (resolveRender = resolve));
      return Promise.resolve(undefined);
    });
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );
    const controller = new AbortController();
    const pending = gateway.render(input, controller.signal);
    await Promise.resolve();
    controller.abort();
    resolveRender({
      cacheKey: 'cache-1',
      renderSpecHash: input.renderSpecHash,
      contentRevision: 'revision-1',
      cacheHit: false,
      synthesis: { providerId: 'openai-tts', contentType: 'audio/mpeg', audioBase64: 'AQID', byteSize: 3 },
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('native_tts_operation_cancel', { operationId: 'operation-1' });
  });

  it('serializes readiness scans and drops a cancelled queued scan before IPC', async () => {
    const input = renderInput();
    let resolveFirst!: (value: unknown) => void;
    const result = {
      ok: true,
      planned: 1,
      ready: 1,
      missing: 0,
      byteSize: 3,
      readyRenderSpecHashes: [input.renderSpecHash],
      missingRenderSpecHashes: [],
      evidenceHash: 'sha256:evidence',
      checkedAtMs: 1,
    };
    const invoke = vi.fn(() => new Promise((resolve) => (resolveFirst = resolve)));
    const gateway = new TauriNativeTTSCacheGateway(
      invoke as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    );
    const readinessInput = {
      novelId: 'book-1',
      contentRevision: 'revision-1',
      expected: [{ renderSpec: input.renderSpec, renderSpecHash: input.renderSpecHash }],
    };
    const first = gateway.inspect(readinessInput);
    const secondController = new AbortController();
    const second = gateway.inspect(readinessInput, secondController.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    secondController.abort();
    resolveFirst(result);

    await expect(first).resolves.toEqual(result);
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
