import { describe, expect, it } from 'vitest';
import type { LabeledSegment, Paragraph, VoiceProfile } from '../domain/types';
import { integrityHash } from '../domain/id-hash-contract';
import { ttsProviderOptionsIntegrityHash } from '../domain/identity/tts-identities';
import { buildHostedTTSCacheRequest, effectiveTTSProviderModel } from '../providers/hosted-tts-playback';
import { HostedTTSPrefetchCache, hostedTTSCacheRequestKey } from '../providers/hosted-tts-prefetch';
import { buildHostedTTSBulkWarmupRequests, buildHostedTTSWarmupRequests } from '../providers/hosted-tts-warmup';
import type { PlayableTtsSegment } from '../providers/tts-playback';

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 0,
  text: '그가 말했다. "안녕." 그리고 웃었다.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 21,
  textHash: 'paragraph_hash',
};

function segment(patch: Partial<LabeledSegment> = {}): LabeledSegment {
  return {
    id: 'seg_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: paragraph.id,
    segmentIndex: 0,
    startOffset: 8,
    endOffset: 14,
    segmentTextHash: 'segment_hash',
    type: 'quoted_dialogue',
    speakerId: 'char_1',
    candidateSpeakers: ['char_1'],
    listenerIds: [],
    emotion: 'happy',
    confidence: 0.9,
    isUserCorrected: false,
    ...patch,
  };
}

function voiceProfile(patch: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    id: 'voice_openai_char_1',
    novelId: 'book_1',
    characterId: 'char_1',
    role: 'character',
    providerId: 'openai-tts',
    providerVoiceId: 'alloy',
    providerModel: 'gpt-4o-mini-tts',
    label: 'OpenAI alloy',
    speed: 1,
    providerOptions: { responseFormat: 'mp3' },
    isUserSelected: true,
    ...patch,
  };
}

function playable(patch: Partial<PlayableTtsSegment> = {}): PlayableTtsSegment {
  return {
    paragraphId: paragraph.id,
    text: '"안녕."',
    speakerId: 'char_1',
    speakerLabel: '강현우',
    emotion: 'happy',
    voiceProfileId: 'voice_openai_char_1',
    rate: 1.1,
    sourceSegmentIds: ['seg_1'],
    sourceRanges: [
      {
        segmentId: 'seg_1',
        paragraphId: paragraph.id,
        startOffset: 8,
        endOffset: 14,
      },
    ],
    ...patch,
  };
}

