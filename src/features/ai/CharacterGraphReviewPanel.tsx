import { formatCount } from '../../utils/format';
import { projectConfidenceRisk } from '../../providers/provider-capability';
import type { AIGraphReviewData } from './ai-addon-panel-contract';

function riskLabel(confidence: number): string {
  const risk = projectConfidenceRisk({ rawConfidence: confidence }).risk;
  return risk === 'high' ? '검토 우선' : risk === 'medium' ? '검토 권장' : '낮은 위험';
}

export function CharacterGraphReviewPanel({
  data,
  toggleCandidate,
  confirmFact,
  rejectFact,
  mergeCandidate,
  splitFact,
}: {
  readonly data: AIGraphReviewData;
  readonly toggleCandidate: (characterId: string) => void;
  readonly confirmFact?: (factId: string) => void | Promise<unknown>;
  readonly rejectFact?: (factId: string) => void | Promise<unknown>;
  readonly mergeCandidate?: (candidateId: string) => void | Promise<unknown>;
  readonly splitFact?: (factId: string, canonicalName: string) => void | Promise<unknown>;
}) {
  const knowledge = data.knowledge;
  return (
    <div className="graph-review-panel">
      <div className="panel-section-title">
        <h4>후보 그래프 검토</h4>
        <span>
          {formatCount(data.includedCharacterCount)} / {formatCount(data.candidateCount)}
        </span>
      </div>
      {data.parseError ? (
        <p className="field-error">{data.parseError}</p>
      ) : (
        <>
          <div className="graph-review-metrics">
            <span>신규 {formatCount(data.newCandidateCount)}</span>
            <span>중복 {formatCount(data.duplicateCandidateCount)}</span>
            <span>낮은 신뢰도 {formatCount(data.lowConfidenceCount)}</span>
            <span>관계 {formatCount(data.relationCount)}</span>
            {data.invalidRelationCount > 0 && <span>제외된 관계 {formatCount(data.invalidRelationCount)}</span>}
          </div>
          <div className="compact-list graph-review-list">
            {data.candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`graph-review-row${candidate.excluded ? ' excluded' : ''}`}
                onClick={() => toggleCandidate(candidate.id)}
              >
                <span>
                  {candidate.name} · {riskLabel(candidate.confidence)}
                </span>
                <small>{candidate.detailLabel}</small>
                <em>{candidate.excluded ? '제외' : '포함'}</em>
              </button>
            ))}
          </div>
          {knowledge && (
            <div className="graph-knowledge-workspace">
              <div className="panel-section-title">
                <h4>인물 사실과 중복 후보</h4>
                <span>{formatCount(knowledge.factCount)}</span>
              </div>
              <div className="graph-review-metrics">
                <span>일반 지칭 {formatCount(knowledge.genericMentionCount)}</span>
                <span>호칭 {formatCount(knowledge.addressTermCount)}</span>
                <span>근거 {formatCount(knowledge.evidenceCount)}</span>
              </div>
              {knowledge.error && <p className="field-error">{knowledge.error}</p>}
              {knowledge.mergeCandidates.map((candidate) => (
                <div className="graph-knowledge-row" key={candidate.id}>
                  <span>
                    {candidate.sourceName} → {candidate.targetName}
                  </span>
                  <small>
                    {candidate.positiveReasons.join(', ') || '명시 근거 없음'}
                    {candidate.negativeReasons.length > 0 ? ` · 충돌 ${candidate.negativeReasons.join(', ')}` : ''}
                  </small>
                  <button
                    type="button"
                    disabled={knowledge.busy || !candidate.applicable}
                    onClick={() => mergeCandidate?.(candidate.id)}
                  >
                    병합 · {riskLabel(candidate.confidence)}
                  </button>
                </div>
              ))}
              {knowledge.facts.map((fact) => (
                <div className="graph-knowledge-row" key={fact.id}>
                  <span>
                    {fact.characterName} · {fact.field}
                  </span>
                  <small>
                    {fact.value} · {fact.validityLabel} · 근거 {formatCount(fact.evidenceCount)}
                  </small>
                  <div className="graph-knowledge-actions">
                    <button
                      type="button"
                      disabled={knowledge.busy || fact.locked}
                      onClick={() => confirmFact?.(fact.id)}
                    >
                      확정
                    </button>
                    <button
                      type="button"
                      disabled={knowledge.busy || fact.locked}
                      onClick={() => rejectFact?.(fact.id)}
                    >
                      제외
                    </button>
                    <button
                      type="button"
                      disabled={knowledge.busy}
                      onClick={() => {
                        const name = window.prompt('새 인물 이름', fact.value)?.trim();
                        if (name) void splitFact?.(fact.id, name);
                      }}
                    >
                      분리
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
