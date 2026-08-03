import { resolveChapterLabelingRequestProfile } from '../../../../../src/providers/chapter-labeling-request-profile';
import { compactSpeakerAttributionRequestProfile } from '../../../../../src/providers/speaker-attribution/request-profile';
import type { AnalysisInputRevision } from './analysis-input-contracts.js';
import { chapterLabelingSourceView } from './analysis-input-contracts.js';

export function requireAnalysisReviewChapterSource(revision: AnalysisInputRevision) {
  const source = chapterLabelingSourceView(revision.sourceSnapshot);
  if (!source) throw new Error('Analysis review source revision is unavailable');
  return source;
}

export function analysisReviewRequestProfile(revision: AnalysisInputRevision) {
  if (revision.sourceSnapshot.kind !== 'speaker_attribution_v3') {
    return resolveChapterLabelingRequestProfile({ requestProfileId: revision.requestProfile.id });
  }
  const validationPolicy = resolveChapterLabelingRequestProfile({}).validationPolicy;
  return { ...compactSpeakerAttributionRequestProfile, validationPolicy };
}
