import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../domain/canonical-json';
import { hashSync } from '../domain/hash';
import { integrityHash, matchesIntegrityHash, persistentIdVersion } from '../domain/id-hash-contract';
import {
  candidateCharacterId,
  isReservedSpeakerId,
  labeledSegmentId,
  segmentTextIntegrityHash,
} from '../domain/identity/ai-identities';
import { providerSecretId, providerSettingsId } from '../domain/identity/provider-identities';
import { syncEventId } from '../domain/identity/sync-identities';
import { bookAIBundleId, bookAILabelWindowId, workflowSourceFingerprint } from '../domain/identity/workflow-identities';
import { planBookAIWorkflow } from '../providers/book-ai-workflow-plan';
import { chapterLabelingResponseToResult } from '../providers/chapter-labeling-contract';

describe('persistent identity factories', () => {
  it('separates the known FNV collision and isolates book and user scope', () => {
    expect(hashSync('costarring')).toBe(hashSync('liquid'));
    expect(candidateCharacterId('book_1', 'bundle_1', 'costarring')).not.toBe(
      candidateCharacterId('book_1', 'bundle_1', 'liquid'),
    );

    const segmentInput = {
      chapterId: 'chapter_1',
      paragraphId: 'paragraph_1',
      startOffset: 0,
      endOffset: 5,
      segmentTextHash: segmentTextIntegrityHash('hello'),
    };
    expect(labeledSegmentId({ novelId: 'book_1', ...segmentInput })).not.toBe(
      labeledSegmentId({ novelId: 'book_2', ...segmentInput }),
    );
    expect(providerSettingsId('user_1', 'tts_synthesis')).not.toBe(providerSettingsId('user_2', 'tts_synthesis'));
    expect(
      syncEventId({
        userId: 'user_1',
        type: 'book_updated',
        novelId: 'book_1',
        entityId: 'book_1',
        seed: 'revision_1',
      }),
    ).not.toBe(
      syncEventId({
        userId: 'user_2',
        type: 'book_updated',
        novelId: 'book_1',
        entityId: 'book_1',
        seed: 'revision_1',
      }),
    );
  });

  it('generates 100,000 unique deterministic v2 IDs', () => {
    const ids = new Set<string>();
    let firstId = '';
    let lastId = '';
    for (let index = 0; index < 100_000; index += 1) {
      const id = candidateCharacterId('book_scale', `bundle_${Math.floor(index / 100)}`, `candidate_${index}`);
      if (index === 0) firstId = id;
      lastId = id;
      ids.add(id);
    }
    expect(ids.size).toBe(100_000);
    expect(persistentIdVersion(firstId)).toBe('v2-sha256-128');
    expect(persistentIdVersion(lastId)).toBe('v2-sha256-128');
  }, 30_000);

  it('uses the same workflow tuple factories as the public planner', () => {
    const chapters = [
      {
        id: 'chapter_1',
        index: 0,
        title: 'One',
        characterCount: 5,
        paragraphCount: 1,
        textHash: integrityHash('hello'),
      },
    ];
    const paragraphs = [
      {
        id: 'paragraph_1',
        chapterId: 'chapter_1',
        index: 0,
        textHash: integrityHash('hello'),
        text: 'hello',
      },
    ];
    const plan = planBookAIWorkflow({ novelId: 'book_1', chapters, paragraphs });
    const bundleFingerprint = workflowSourceFingerprint([`chapter_1:${chapters[0].textHash}`]);
    const labelingFingerprint = workflowSourceFingerprint([`paragraph_1:${paragraphs[0].textHash}`]);

    expect(plan.bundleWindows[0].id).toBe(
      bookAIBundleId({
        novelId: 'book_1',
        startChapterIndex: 0,
        endChapterIndex: 0,
        sourceFingerprint: bundleFingerprint,
      }),
    );
    expect(plan.labelingWindows[0].id).toBe(
      bookAILabelWindowId({
        novelId: 'book_1',
        chapterId: 'chapter_1',
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        sourceFingerprint: labelingFingerprint,
      }),
    );
  });

  it('writes v2 segment hashes while validators can still prove legacy hashes', () => {
    const text = 'Hello';
    const chapter = {
      id: 'chapter_1',
      novelId: 'book_1',
      index: 0,
      title: 'One',
      normalizedText: text,
      textHash: integrityHash(text),
      rawStartOffset: 0,
      rawEndOffset: text.length,
      characterCount: text.length,
      paragraphCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const paragraphs = [
      {
        id: 'paragraph_1',
        novelId: 'book_1',
        chapterId: 'chapter_1',
        index: 0,
        text,
        startOffsetInChapter: 0,
        endOffsetInChapter: text.length,
        textHash: integrityHash(text),
      },
    ];
    const result = chapterLabelingResponseToResult(
      { novelId: 'book_1', chapter, paragraphs },
      {
        chapter_id: 'chapter_1',
        analysis_version: 2,
        segments: [
          {
            segment_id: 'provider_generated_id_is_not_persisted',
            paragraph_id: 'paragraph_1',
            start_offset: 0,
            end_offset: text.length,
            type: 'narration',
            speaker_id: 'narrator',
            candidate_speakers: [],
            listener_ids: [],
            emotion: 'neutral',
            confidence: 1,
            evidence: 'Narration.',
          },
        ],
      },
    );

    expect(result.segments[0].id).toMatch(/^segment_[0-9a-f]{32}$/);
    expect(result.segments[0].segmentTextHash).toBe(integrityHash(text));
    expect(matchesIntegrityHash(hashSync(text), text)).toBe(true);
    expect(matchesIntegrityHash(integrityHash(text).slice('sha256:'.length), text)).toBe(true);
  });

  it('keeps reserved speakers literal and excludes secret material from secret row IDs', () => {
    expect(['narrator', 'system', 'unknown'].every(isReservedSpeakerId)).toBe(true);
    const id = providerSecretId({
      userId: 'user_1',
      scope: 'llm_labeling',
      providerId: 'openai',
      secretName: 'api_key',
    });
    expect(id).toMatch(/^provider_secret_[0-9a-f]{32}$/);
    expect(id).not.toContain('sk-live-secret');
  });

  it('canonicalizes object key order for browser and server parity', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 } })).toBe(canonicalJson({ nested: { a: 1, b: 2 }, z: 1 }));
  });
});