describe('buildHostedTTSCacheRequest', () => {
  it('normalizes native provider defaults before hashing and dispatch', () => {
    expect(effectiveTTSProviderModel('openai-tts')).toBe('gpt-4o-mini-tts');
    expect(effectiveTTSProviderModel('elevenlabs')).toBe('eleven_flash_v2_5');
    expect(effectiveTTSProviderModel('local-endpoint', 'endpoint-default')).toBeUndefined();
    expect(effectiveTTSProviderModel('local-endpoint', 'custom-model')).toBe('custom-model');
  });

  it('builds a raw-text-free cache resolve request for a hosted voice profile', () => {
    const result = buildHostedTTSCacheRequest({
      paragraph,
      playable: playable(),
      segments: [segment()],
      voiceProfiles: [voiceProfile()],
    });

    expect(result).toEqual({
      voiceProfile: expect.objectContaining({ providerId: 'openai-tts' }),
      text: '"안녕."',
      request: expect.objectContaining({
        providerId: 'openai-tts',
        providerModel: 'gpt-4o-mini-tts',
        voiceProfileId: 'voice_openai_char_1',
        speakerId: 'char_1',
        segmentIds: ['seg_1'],
        inputTextHash: integrityHash('"안녕."'),
        audioCharacters: 5,
        providerOptions: { responseFormat: 'mp3', speed: 1.1 },
        renderSpec: expect.objectContaining({
          novelId: 'book_1',
          chapterId: 'chapter_1',
          speakerId: 'char_1',
          voiceProfileId: 'voice_openai_char_1',
          providerId: 'openai-tts',
          providerModel: 'gpt-4o-mini-tts',
          providerVoiceId: 'alloy',
          inputTextHash: integrityHash('"안녕."'),
          providerOptionsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          format: 'mp3',
          speed: 1.1,
          emotion: 'neutral',
          alignmentMode: 'exact_segment',
          appliedControls: expect.objectContaining({
            emotion: 'neutral',
            ignored: expect.arrayContaining([
              expect.objectContaining({ control: 'emotion', reason: 'unsupported_by_provider' }),
            ]),
          }),
          segmentAnchors: [
            {
              segmentId: 'seg_1',
              paragraphId: 'paragraph_1',
              startOffset: 8,
              endOffset: 14,
              segmentTextHash: 'segment_hash',
            },
          ],
        }),
      }),
    });
    expect(JSON.stringify(result)).not.toContain(paragraph.text);
    expect(JSON.stringify(result?.request)).not.toContain('안녕');
  });

  it('builds a stable request for merged same-speaker segments', () => {
    const multiParagraph: Paragraph = {
      ...paragraph,
      id: 'paragraph_multi',
      text: 'A. B.',
      endOffsetInChapter: 5,
      textHash: 'paragraph_multi_hash',
    };

    const result = buildHostedTTSCacheRequest({
      paragraph: multiParagraph,
      playable: playable({
        paragraphId: multiParagraph.id,
        text: 'A.\nB.',
        sourceSegmentIds: ['seg_a', 'seg_b'],
        sourceRanges: [
          { segmentId: 'seg_a', paragraphId: multiParagraph.id, startOffset: 0, endOffset: 2 },
          { segmentId: 'seg_b', paragraphId: multiParagraph.id, startOffset: 3, endOffset: 5 },
        ],
      }),
      segments: [
        segment({ id: 'seg_a', paragraphId: multiParagraph.id, startOffset: 0, endOffset: 2 }),
        segment({ id: 'seg_b', paragraphId: multiParagraph.id, startOffset: 3, endOffset: 5, segmentIndex: 1 }),
      ],
      voiceProfiles: [voiceProfile()],
    });

    expect(result?.request).toEqual(
      expect.objectContaining({
        segmentIds: ['seg_a', 'seg_b'],
        inputTextHash: integrityHash('A.\nB.'),
        audioCharacters: 5,
      }),
    );
    expect(result?.request.renderSpec?.alignmentMode).toBe('estimated_chunk');
    expect(JSON.stringify(result?.request)).not.toContain('A. B.');
  });

  it('uses clipped source ranges instead of full overlapping segment text', () => {
    const overlapParagraph: Paragraph = {
      ...paragraph,
      id: 'paragraph_overlap',
      text: '0123456789',
      endOffsetInChapter: 10,
      textHash: 'paragraph_overlap_hash',
    };
    const result = buildHostedTTSCacheRequest({
      paragraph: overlapParagraph,
      playable: playable({
        paragraphId: overlapParagraph.id,
        text: '56789',
        sourceSegmentIds: ['seg_overlap'],
        sourceRanges: [{ segmentId: 'seg_overlap', paragraphId: overlapParagraph.id, startOffset: 5, endOffset: 10 }],
      }),
      segments: [
        segment({
          id: 'seg_overlap',
          paragraphId: overlapParagraph.id,
          startOffset: 0,
          endOffset: 10,
          segmentTextHash: 'overlap_hash',
        }),
      ],
      voiceProfiles: [voiceProfile()],
    });

    expect(result?.request).toEqual(
      expect.objectContaining({
        segmentIds: ['seg_overlap'],
        inputTextHash: integrityHash('56789'),
        audioCharacters: 5,
      }),
    );
    expect(result?.request.renderSpec?.segmentAnchors).toEqual([
      {
        segmentId: 'seg_overlap',
        paragraphId: overlapParagraph.id,
        startOffset: 5,
        endOffset: 10,
        segmentTextHash: 'overlap_hash',
      },
    ]);
    expect(JSON.stringify(result?.request)).not.toContain('0123456789');
  });

  it('does not build a hosted request for system voices, unlabeled gaps, or source text mismatches', () => {
    const base = {
      paragraph,
      segments: [segment()],
    };

    expect(
      buildHostedTTSCacheRequest({
        ...base,
        playable: playable({ voiceProfileId: 'voice_system', sourceSegmentIds: ['seg_1'] }),
        voiceProfiles: [voiceProfile({ id: 'voice_system', providerId: 'system' })],
      }),
    ).toBeUndefined();

    expect(
      buildHostedTTSCacheRequest({
        ...base,
        playable: playable({ sourceSegmentIds: [], sourceRanges: [] }),
        voiceProfiles: [voiceProfile()],
      }),
    ).toBeUndefined();

    expect(
      buildHostedTTSCacheRequest({
        ...base,
        playable: playable({ text: '녕.', sourceSegmentIds: ['seg_1'] }),
        voiceProfiles: [voiceProfile()],
      }),
    ).toBeUndefined();

    expect(
      buildHostedTTSCacheRequest({
        ...base,
        playable: playable(),
        voiceProfiles: [voiceProfile({ providerOptions: { apiKey: 'sk-proj-secretvalue' } })],
      }),
    ).toBeUndefined();
  });

  it('normalizes empty top-level provider options before hashing and dispatch', () => {
    const result = buildHostedTTSCacheRequest({
      paragraph,
      playable: playable(),
      segments: [segment()],
      voiceProfiles: [voiceProfile({ providerOptions: { responseFormat: 'mp3', empty: '', nullable: null } })],
    });

    expect(result?.request.providerOptions).toEqual({ responseFormat: 'mp3', speed: 1.1 });
    expect(result?.request.renderSpec?.providerOptionsHash).toBe(
      ttsProviderOptionsIntegrityHash({ responseFormat: 'mp3', speed: 1.1 }),
    );
  });
});

