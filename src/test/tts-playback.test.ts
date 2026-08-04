import { describe, expect, it } from 'vitest';
import type { Character, LabeledSegment, Paragraph, VoiceProfile } from '../domain/types';
import { buildPlayableTtsSegments } from '../providers/tts-playback';
import { planTTSParagraphSentences } from '../providers/tts-sentence-planner';
import { buildSystemTTSFallbackInput } from '../providers/tts-playback-session';
import { createAcceptedSpeakerProvenance } from '../providers/speaker-attribution/accepted-speaker-provenance';

const paragraph: Paragraph = {
  id: 'paragraph_1',
  novelId: 'book_1',
  chapterId: 'chapter_1',
  index: 1,
  text: '그는 말했다. "안녕." 그리고 웃었다.',
  startOffsetInChapter: 0,
  endOffsetInChapter: 22,
  textHash: 'paragraph_hash',
};

const character: Character = {
  id: 'char_1',
  novelId: 'book_1',
  canonicalName: '강현우',
  aliases: ['현우'],
  color: '#3b82f6',
  confidence: 0.9,
  isUserConfirmed: true,
};

function segment(overrides: Partial<LabeledSegment>): LabeledSegment {
  return {
    id: 'seg_1',
    novelId: 'book_1',
    chapterId: 'chapter_1',
    paragraphId: 'paragraph_1',
    segmentIndex: 0,
    startOffset: 8,
    endOffset: 14,
    segmentTextHash: 'segment_hash',
    type: 'quoted_dialogue',
    speakerId: 'char_1',
    candidateSpeakers: ['char_1'],
    listenerIds: [],
    emotion: 'calm',
    confidence: 0.95,
    isUserCorrected: false,
    ...overrides,
  };
}

function voiceProfile(overrides: Partial<VoiceProfile>): VoiceProfile {
  return {
    id: 'voice_char_1',
    novelId: 'book_1',
    characterId: 'char_1',
    role: 'character',
    providerId: 'system',
    providerVoiceId: 'voice-ko-character',
    label: '강현우 음성',
    speed: 1.1,
    providerOptions: {},
    isUserSelected: true,
    ...overrides,
  };
}

