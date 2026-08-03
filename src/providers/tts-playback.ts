import type { Character, LabeledSegment, Paragraph, SegmentType, VoiceProfile } from '../domain/types';
import type { AcceptedSpeakerProvenanceV1 } from './speaker-attribution/accepted-speaker-provenance';
import type { TtsVoiceBindingV1, VoiceTierV1 } from './voice-casting';
import { clamp } from '../utils/format';
import { projectSpokenText } from '@noveldesk/text-core/spoken-text';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpokenTextProjectionSpan, SpokenTextRule } from '../domain/types';

export interface PlayableTtsSegment {
  readonly paragraphId: string;
  readonly text: string;
  readonly language?: string;
  readonly sourceText?: string;
  readonly spokenTextFingerprint?: string;
  readonly spokenTextSpans?: readonly SpokenTextProjectionSpan[];
  readonly speakerId: string;
  readonly speakerLabel: string;
  readonly speakerEntityId?: string;
  readonly speakerProvenanceId?: string;
  readonly speakerSceneId?: string;
  readonly dialogueBurstId?: string;
  readonly narrativeOrder?: number;
  readonly readerStateSnapshotId?: string;
  readonly dialogueSequenceDecisionId?: string;
  readonly voiceIdentityId?: string;
  readonly voiceTier?: VoiceTierV1;
  readonly voicePoolKey?: string;
  readonly voiceAssignmentRevision?: string;
  readonly emotion: string;
  readonly contentType?: SegmentType;
  readonly tone?: string;
  readonly voiceProfileId?: string;
  readonly voiceURI?: string;
  readonly rate: number;
  readonly confidence?: number;
  readonly prosodyIntent?: LabeledSegment['prosodyIntent'];
  readonly sourceSegmentIds: string[];
  readonly sourceRanges: PlayableTtsSegmentRange[];
}