describe('HostedTTSPrefetchCache', () => {
  it('keys cache requests without raw text and evicts older prefetched audio', () => {
    const request = buildHostedTTSCacheRequest({
      paragraph,
      playable: playable(),
      segments: [segment()],
      voiceProfiles: [voiceProfile()],
    })?.request;
    expect(request).toBeDefined();
    const key = hostedTTSCacheRequestKey('chapter_1', request!);
    expect(key).toMatch(/^hosted_tts_/);
    expect(key).not.toContain(paragraph.text);

    const cache = new HostedTTSPrefetchCache(1);
    cache.remember(key, { cacheKey: 'tts_a', blob: new Blob(['a']) });
    cache.remember('other', { cacheKey: 'tts_b', blob: new Blob(['b']) });

    expect(cache.size).toBe(1);
    expect(cache.take(key)).toBeUndefined();
    expect(cache.take('other')?.cacheKey).toBe('tts_b');
    expect(cache.size).toBe(0);
  });
});

describe('buildHostedTTSWarmupRequests', () => {
  it('builds bounded raw-text-free cache resolve requests for hosted voices', () => {
    const secondParagraph: Paragraph = {
      ...paragraph,
      id: 'paragraph_2',
      index: 1,
      text: '다시 말했다. "좋아."',
      endOffsetInChapter: 14,
      textHash: 'paragraph_2_hash',
    };

    const requests = buildHostedTTSWarmupRequests({
      chapterId: 'chapter_1',
      paragraphs: [secondParagraph, paragraph],
      segments: [
        segment(),
        segment({
          id: 'seg_2',
          paragraphId: secondParagraph.id,
          segmentIndex: 1,
          startOffset: 7,
          endOffset: 13,
          segmentTextHash: 'segment_2_hash',
        }),
      ],
      characters: [],
      voiceProfiles: [voiceProfile()],
      baseRate: 1,
      maxRequests: 1,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        paragraphIndex: 0,
        speakerLabel: 'char_1',
        requestKey: expect.stringMatching(/^hosted_tts_/),
      }),
    );
    expect(requests[0].request).toEqual(
      expect.objectContaining({
        providerId: 'openai-tts',
        voiceProfileId: 'voice_openai_char_1',
        segmentIds: ['seg_1'],
      }),
    );
    expect(JSON.stringify(requests)).not.toContain(paragraph.text);
    expect(JSON.stringify(requests)).not.toContain(secondParagraph.text);
  });

  it('builds bounded cache resolve requests across nearby chapters in order', () => {
    const firstChapterParagraph: Paragraph = {
      ...paragraph,
      id: 'chapter_1_p1',
      chapterId: 'chapter_1',
      text: 'He said, "Hi."',
      endOffsetInChapter: 14,
      textHash: 'chapter_1_p1_hash',
    };
    const secondChapterParagraph: Paragraph = {
      ...paragraph,
      id: 'chapter_2_p1',
      chapterId: 'chapter_2',
      text: 'She said, "Go."',
      endOffsetInChapter: 15,
      textHash: 'chapter_2_p1_hash',
    };
    const thirdChapterParagraph: Paragraph = {
      ...paragraph,
      id: 'chapter_3_p1',
      chapterId: 'chapter_3',
      text: 'They said, "Run."',
      endOffsetInChapter: 17,
      textHash: 'chapter_3_p1_hash',
    };

    const requests = buildHostedTTSBulkWarmupRequests({
      chapters: [
        {
          chapterId: 'chapter_1',
          paragraphs: [firstChapterParagraph],
          segments: [
            segment({
              id: 'chapter_1_seg_1',
              chapterId: 'chapter_1',
              paragraphId: firstChapterParagraph.id,
              startOffset: 9,
              endOffset: 14,
              segmentTextHash: 'chapter_1_seg_1_hash',
            }),
          ],
        },
        {
          chapterId: 'chapter_2',
          paragraphs: [secondChapterParagraph],
          segments: [
            segment({
              id: 'chapter_2_seg_1',
              chapterId: 'chapter_2',
              paragraphId: secondChapterParagraph.id,
              startOffset: 10,
              endOffset: 15,
              segmentTextHash: 'chapter_2_seg_1_hash',
            }),
          ],
        },
        {
          chapterId: 'chapter_3',
          paragraphs: [thirdChapterParagraph],
          segments: [
            segment({
              id: 'chapter_3_seg_1',
              chapterId: 'chapter_3',
              paragraphId: thirdChapterParagraph.id,
              startOffset: 11,
              endOffset: 17,
              segmentTextHash: 'chapter_3_seg_1_hash',
            }),
          ],
        },
      ],
      characters: [],
      voiceProfiles: [voiceProfile()],
      baseRate: 1,
      maxRequests: 2,
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.chapterId)).toEqual(['chapter_1', 'chapter_2']);
    expect(requests.map((request) => request.paragraphId)).toEqual(['chapter_1_p1', 'chapter_2_p1']);
    expect(requests[0].request.segmentIds).toEqual(['chapter_1_seg_1']);
    expect(requests[1].request.segmentIds).toEqual(['chapter_2_seg_1']);
    expect(JSON.stringify(requests)).not.toContain(firstChapterParagraph.text);
    expect(JSON.stringify(requests)).not.toContain(secondChapterParagraph.text);
    expect(JSON.stringify(requests)).not.toContain(thirdChapterParagraph.text);
  });

  it('can build unbounded cache resolve requests for whole-book background warmup', () => {
    const chapterSources = [1, 2, 3].map((chapterNumber) => {
      const chapterId = `chapter_${chapterNumber}`;
      const chapterParagraph: Paragraph = {
        ...paragraph,
        id: `${chapterId}_p1`,
        chapterId,
        text: `Chapter ${chapterNumber} said, "Go."`,
        endOffsetInChapter: 21,
        textHash: `${chapterId}_paragraph_hash`,
      };
      return {
        chapterId,
        paragraphs: [chapterParagraph],
        segments: [
          segment({
            id: `${chapterId}_seg_1`,
            chapterId,
            paragraphId: chapterParagraph.id,
            startOffset: 16,
            endOffset: 21,
            segmentTextHash: `${chapterId}_segment_hash`,
          }),
        ],
      };
    });

    const requests = buildHostedTTSBulkWarmupRequests({
      chapters: chapterSources,
      characters: [],
      voiceProfiles: [voiceProfile()],
      baseRate: 1,
      maxRequests: Number.POSITIVE_INFINITY,
    });

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.chapterId)).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);
    expect(JSON.stringify(requests)).not.toContain('Chapter 1 said');
    expect(JSON.stringify(requests)).not.toContain('Chapter 2 said');
    expect(JSON.stringify(requests)).not.toContain('Chapter 3 said');
  });

  it('ignores paragraphs and segments that do not belong to the warmup chapter', () => {
    const wrongChapterParagraph: Paragraph = {
      ...paragraph,
      chapterId: 'chapter_2',
      text: 'Wrong chapter said, "No."',
      endOffsetInChapter: 25,
      textHash: 'wrong_chapter_hash',
    };

    const requests = buildHostedTTSWarmupRequests({
      chapterId: 'chapter_1',
      paragraphs: [wrongChapterParagraph],
      segments: [
        segment({
          chapterId: 'chapter_2',
          paragraphId: wrongChapterParagraph.id,
          startOffset: 20,
          endOffset: 25,
          segmentTextHash: 'wrong_chapter_segment_hash',
        }),
      ],
      characters: [],
      voiceProfiles: [voiceProfile()],
      baseRate: 1,
      maxRequests: 4,
    });

    expect(requests).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain(wrongChapterParagraph.text);
  });
});
