import type { Character, LabeledSegment } from '../../domain/types';

export function speakerIdLabel(speakerId: string, characters: readonly Character[] = []): string {
  if (speakerId === 'narrator') return '내레이터';
  if (speakerId === 'system') return '시스템';
  if (speakerId === 'unknown') return '화자 미정';
  return characters.find((character) => character.id === speakerId)?.canonicalName ?? speakerId;
}

export function speakerLabel(segment?: LabeledSegment, characters: readonly Character[] = []): string {
  return segment ? speakerIdLabel(segment.speakerId, characters) : '';
}
