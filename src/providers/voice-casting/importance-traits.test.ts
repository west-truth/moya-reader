import { describe, expect, it } from 'vitest';
import { createAcceptedSpeakerProvenance } from '../speaker-attribution/accepted-speaker-provenance';
import {
  aggregateCharacterImportance,
  computeVoiceTraitProfiles,
  createVoiceTraitEvidence,
  projectAcceptedSpeakerUtterance,
  projectVoiceTraitMicroPassCandidates,
} from './index';

function accepted(segmentId: string, narrativeOrder: number, speakerEntityId?: string) {
  return createAcceptedSpeakerProvenance(
    {
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      chapterId: 'chapter-1',
      paragraphId: `paragraph-${segmentId}`,
      segmentId,
      sourceSpanId: `span-${segmentId}`,
      sceneId: 'scene-1',
      dialogueBurstId: 'burst-1',
      narrativeOrder,
      speakerEntityId,
      canonicalSpeakerId: speakerEntityId ?? 'unknown',
      resolutionKind: speakerEntityId ? 'deterministic' : 'unresolved',
      sourceManifestFingerprint: 'manifest-1',
      confidence: speakerEntityId ? 0.9 : 0.2,
    },
    'artifact-1',
    '2026-07-13T00:00:00.000Z',
  );
}

describe('voice casting importance and traits', () => {
  it('does not merge distinct accepted canonical unknown utterances', () => {
    const utterances = [accepted('segment-a', 1), accepted('segment-b', 2)].map((provenance) =>
      projectAcceptedSpeakerUtterance({
        provenance,
        sourceStartOffset: 0,
        sourceEndOffset: 10,
        spokenCharacterCount: 10,
      }),
    );

    expect(utterances[0]!.speakerEntityId).not.toBe(utterances[1]!.speakerEntityId);
    const profiles = aggregateCharacterImportance({ utterances, mode: 'full_file' });
    expect(profiles).toHaveLength(2);
    expect(profiles.map((profile) => profile.utteranceCount)).toEqual([1, 1]);
  });

  it('excludes narrator and system roles while retaining canonical unknown entities', () => {
    const projected = [
      accepted('unknown', 1),
      accepted('narrator', 2, 'narrator'),
      accepted('system', 3, 'system'),
    ].map((provenance) =>
      projectAcceptedSpeakerUtterance({
        provenance,
        sourceStartOffset: 0,
        sourceEndOffset: 5,
        spokenCharacterCount: 5,
      }),
    );

    const profiles = aggregateCharacterImportance({ utterances: projected, mode: 'full_file' });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.speakerEntityId).toMatch(/^unknown:/);
  });

  it('keeps name-only evidence unknown and outside the micro-pass projection', () => {
    const utterance = projectAcceptedSpeakerUtterance({
      provenance: accepted('segment-a', 1, 'speaker-a'),
      sourceStartOffset: 0,
      sourceEndOffset: 8,
      spokenCharacterCount: 8,
    });
    const importanceProfiles = aggregateCharacterImportance({ utterances: [utterance], mode: 'full_file' });
    const evidence = createVoiceTraitEvidence({
      bookId: 'book-1',
      contentRevisionId: 'content-1',
      speakerEntityId: 'speaker-a',
      sceneId: 'scene-1',
      narrativeOrder: 1,
      evidenceSpanId: 'name-span',
      evidenceKind: 'name_only',
      proposedTraits: { genderPresentation: 'feminine', ageBand: 'young_adult' },
      confidence: 0.99,
      status: 'active',
      userPinned: false,
    });
    const profiles = computeVoiceTraitProfiles({ importanceProfiles, evidence: [evidence] });

    expect(profiles[0]).toMatchObject({
      genderPresentation: 'unknown',
      ageBand: 'unknown',
      vocalWeight: 'unknown',
      registerDefault: 'unknown',
      confidence: 0,
      evidenceSpanIds: [],
    });
    expect(projectVoiceTraitMicroPassCandidates({ profiles, evidence: [evidence] })).toEqual([]);
  });

  it('projects only bounded ambiguous source evidence to the micro-pass', () => {
    const utterance = projectAcceptedSpeakerUtterance({
      provenance: accepted('segment-a', 1, 'speaker-a'),
      sourceStartOffset: 0,
      sourceEndOffset: 8,
      spokenCharacterCount: 8,
    });
    const importanceProfiles = aggregateCharacterImportance({ utterances: [utterance], mode: 'full_file' });
    const evidence = ['feminine', 'masculine', 'feminine', 'masculine', 'feminine', 'masculine', 'feminine'].map(
      (genderPresentation, index) =>
        createVoiceTraitEvidence({
          bookId: 'book-1',
          contentRevisionId: 'content-1',
          speakerEntityId: 'speaker-a',
          sceneId: 'scene-1',
          narrativeOrder: index + 1,
          evidenceSpanId: `source-span-${index}`,
          evidenceKind: 'source_rule',
          proposedTraits: { genderPresentation: genderPresentation as 'feminine' | 'masculine' },
          confidence: 0.7,
          status: 'active',
          userPinned: false,
        }),
    );
    const profiles = computeVoiceTraitProfiles({ importanceProfiles, evidence });
    const candidates = projectVoiceTraitMicroPassCandidates({ profiles, evidence });

    expect(profiles[0]!.genderPresentation).toBe('unknown');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceSpanIds).toHaveLength(6);
  });
});
