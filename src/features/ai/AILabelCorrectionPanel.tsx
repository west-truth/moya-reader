import { formatCount } from '../../utils/format';
import type { LabelCorrectionReason } from '../../providers/label-correction-review';
import { projectConfidenceRisk } from '../../providers/provider-capability';
import type { AIAddonPanelActions, AILabelCorrectionData } from './ai-addon-panel-contract';

function confidenceRiskLabel(confidence: number, signals: readonly string[] = []): string {
  const risk = projectConfidenceRisk({ rawConfidence: confidence, deterministicSignals: signals }).risk;
  return risk === 'high' ? '검토 우선' : risk === 'medium' ? '검토 권장' : '낮은 위험';
}

function correctionReasonLabel(reason: LabelCorrectionReason): string {
  if (reason === 'unknown_speaker') return '화자 미정';
  if (reason === 'low_confidence') return '낮은 신뢰도';
  return '후보 다수';
}

export function AILabelCorrectionPanel({
  data,
  actions,
}: {
  readonly data: AILabelCorrectionData;
  readonly actions: AIAddonPanelActions['correction'];
}) {
  const visibleReviewItems = data.reviewItems.slice(0, 12);

  return (
    <>
      <div className="panel-section-title">
        <h4>라벨 검토 큐</h4>
        <span>{formatCount(data.reviewItems.length)}</span>
      </div>
      <div className="compact-list label-review-list">
        {data.reviewItems.length === 0 ? (
          <p className="empty-panel">
            {data.segmentCount ? '검토할 저신뢰/미정 라벨이 없습니다.' : '분석 결과가 아직 없습니다.'}
          </p>
        ) : (
          visibleReviewItems.map((item) => (
            <button
              key={item.segment.id}
              className={data.target?.id === item.segment.id ? 'active' : ''}
              onClick={() => void actions.selectSegment(item.segment)}
            >
              <span>
                {item.speakerLabel} · {item.segment.emotion || 'neutral'} ·{' '}
                {confidenceRiskLabel(item.segment.confidence, item.reasons)}
              </span>
              <small>
                {item.reasons.map(correctionReasonLabel).join(', ')} · {item.snippet}
              </small>
            </button>
          ))
        )}
        {data.reviewItems.length > visibleReviewItems.length && (
          <p className="muted">
            추가 {formatCount(data.reviewItems.length - visibleReviewItems.length)}개는 본문에서 이어서 확인할 수
            있습니다.
          </p>
        )}
      </div>
      <div className="reader-mode-switch stacked">
        <button
          className={data.readerMode === 'analysis' ? 'active' : ''}
          onClick={() => actions.setReaderMode('analysis')}
        >
          분석 라벨 보기
        </button>
        <button
          className={data.readerMode === 'correction' ? 'active' : ''}
          onClick={() => actions.setReaderMode('correction')}
        >
          화자 수정 모드
        </button>
      </div>
      <h4>등장인물 후보</h4>
      <div className="character-list">
        {data.characters.length === 0 ? (
          <p className="muted">화자 분석을 실행하면 표시됩니다.</p>
        ) : (
          data.characters.map((character) => (
            <div key={character.id} className="character-row">
              <span style={{ background: character.color }} />
              <div>
                <strong>{character.canonicalName}</strong>
                <small>
                  {confidenceRiskLabel(character.confidence)} · {character.aliases.join(', ')}
                </small>
              </div>
            </div>
          ))
        )}
      </div>
      {data.target && (
        <div className="correction-box">
          <h4>선택 라벨 교정</h4>
          <p>{data.targetSnippet}</p>
          <label>
            <span>화자</span>
            <select value={data.speakerDraft} onChange={(event) => actions.setSpeakerDraft(event.target.value)}>
              {data.speakerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {data.candidateSpeakerOptions.length > 0 && (
            <div className="correction-quick">
              {data.candidateSpeakerOptions.map((option) => (
                <button key={option.id} type="button" onClick={() => actions.setSpeakerDraft(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <label>
            <span>감정</span>
            <select value={data.emotionDraft} onChange={(event) => actions.setEmotionDraft(event.target.value)}>
              {data.emotionOptions.map((emotion) => (
                <option key={emotion} value={emotion}>
                  {emotion}
                </option>
              ))}
            </select>
          </label>
          <div className="segmented full">
            <button className={data.scope === 'segment' ? 'active' : ''} onClick={() => actions.setScope('segment')}>
              이 구간만
            </button>
            <button
              className={data.scope === 'future_pattern' ? 'active' : ''}
              onClick={() => actions.setScope('future_pattern')}
            >
              이후 재분석
            </button>
          </div>
          <div className="correction-actions">
            <button className="primary-btn" onClick={() => void actions.apply()}>
              저장
            </button>
            <button className="ghost-btn" onClick={actions.close}>
              닫기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
