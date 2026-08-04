import { describe, expect, it } from 'vitest';
import { ProviderRegistry, type ProviderIdentity } from '../providers/provider-registry';
import { createReaderProviderRuntime } from '../providers/reader-provider-runtime';
import { buildProviderOptionsHash, buildTTSCacheKey, stableProviderJson } from '../providers/tts-cache';
import { buildTTSRenderSpec, normalizeTTSRenderSpec, ttsRenderSpecHash } from '../providers/tts-render-spec';
import type { VoiceProfile } from '../domain/types';

class TestProvider implements ProviderIdentity {
  constructor(
    readonly providerId: string,
    readonly displayName: string,
  ) {}
}

describe('ProviderRegistry', () => {
  it('registers, lists, and retrieves providers by id', () => {
    const provider = new TestProvider('mock', 'Mock Provider');
    const registry = new ProviderRegistry<TestProvider>([provider]);

    expect(registry.has('mock')).toBe(true);
    expect(registry.get('mock')).toBe(provider);
    expect(registry.list()).toEqual([provider]);
  });

  it('rejects duplicate provider ids and missing lookups', () => {
    const registry = new ProviderRegistry<TestProvider>([new TestProvider('mock', 'Mock Provider')]);

    expect(() => registry.register(new TestProvider('mock', 'Other Provider'))).toThrow('Provider already registered');
    expect(() => registry.get('missing')).toThrow('Provider not found');
  });
});

describe('reader provider runtime', () => {
  it('keeps default local providers behind registries', () => {
    const runtime = createReaderProviderRuntime();

    expect(runtime.defaultAIProviderId).toBe('mock');
    expect(runtime.defaultTTSProviderId).toBe('system');
    expect(runtime.getDefaultAIProvider().providerId).toBe('mock');
    expect(runtime.getDefaultTTSProvider().providerId).toBe('system');
    expect(runtime.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'mock', secretPolicy: 'no_secret_required' }),
        expect.objectContaining({ providerId: 'system', secretPolicy: 'no_secret_required' }),
      ]),
    );
  });
});