describe('buildPlayableTtsSegments', () => {
  it('splits EPUB language spans and selects a matching system fallback voice', () => {
    const mixedParagraph: Paragraph = {
      ...paragraph,
      text: '가격은 12%. Price is 12%.',
      endOffsetInChapter: 24,
      inlineSemantics: [{ start: 9, end: 24, kind: 'language', value: 'en-US' }],
    };
    const profiles = [
      voiceProfile({
        id: 'voice-narrator-ko',
        role: 'narrator',
        characterId: undefined,
        providerVoiceId: 'voice-ko',
        language: 'ko-KR',
      }),
      voiceProfile({
        id: 'voice-narrator-en',
        role: 'narrator',
        characterId: undefined,
        providerVoiceId: 'voice-en',
        language: 'en-US',
      }),
    ];
    const result = buildPlayableTtsSegments({
      paragraph: mixedParagraph,
      segments: [],
      characters: [],
      voiceProfiles: profiles,
      baseRate: 1,
      language: 'ko-KR',
    });

    expect(result.map((item) => ({ language: item.language, text: item.text }))).toEqual([
      { language: 'ko-KR', text: '가격은 십이 퍼센트.' },
      { language: 'en-US', text: 'Price is 12 percent.' },
    ]);
    expect(
      buildSystemTTSFallbackInput({
        playable: result[1]!,
        systemVoiceProfiles: profiles,
        baseRate: 1,
      }).voiceURI,
    ).toBe('voice-en');
  });

  it('keeps normalized spoken text when splitting a paragraph into sentences', () => {
    const datedParagraph: Paragraph = {
      ...paragraph,
      text: '2026-08-01. 다음 문장.',
      endOffsetInChapter: 19,
    };
    const playable = buildPlayableTtsSegments({
      paragraph: datedParagraph,
      segments: [],
      characters: [],
      voiceProfiles: [],
      baseRate: 1,
      language: 'ko-KR',
    });
    const planned = planTTSParagraphSentences(datedParagraph, playable);

    expect(planned[0]?.text).toContain('이천이십육년');
    expect(planned[0]?.text).not.toContain('2026');
    expect(planned[0]?.sourceRanges[0]).toMatchObject({ startOffset: 0, endOffset: 12 });
  });

  it('falls back to narrator playback when no labels exist', () => {
    expect(
      buildPlayableTtsSegments({
        paragraph,
        segments: [],
        characters: [character],
        voiceProfiles: [
          voiceProfile({
            id: 'voice_narrator',
            role: 'narrator',
            characterId: undefined,
            providerVoiceId: 'voice-ko-narrator',
          }),
        ],
        fallbackVoiceURI: 'voice-default',
        baseRate: 1,
      }),
    ).toEqual([
      expect.objectContaining({
        text: paragraph.text,
        speakerId: 'narrator',
        voiceURI: 'voice-ko-narrator',
      }),
    ]);
  });

  it('uses character voice profiles and preserves unlabeled gaps as narration', () => {
    const result = buildPlayableTtsSegments({
      paragraph,
      segments: [segment({})],
      characters: [character],
      voiceProfiles: [
        voiceProfile({}),
        voiceProfile({
          id: 'voice_narrator',
          role: 'narrator',
          characterId: undefined,
          providerVoiceId: 'voice-ko-narrator',
          speed: 1,
        }),
      ],
      fallbackVoiceURI: 'voice-default',
      baseRate: 1,
    });

    expect(
      result.map((item) => ({
        text: item.text,
        speakerId: item.speakerId,
        speakerLabel: item.speakerLabel,
        voiceURI: item.voiceURI,
        rate: item.rate,
      })),
    ).toEqual([
      { text: '그는 말했다.', speakerId: 'narrator', speakerLabel: '내레이터', voiceURI: 'voice-ko-narrator', rate: 1 },
      { text: '"안녕."', speakerId: 'char_1', speakerLabel: '강현우', voiceURI: 'voice-ko-character', rate: 1.1 },
      {
        text: '그리고 웃었다.',
        speakerId: 'narrator',
        speakerLabel: '내레이터',
        voiceURI: 'voice-ko-narrator',
        rate: 1,
      },
    ]);
  });

  it('ignores invalid offsets instead of sending corrupted text to TTS', () => {
    const result = buildPlayableTtsSegments({
      paragraph,
      segments: [segment({ startOffset: 100, endOffset: 110 })],
      characters: [character],
      voiceProfiles: [voiceProfile({})],
      fallbackVoiceURI: 'voice-default',
      baseRate: 1,
    });

    expect(result).toEqual([
      expect.objectContaining({
        text: paragraph.text,
        speakerId: 'narrator',
        voiceURI: 'voice-default',
      }),
    ]);
  });

  it('clips overlapping labels so already-spoken text is not duplicated and records clipped source ranges', () => {
    const result = buildPlayableTtsSegments({
      paragraph,
      segments: [
        segment({ id: 'seg_first', startOffset: 0, endOffset: 14, speakerId: 'narrator', emotion: 'neutral' }),
        segment({ id: 'seg_second', startOffset: 8, endOffset: 22, speakerId: 'char_1' }),
      ],
      characters: [character],
      voiceProfiles: [voiceProfile({})],
      fallbackVoiceURI: 'voice-default',
      baseRate: 1,
    });

    expect(result.map((item) => ({ text: item.text, speakerId: item.speakerId }))).toEqual([
      { text: '그는 말했다. "안녕."', speakerId: 'narrator' },
      { text: '그리고 웃었다.', speakerId: 'char_1' },
    ]);
    expect(result[1].sourceRanges).toEqual([
      {
        segmentId: 'seg_second',
        paragraphId: 'paragraph_1',
        startOffset: 14,
        endOffset: 22,
      },
    ]);
  });

  it('carries accepted speaker entity provenance into the canonical playback item', () => {
    const provenance = createAcceptedSpeakerProvenance(
      {
        bookId: 'book_1',
        contentRevisionId: 'revision_1',
        chapterId: 'chapter_1',
        paragraphId: 'paragraph_1',
        segmentId: 'seg_1',
        sourceSpanId: 'span_1',
        sceneId: 'scene_1',
        dialogueBurstId: 'burst_1',
        narrativeOrder: 1_000_004,
        speakerEntityId: 'speaker_entity_char_1',
        canonicalSpeakerId: 'char_1',
        resolutionKind: 'provider_candidate',
        sourceManifestFingerprint: 'manifest_1',
        packetFingerprint: 'packet_1',
        temporalSnapshotId: 'snapshot_1',
        sequenceDecisionId: 'sequence_1',
        confidence: 0.95,
      },
      'artifact_1',
      '2026-07-13T00:00:00.000Z',
    );
    const result = buildPlayableTtsSegments({
      paragraph,
      segments: [segment({})],
      characters: [character],
      voiceProfiles: [voiceProfile({})],
      fallbackVoiceURI: 'voice-default',
      baseRate: 1,
      acceptedSpeakerProvenance: [provenance],
    });

    expect(result.find((item) => item.sourceSegmentIds.includes('seg_1'))).toMatchObject({
      speakerId: 'char_1',
      speakerEntityId: 'speaker_entity_char_1',
      speakerProvenanceId: provenance.id,
      speakerSceneId: 'scene_1',
      dialogueBurstId: 'burst_1',
      narrativeOrder: 1_000_004,
      readerStateSnapshotId: 'snapshot_1',
      dialogueSequenceDecisionId: 'sequence_1',
    });
  });
});