export interface PlayableTtsSegmentRange {
  readonly segmentId: string;
  readonly paragraphId: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface BuildPlayableTtsSegmentsInput {
  readonly paragraph: Paragraph;
  readonly segments: LabeledSegment[];
  readonly characters: Character[];
  readonly voiceProfiles: VoiceProfile[];
  readonly fallbackVoiceURI?: string;
  readonly baseRate: number;
  readonly acceptedSpeakerProvenance?: readonly AcceptedSpeakerProvenanceV1[];
  readonly voiceBindings?: readonly TtsVoiceBindingV1[];
  readonly language?: string;
  readonly spokenTextRules?: readonly SpokenTextRule[];
  readonly rubyPolicy?: 'base' | 'reading';
  readonly footnotePolicy?: 'skip_marker' | 'read_marker';
}

const roleSpeakerIds = new Set(['narrator', 'system', 'unknown']);

function roleForSpeaker(speakerId: string): VoiceProfile['role'] {
  if (speakerId === 'narrator') return 'narrator';
  if (speakerId === 'system') return 'system';
  if (speakerId === 'unknown') return 'unknown';
  return 'character';
}

function speakerLabel(speakerId: string, characters: Character[]): string {
  if (speakerId === 'narrator') return '내레이터';
  if (speakerId === 'system') return '시스템';
  if (speakerId === 'unknown') return '화자 미정';
  return characters.find((character) => character.id === speakerId)?.canonicalName ?? speakerId;
}

function voiceProfileForSegment(
  segment: Pick<LabeledSegment, 'speakerId' | 'voiceProfileId'>,
  voiceProfiles: VoiceProfile[],
  binding?: TtsVoiceBindingV1,
): VoiceProfile | undefined {
  if (segment.voiceProfileId) {
    const explicit = voiceProfiles.find((profile) => profile.id === segment.voiceProfileId);
    if (explicit?.isUserSelected) return explicit;
  }
  if (!roleSpeakerIds.has(segment.speakerId)) {
    const userProfile = voiceProfiles.find(
      (profile) => profile.role === 'character' && profile.characterId === segment.speakerId && profile.isUserSelected,
    );
    if (userProfile) return userProfile;
  }
  if (binding) {
    const assigned = voiceProfiles.find((profile) => profile.id === binding.voiceProfileId);
    if (assigned) return assigned;
  }
  if (segment.voiceProfileId) {
    const legacy = voiceProfiles.find((profile) => profile.id === segment.voiceProfileId);
    if (legacy) return legacy;
  }
  if (!roleSpeakerIds.has(segment.speakerId)) {
    const characterProfile = voiceProfiles.find(
      (profile) => profile.role === 'character' && profile.characterId === segment.speakerId,
    );
    if (characterProfile) return characterProfile;
  }
  const role = roleForSpeaker(segment.speakerId);
  return voiceProfiles.find(
    (profile) => profile.role === role && !profile.characterId && !profile.id.startsWith('voice_pool_profile_'),
  );
}

function voiceUriForProfile(
  profile: VoiceProfile | undefined,
  fallbackVoiceURI: string | undefined,
): string | undefined {
  if (!profile) return fallbackVoiceURI;
  return profile.providerId === 'system' ? profile.providerVoiceId : fallbackVoiceURI;
}

function rateForProfile(profile: VoiceProfile | undefined, baseRate: number): number {
  return clamp(baseRate * (profile?.speed ?? 1), 0.25, 4);
}

function appendPlayableSegment(list: PlayableTtsSegment[], next: PlayableTtsSegment): void {
  const previous = list[list.length - 1];
  if (
    previous &&
    previous.sourceSegmentIds.length === 0 &&
    next.sourceSegmentIds.length === 0 &&
    previous.speakerId === next.speakerId &&
    previous.voiceURI === next.voiceURI &&
    previous.voiceProfileId === next.voiceProfileId &&
    previous.voiceIdentityId === next.voiceIdentityId &&
    previous.voiceAssignmentRevision === next.voiceAssignmentRevision &&
    previous.language === next.language &&
    previous.rate === next.rate &&
    previous.emotion === next.emotion &&
    previous.contentType === next.contentType &&
    previous.tone === next.tone
  ) {
    list[list.length - 1] = {
      ...previous,
      text: `${previous.text}\n${next.text}`,
      sourceText: `${previous.sourceText ?? previous.text}\n${next.sourceText ?? next.text}`,
      spokenTextFingerprint: structuredIntegrityHash({
        version: 'spoken-text-merge-v1',
        items: [previous.spokenTextFingerprint ?? '', next.spokenTextFingerprint ?? ''],
      }),
      spokenTextSpans: [
        ...(previous.spokenTextSpans ?? []),
        ...(next.spokenTextSpans ?? []).map((span) => ({
          ...span,
          spokenStart: span.spokenStart + previous.text.length + 1,
          spokenEnd: span.spokenEnd + previous.text.length + 1,
        })),
      ],
      sourceSegmentIds: [...previous.sourceSegmentIds, ...next.sourceSegmentIds],
      sourceRanges: [...previous.sourceRanges, ...next.sourceRanges],
    };
    return;
  }
  list.push(next);
}

function semanticLanguageSlices(
  paragraph: Paragraph,
  range: PlayableTtsSegmentRange,
  fallbackLanguage?: string,
): Array<{ start: number; end: number; language?: string }> {
  const semantics = (paragraph.inlineSemantics ?? []).filter(
    (semantic) =>
      semantic.kind === 'language' &&
      semantic.value &&
      semantic.end > range.startOffset &&
      semantic.start < range.endOffset,
  );
  if (semantics.length === 0) return [{ start: range.startOffset, end: range.endOffset, language: fallbackLanguage }];
  const boundaries = new Set([range.startOffset, range.endOffset]);
  for (const semantic of semantics) {
    boundaries.add(Math.max(range.startOffset, semantic.start));
    boundaries.add(Math.min(range.endOffset, semantic.end));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]!;
    const language = semantics
      .filter((semantic) => semantic.start <= start && semantic.end >= end)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0]?.value;
    return { start, end, language: language ?? fallbackLanguage };
  });
}

