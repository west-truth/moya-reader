import type {
  Bookmark,
  Character,
  LabeledSegment,
  ReaderHighlight,
  ReaderNote,
  UserCorrection,
  VoiceProfile,
} from './types';
import {
  resourceCollectionRevision,
  resourceEntityRevision,
  resourceGraphRevision,
  userCorrectionResourceRevision,
  voiceProfilesResourceRevision,
} from './identity/sync-identities';

export interface ResourceMutationOptions {
  readonly expectedRevision: string;
}

export class ResourceRevisionConflictError extends Error {
  constructor(
    public readonly resourceKind: string,
    public readonly expectedRevision: string,
    public readonly actualRevision: string,
  ) {
    super(`Resource ${resourceKind} changed after it was read.`);
    this.name = 'ResourceRevisionConflictError';
  }
}

export function assertResourceRevision(resourceKind: string, expectedRevision: string, actualRevision: string): void {
  if (expectedRevision !== actualRevision) {
    throw new ResourceRevisionConflictError(resourceKind, expectedRevision, actualRevision);
  }
}

export const characterGraphRevision = (characters: readonly Character[], relations: readonly { id: string }[]) =>
  resourceGraphRevision('character_graph', characters, relations);

export const chapterSegmentsRevision = (segments: readonly LabeledSegment[]) =>
  resourceCollectionRevision('chapter_segments', segments);

export const correctionsRevision = (corrections: readonly UserCorrection[]) =>
  resourceCollectionRevision('user_corrections', corrections);

export const voiceProfilesRevision = (profiles: readonly VoiceProfile[]) => voiceProfilesResourceRevision(profiles);

export const bookmarkRevision = (bookmark?: Bookmark) => resourceEntityRevision('bookmark', bookmark);
export const highlightRevision = (highlight?: ReaderHighlight) => resourceEntityRevision('highlight', highlight);
export const noteRevision = (note?: ReaderNote) => resourceEntityRevision('note', note);
export const correctionRevision = (correction?: UserCorrection) => userCorrectionResourceRevision(correction);