describe('TTS cache keys', () => {
  it('hashes stable provider options without depending on object key order', async () => {
    expect(stableProviderJson({ b: 2, a: 1 })).toBe(stableProviderJson({ a: 1, b: 2 }));

    await expect(buildProviderOptionsHash({ speed: 1, pitch: 0.9 })).resolves.toBe(
      await buildProviderOptionsHash({ pitch: 0.9, speed: 1 }),
    );
  });

  it('changes when provider or voice inputs change', async () => {
    const base = {
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      contentRevision: 'revision_1',
      chapterTextHash: 'chapter_hash_1',
      segmentIds: ['seg_1', 'seg_2'],
      speakerId: 'char_1',
      voiceProfileId: 'voice_1',
      providerId: 'openai',
      providerModel: 'tts-model',
      inputTextHash: 'text_hash',
      optionsHash: 'options_hash',
    };

    const key = await buildTTSCacheKey(base);
    await expect(buildTTSCacheKey({ ...base, providerId: 'elevenlabs' })).resolves.not.toBe(key);
    await expect(buildTTSCacheKey({ ...base, voiceProfileId: 'voice_2' })).resolves.not.toBe(key);
    await expect(buildTTSCacheKey({ ...base, optionsHash: 'other_options' })).resolves.not.toBe(key);
  });

  it('includes render specs in cache identity for voice revisions and segment anchors', async () => {
    const voiceProfile: VoiceProfile = {
      id: 'voice_1',
      novelId: 'novel_1',
      characterId: 'char_1',
      role: 'character',
      providerId: 'openai',
      providerVoiceId: 'alloy',
      providerModel: 'tts-model',
      label: 'Alloy',
      speed: 1,
      providerOptions: {},
      isUserSelected: true,
      updatedAt: '2026-07-06T00:00:00.000Z',
    };
    const baseSpec = buildTTSRenderSpec({
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      speakerId: 'char_1',
      voiceProfile,
      segmentAnchors: [
        {
          segmentId: 'seg_1',
          paragraphId: 'paragraph_1',
          startOffset: 0,
          endOffset: 8,
          segmentTextHash: 'segment_hash_1',
        },
      ],
      inputTextHash: 'text_hash',
      providerOptionsHash: 'opts_1',
    });
    const baseHash = ttsRenderSpecHash(baseSpec);

    expect(ttsRenderSpecHash({ ...baseSpec, speed: 1.2 })).not.toBe(baseHash);
    expect(ttsRenderSpecHash({ ...baseSpec, contentRevision: 'revision_2' })).not.toBe(baseHash);
    expect(ttsRenderSpecHash({ ...baseSpec, chapterTextHash: 'chapter_hash_2' })).not.toBe(baseHash);
    expect(
      ttsRenderSpecHash({
        ...baseSpec,
        voiceProfileRevision: '2026-07-06T01:00:00.000Z',
      }),
    ).not.toBe(baseHash);
    expect(
      ttsRenderSpecHash({
        ...baseSpec,
        segmentAnchors: [{ ...baseSpec.segmentAnchors[0], segmentTextHash: 'segment_hash_2' }],
      }),
    ).not.toBe(baseHash);

    const keyBase = {
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      segmentIds: ['seg_1'],
      speakerId: 'char_1',
      voiceProfileId: 'voice_1',
      providerId: 'openai',
      providerModel: 'tts-model',
      inputTextHash: 'text_hash',
      optionsHash: 'opts_1',
    };
    const cacheKey = await buildTTSCacheKey({ ...keyBase, renderSpecHash: baseHash });
    await expect(
      buildTTSCacheKey({
        ...keyBase,
        renderSpecHash: ttsRenderSpecHash({ ...baseSpec, speed: 1.2 }),
      }),
    ).resolves.not.toBe(cacheKey);
  });

  it('derives a stable revision for legacy voice profiles without timestamps', () => {
    const voiceProfile: VoiceProfile = {
      id: 'voice_legacy',
      novelId: 'novel_1',
      role: 'narrator',
      providerId: 'openai-tts',
      providerVoiceId: 'alloy',
      label: 'Legacy',
      speed: 1,
      isUserSelected: true,
    };
    const input = {
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      speakerId: 'narrator',
      voiceProfile,
      segmentAnchors: [{ segmentId: 'segment_1' }],
      inputTextHash: 'sha256:text',
      providerOptionsHash: 'sha256:options',
    };

    const first = buildTTSRenderSpec(input);
    expect(first.voiceProfileRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(buildTTSRenderSpec(input).voiceProfileRevision).toBe(first.voiceProfileRevision);
  });

  it('includes pronunciation revision in the render identity', () => {
    const voiceProfile: VoiceProfile = {
      id: 'voice_pronunciation',
      novelId: 'novel_1',
      role: 'narrator',
      providerId: 'openai-tts',
      providerVoiceId: 'alloy',
      label: 'Narrator',
      speed: 1,
      isUserSelected: true,
    };
    const base = {
      novelId: 'novel_1',
      chapterId: 'chapter_1',
      speakerId: 'narrator',
      voiceProfile,
      segmentAnchors: [{ segmentId: 'segment_1' }],
      inputTextHash: 'sha256:text',
      providerOptionsHash: 'sha256:options',
    };
    const first = buildTTSRenderSpec({ ...base, pronunciationRevisionId: 'pronunciation-r1' });
    const second = buildTTSRenderSpec({ ...base, pronunciationRevisionId: 'pronunciation-r2' });
    expect(ttsRenderSpecHash(first)).not.toBe(ttsRenderSpecHash(second));
  });

  it('rejects malformed render spec numeric anchors instead of silently dropping them', () => {
    expect(() =>
      normalizeTTSRenderSpec({
        novelId: 'novel_1',
        chapterId: 'chapter_1',
        speakerId: 'char_1',
        voiceProfileId: 'voice_1',
        providerId: 'openai',
        segmentAnchors: [{ segmentId: 'seg_1', startOffset: 'bad' }],
        inputTextHash: 'text_hash',
        providerOptionsHash: 'opts_1',
        format: 'mp3',
        speed: 1,
      }),
    ).toThrow('TTS render segment anchor startOffset must be a number');
  });
});