function splitPlayableBySemanticLanguage(
  input: BuildPlayableTtsSegmentsInput,
  playable: readonly PlayableTtsSegment[],
): PlayableTtsSegment[] {
  if (!(input.paragraph.inlineSemantics ?? []).some((semantic) => semantic.kind === 'language' && semantic.value)) {
    return [...playable];
  }
  const output: PlayableTtsSegment[] = [];
  for (const item of playable) {
    if (item.sourceRanges.length === 0) {
      output.push(item);
      continue;
    }
    for (const sourceRange of item.sourceRanges) {
      for (const slice of semanticLanguageSlices(input.paragraph, sourceRange, input.language)) {
        const sourceText = input.paragraph.text.slice(slice.start, slice.end);
        if (!sourceText.trim()) continue;
        const projection = projectSpokenText({
          text: sourceText,
          language: slice.language,
          sourceOffset: slice.start,
          semantics: input.paragraph.inlineSemantics,
          rules: input.spokenTextRules,
          rubyPolicy: input.rubyPolicy,
          footnotePolicy: input.footnotePolicy,
        });
        if (!projection.spokenText) continue;
        output.push({
          ...item,
          text: projection.spokenText,
          language: projection.language,
          sourceText: sourceText.trim(),
          spokenTextFingerprint: projection.fingerprint,
          spokenTextSpans: projection.spans,
          sourceSegmentIds: sourceRange.segmentId ? [sourceRange.segmentId] : [],
          sourceRanges: [{ ...sourceRange, startOffset: slice.start, endOffset: slice.end }],
        });
      }
    }
  }
  return output;
}

function playableFromText(
  paragraph: Paragraph,
  text: string,
  segment: Pick<LabeledSegment, 'id' | 'speakerId' | 'voiceProfileId' | 'emotion'> &
    Partial<Pick<LabeledSegment, 'type'>> &
    Partial<Pick<LabeledSegment, 'confidence' | 'prosodyIntent'>>,
  input: BuildPlayableTtsSegmentsInput,
  sourceRange?: PlayableTtsSegmentRange,
): PlayableTtsSegment | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const leading = text.length - text.trimStart().length;
  const projection = projectSpokenText({
    text: trimmed,
    language: input.language,
    sourceOffset: (sourceRange?.startOffset ?? 0) + leading,
    semantics: input.paragraph.inlineSemantics,
    rules: input.spokenTextRules,
    rubyPolicy: input.rubyPolicy,
    footnotePolicy: input.footnotePolicy,
  });
  if (!projection.spokenText) return undefined;
  const provenance = input.acceptedSpeakerProvenance?.find(
    (row) => row.status === 'active' && row.segmentId === segment.id && row.canonicalSpeakerId === segment.speakerId,
  );
  const hasStoredProvenance = input.acceptedSpeakerProvenance?.some((row) => row.segmentId === segment.id) ?? false;
  const binding = input.voiceBindings?.find(
    (row) =>
      row.segmentId === segment.id &&
      (!hasStoredProvenance || (provenance !== undefined && row.acceptedProvenanceId === provenance.id)) &&
      row.paragraphId === paragraph.id,
  );
  const profile = voiceProfileForSegment(segment, input.voiceProfiles, binding);
  const appliedBinding = profile?.id === binding?.voiceProfileId ? binding : undefined;
  return {
    paragraphId: paragraph.id,
    text: projection.spokenText,
    sourceText: trimmed,
    spokenTextFingerprint: projection.fingerprint,
    spokenTextSpans: projection.spans,
    speakerId: segment.speakerId,
    speakerLabel: speakerLabel(segment.speakerId, input.characters),
    speakerEntityId: appliedBinding?.speakerEntityId ?? provenance?.speakerEntityId,
    speakerProvenanceId: appliedBinding?.acceptedProvenanceId ?? provenance?.id,
    speakerSceneId: appliedBinding?.sceneId ?? provenance?.sceneId,
    dialogueBurstId: appliedBinding?.dialogueBurstId ?? provenance?.dialogueBurstId,
    narrativeOrder: appliedBinding?.narrativeOrder ?? provenance?.narrativeOrder,
    readerStateSnapshotId: appliedBinding?.readerStateSnapshotId ?? provenance?.temporalSnapshotId,
    dialogueSequenceDecisionId: appliedBinding?.dialogueSequenceDecisionId ?? provenance?.sequenceDecisionId,
    voiceIdentityId: appliedBinding?.voiceIdentityId,
    voiceTier: appliedBinding?.voiceTier,
    voicePoolKey: appliedBinding?.voicePoolKey,
    voiceAssignmentRevision: appliedBinding?.voiceAssignmentRevision,
    emotion: segment.emotion || 'neutral',
    contentType: segment.type ?? 'narration',
    tone: profile?.tone,
    voiceProfileId: profile?.id,
    voiceURI: voiceUriForProfile(profile, input.fallbackVoiceURI),
    rate: rateForProfile(profile, input.baseRate),
    confidence: segment.confidence ?? 1,
    prosodyIntent: segment.prosodyIntent,
    sourceSegmentIds: [segment.id].filter(Boolean),
    sourceRanges: sourceRange ? [sourceRange] : [],
  };
}

