import type {
  CharacterGraphCandidateReason,
  CharacterGraphReviewCandidate,
} from '../../providers/character-graph-review';

function graphCandidateReasonLabel(reason: CharacterGraphCandidateReason): string {
  if (reason === 'existing_id') return '기존 ID';
  if (reason === 'possible_duplicate') return '중복 후보';
  if (reason === 'low_confidence') return '낮은 신뢰도';
  return '신규';
}

export function graphCandidateDetailLabel(candidate: CharacterGraphReviewCandidate): string {
  const details = candidate.reasons.map(graphCandidateReasonLabel);
  if (candidate.matchedExistingCharacter) details.push(`기존 ${candidate.matchedExistingCharacter.canonicalName}`);
  const aliases = candidate.character.aliases.slice(0, 3).join(', ');
  if (aliases) details.push(aliases);
  return details.join(' · ');
}