export function buildPlayableTtsSegments(input: BuildPlayableTtsSegmentsInput): PlayableTtsSegment[] {
  const paragraphSegments = input.segments
    .filter((segment) => segment.paragraphId === input.paragraph.id)
    .filter(
      (segment) =>
        Number.isInteger(segment.startOffset) &&
        Number.isInteger(segment.endOffset) &&
        segment.startOffset >= 0 &&
        segment.endOffset > segment.startOffset &&
        segment.endOffset <= input.paragraph.text.length,
    )
    .sort((a, b) => a.startOffset - b.startOffset || a.segmentIndex - b.segmentIndex);

  if (!paragraphSegments.length) {
    const fallback = playableFromText(
      input.paragraph,
      input.paragraph.text,
      { id: '', speakerId: 'narrator', voiceProfileId: undefined, emotion: 'neutral', type: 'narration' },
      input,
      {
        segmentId: '',
        paragraphId: input.paragraph.id,
        startOffset: 0,
        endOffset: input.paragraph.text.length,
      },
    );
    return fallback ? splitPlayableBySemanticLanguage(input, [fallback]) : [];
  }

  const playable: PlayableTtsSegment[] = [];
  let cursor = 0;
  for (const segment of paragraphSegments) {
    if (segment.endOffset <= cursor) continue;
    if (segment.startOffset > cursor) {
      const gap = playableFromText(
        input.paragraph,
        input.paragraph.text.slice(cursor, segment.startOffset),
        { id: '', speakerId: 'narrator', voiceProfileId: undefined, emotion: 'neutral', type: 'narration' },
        input,
        {
          segmentId: '',
          paragraphId: input.paragraph.id,
          startOffset: cursor,
          endOffset: segment.startOffset,
        },
      );
      if (gap) appendPlayableSegment(playable, gap);
    }
    const startOffset = Math.max(segment.startOffset, cursor);
    const next = playableFromText(
      input.paragraph,
      input.paragraph.text.slice(startOffset, segment.endOffset),
      segment,
      input,
      {
        segmentId: segment.id,
        paragraphId: segment.paragraphId,
        startOffset,
        endOffset: segment.endOffset,
      },
    );
    if (next) appendPlayableSegment(playable, next);
    cursor = Math.max(cursor, segment.endOffset);
  }

  if (cursor < input.paragraph.text.length) {
    const trailing = playableFromText(
      input.paragraph,
      input.paragraph.text.slice(cursor),
      { id: '', speakerId: 'narrator', voiceProfileId: undefined, emotion: 'neutral', type: 'narration' },
      input,
      {
        segmentId: '',
        paragraphId: input.paragraph.id,
        startOffset: cursor,
        endOffset: input.paragraph.text.length,
      },
    );
    if (trailing) appendPlayableSegment(playable, trailing);
  }

  return splitPlayableBySemanticLanguage(input, playable);
}
