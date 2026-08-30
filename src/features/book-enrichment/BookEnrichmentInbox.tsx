import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { Check, ChevronDown, ExternalLink, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Novel } from '../../domain/types';
import { formatDateTime } from '../../utils/format';
import { BookCover } from '../library/BookCover';
import {
  BOOK_ENRICHMENT_METADATA_FIELDS,
  BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
  type BookEnrichmentApprovalReceipt,
  type BookEnrichmentCandidate,
  type BookEnrichmentMetadataField,
  type BookEnrichmentMutationSnapshot,
  type BookEnrichmentProvenance,
} from './book-enrichment-contract';
import type { BookEnrichmentController } from './useBookEnrichmentController';

const fieldLabels: Record<BookEnrichmentMetadataField, string> = {
  title: '제목',
  author: '작가',
  seriesTitle: '시리즈',
  seriesIndex: '권',
  tags: '태그',
  description: '설명',
  language: '언어',
};

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '없음';
  if (value === null || value === undefined || value === '') return '없음';
  return String(value);
}

function providerTitle(provenance: BookEnrichmentProvenance, controller: BookEnrichmentController): string {
  return (
    controller.providers.find((item) => item.descriptor.id === provenance.contributionId)?.descriptor.title ??
    provenance.sourceLabel ??
    '추천 제공자'
  );
}

function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

const matchTypeLabels: Record<string, string> = {
  exact_title_and_author: '제목·작가 정확히 일치',
  exact_title: '제목 정확히 일치',
  fuzzy_title: '유사 제목',
  ambiguous: '일치 결과 재검토 필요',
};

function ProvenanceSource({
  provenance,
  controller,
}: {
  provenance: BookEnrichmentProvenance;
  controller: BookEnrichmentController;
}) {
  const title = providerTitle(provenance, controller);
  const sourceUrl = safeSourceUrl(provenance.sourceUrl);
  return (
    <div className="enrichment-candidate-source">
      <strong>{title}</strong>
      {provenance.sourceLabel && provenance.sourceLabel !== title && <span>출처 {provenance.sourceLabel}</span>}
      {provenance.automation?.matchType && (
        <span>{matchTypeLabels[provenance.automation.matchType] ?? provenance.automation.matchType}</span>
      )}
      {provenance.automation?.authenticatedSearch && <span>로그인 검색</span>}
      {provenance.licenseSummary && <span>사용 조건 {provenance.licenseSummary}</span>}
      {provenance.confidence !== undefined && <span>신뢰도 {Math.round(provenance.confidence * 100)}%</span>}
      {sourceUrl && (
        <a href={sourceUrl} target="_blank" rel="noreferrer">
          원본 페이지 <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function CandidateSource({
  candidate,
  controller,
}: {
  candidate: BookEnrichmentCandidate;
  controller: BookEnrichmentController;
}) {
  return <ProvenanceSource provenance={candidate.provenance} controller={controller} />;
}

type ApprovalState = 'available' | 'changed' | 'undone' | 'record-only';

function currentMetadataValue(book: Novel, field: BookEnrichmentMetadataField): unknown {
  return field === 'tags' ? [...(book.tags ?? [])] : (book[field] ?? null);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotMatchesBook(
  book: Novel,
  snapshot: BookEnrichmentMutationSnapshot,
  fields: readonly BookEnrichmentMetadataField[],
): boolean {
  if (snapshot.kind === 'metadata') {
    return fields.every((field) => sameValue(currentMetadataValue(book, field), snapshot.values[field] ?? null));
  }
  return (
    snapshot.cover.present === Boolean(book.coverAssetId && book.coverContentHash) &&
    (snapshot.cover.assetId ?? undefined) === book.coverAssetId &&
    (snapshot.cover.contentHash ?? undefined) === book.coverContentHash &&
    snapshot.cover.fit === (book.coverFit ?? 'crop') &&
    snapshot.cover.positionX === (book.coverPositionX ?? 50) &&
    snapshot.cover.positionY === (book.coverPositionY ?? 50)
  );
}

function approvalState(
  book: Novel,
  approval: BookEnrichmentApprovalReceipt,
  receipts: readonly BookEnrichmentApprovalReceipt[],
): ApprovalState {
  if (receipts.some((receipt) => receipt.action === 'undo' && receipt.approvalReceiptId === approval.id)) {
    return 'undone';
  }
  if (
    approval.schemaVersion !== BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION ||
    approval.action !== 'apply' ||
    !approval.before ||
    !approval.after
  ) {
    return 'record-only';
  }
  return snapshotMatchesBook(book, approval.after, approval.selectedFields) ? 'available' : 'changed';
}

function coverSnapshotLabel(snapshot: Extract<BookEnrichmentMutationSnapshot, { kind: 'cover' }>): string {
  if (!snapshot.cover.present) return '표지 없음';
  const hash = snapshot.cover.contentHash ? ` · ${snapshot.cover.contentHash.slice(0, 8)}` : '';
  return `표지${hash}`;
}

function ReceiptDiff({ receipt }: { receipt: BookEnrichmentApprovalReceipt }) {
  if (!receipt.before || !receipt.after) {
    return <p className="enrichment-receipt-note">이전 형식의 기록으로 자동 복구 정보가 없습니다.</p>;
  }
  if (receipt.before.kind === 'metadata' && receipt.after.kind === 'metadata') {
    return (
      <div className="enrichment-receipt-diff">
        {receipt.selectedFields.map((field) => (
          <div key={field}>
            <strong>{fieldLabels[field]}</strong>
            <span>{displayValue(receipt.before?.kind === 'metadata' ? receipt.before.values[field] : undefined)}</span>
            <span aria-hidden="true">→</span>
            <span>{displayValue(receipt.after?.kind === 'metadata' ? receipt.after.values[field] : undefined)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (receipt.before.kind === 'cover' && receipt.after.kind === 'cover') {
    return (
      <div className="enrichment-receipt-diff">
        <div>
          <strong>표지</strong>
          <span>{coverSnapshotLabel(receipt.before)}</span>
          <span aria-hidden="true">→</span>
          <span>{coverSnapshotLabel(receipt.after)}</span>
        </div>
      </div>
    );
  }
  return <p className="enrichment-receipt-note">적용 기록을 비교할 수 없습니다.</p>;
}

const approvalStateLabels: Record<ApprovalState, string> = {
  available: '현재 상태 일치',
  changed: '이후 변경 있음',
  undone: '되돌림 완료',
  'record-only': '기록만 있음',
};

function ApprovalHistory({
  book,
  controller,
  manualDraftDirty,
  approvals,
  onApplied,
}: {
  book: Novel;
  controller: BookEnrichmentController;
  manualDraftDirty: boolean;
  approvals: readonly BookEnrichmentApprovalReceipt[];
  onApplied(): void;
}) {
  if (approvals.length === 0) return null;
  return (
    <details className="enrichment-history">
      <summary className="enrichment-history-heading">
        <h3>적용 기록</h3>
        <span>{approvals.length}개</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="enrichment-history-list">
        {approvals.map((receipt) => {
          const state = approvalState(book, receipt, controller.receipts);
          const canUndo = state === 'available' && !manualDraftDirty && !controller.busy;
          return (
            <article key={receipt.id} className={`enrichment-history-card is-${state}`} data-receipt-state={state}>
              <header>
                <ProvenanceSource provenance={receipt.provenance} controller={controller} />
                <span className="enrichment-receipt-state">{approvalStateLabels[state]}</span>
              </header>
              <time dateTime={receipt.appliedAt}>{formatDateTime(receipt.appliedAt)}</time>
              <ReceiptDiff receipt={receipt} />
              {manualDraftDirty && state === 'available' && (
                <p className="field-help warning">직접 편집 중인 변경을 먼저 저장하거나 취소하세요.</p>
              )}
              <div className="enrichment-candidate-actions">
                <button
                  className="ghost-btn"
                  type="button"
                  disabled={!canUndo}
                  onClick={() =>
                    void controller.undo(receipt.id).then((undone) => {
                      if (undone) onApplied();
                    })
                  }
                >
                  <RotateCcw size={15} /> {state === 'available' ? '되돌리기' : approvalStateLabels[state]}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </details>
  );
}

function MetadataCandidateCard({
  candidate,
  controller,
  manualDraftDirty,
  onApplied,
}: {
  candidate: Extract<BookEnrichmentCandidate, { kind: 'metadata' }>;
  controller: BookEnrichmentController;
  manualDraftDirty: boolean;
  onApplied(): void;
}) {
  const fields = BOOK_ENRICHMENT_METADATA_FIELDS.filter((field) => candidate.patch[field] !== undefined);
  const [selected, setSelected] = useState<Set<BookEnrichmentMetadataField>>(() => new Set(fields));
  const stale = candidate.status === 'stale';
  const toggle = (field: BookEnrichmentMetadataField) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };
  return (
    <article
      className={`enrichment-candidate-card${stale ? ' is-stale' : ''}`}
      data-testid="metadata-enrichment-candidate"
    >
      <CandidateSource candidate={candidate} controller={controller} />
      {candidate.provenance.rationale && <p>{candidate.provenance.rationale}</p>}
      {stale && <p className="field-help warning">작품 정보가 변경되어 다시 추천을 찾아야 합니다.</p>}
      <div className="enrichment-metadata-diff">
        {fields.map((field) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={selected.has(field)}
              disabled={stale || controller.busy}
              onChange={() => toggle(field)}
            />
            <span className="enrichment-field-name">{fieldLabels[field]}</span>
            <span className="enrichment-current-value">현재 {displayValue(candidate.baseValues[field])}</span>
            <span className="enrichment-proposed-value">추천 {displayValue(candidate.patch[field])}</span>
          </label>
        ))}
      </div>
      {manualDraftDirty && <p className="field-help warning">직접 편집 중인 변경을 먼저 저장하거나 취소하세요.</p>}
      <div className="enrichment-candidate-actions">
        <button
          className="ghost-btn"
          type="button"
          disabled={controller.busy}
          onClick={() => void controller.reject(candidate.id)}
        >
          <X size={15} /> 거절
        </button>
        <button
          className="primary-btn"
          type="button"
          disabled={stale || manualDraftDirty || controller.busy || selected.size === 0}
          onClick={() =>
            void controller.applyMetadata(candidate.id, [...selected]).then((applied) => {
              if (applied) onApplied();
            })
          }
        >
          <Check size={15} /> 선택 항목 적용
        </button>
      </div>
    </article>
  );
}

function CoverCandidateCard({
  book,
  candidate,
  controller,
  manualDraftDirty,
  onApplied,
}: {
  book: Novel;
  candidate: Extract<BookEnrichmentCandidate, { kind: 'cover' }>;
  controller: BookEnrichmentController;
  manualDraftDirty: boolean;
  onApplied(): void;
}) {
  const [fit, setFit] = useState<'crop' | 'contain'>(candidate.cover.fit);
  const [positionX, setPositionX] = useState(candidate.cover.positionX);
  const [positionY, setPositionY] = useState(candidate.cover.positionY);
  const previewUrl = useMemo(() => URL.createObjectURL(candidate.cover.blob), [candidate.cover.blob]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  const stale = candidate.status === 'stale';
  return (
    <article
      className={`enrichment-candidate-card${stale ? ' is-stale' : ''}`}
      data-testid="cover-enrichment-candidate"
    >
      <CandidateSource candidate={candidate} controller={controller} />
      {candidate.provenance.rationale && <p>{candidate.provenance.rationale}</p>}
      {stale && <p className="field-help warning">작품 정보가 변경되어 다시 추천을 찾아야 합니다.</p>}
      <div className="enrichment-cover-compare">
        <figure>
          <BookCover novel={book} className={`book-cover cover-${(book.coverSeed % 6) + 1}`} />
          <figcaption>현재 표지</figcaption>
        </figure>
        <figure>
          <img
            src={previewUrl}
            alt="추천 표지 미리보기"
            style={{ objectFit: fit === 'crop' ? 'cover' : 'contain', objectPosition: `${positionX}% ${positionY}%` }}
          />
          <figcaption>추천 표지</figcaption>
        </figure>
      </div>
      <div className="enrichment-cover-layout">
        <div className="segmented" role="group" aria-label="추천 표지 맞춤 방식">
          <button type="button" className={fit === 'crop' ? 'active' : ''} onClick={() => setFit('crop')}>
            채우기
          </button>
          <button type="button" className={fit === 'contain' ? 'active' : ''} onClick={() => setFit('contain')}>
            원본 비율
          </button>
        </div>
        <label>
          가로 위치{' '}
          <input
            type="range"
            min="0"
            max="100"
            value={positionX}
            onChange={(event) => setPositionX(Number(event.target.value))}
          />
        </label>
        <label>
          세로 위치{' '}
          <input
            type="range"
            min="0"
            max="100"
            value={positionY}
            onChange={(event) => setPositionY(Number(event.target.value))}
          />
        </label>
      </div>
      {manualDraftDirty && <p className="field-help warning">직접 편집 중인 변경을 먼저 저장하거나 취소하세요.</p>}
      <div className="enrichment-candidate-actions">
        <button
          className="ghost-btn"
          type="button"
          disabled={controller.busy}
          onClick={() => void controller.reject(candidate.id)}
        >
          <X size={15} /> 거절
        </button>
        <button
          className="primary-btn"
          type="button"
          disabled={stale || manualDraftDirty || controller.busy}
          onClick={() =>
            void controller.applyCover(candidate.id, { fit, positionX, positionY }).then((applied) => {
              if (applied) onApplied();
            })
          }
        >
          <Check size={15} /> 추천 표지 적용
        </button>
      </div>
    </article>
  );
}

export function BookEnrichmentInbox({
  book,
  controller,
  manualDraftDirty,
  onApplied,
}: {
  book: Novel;
  controller: BookEnrichmentController;
  manualDraftDirty: boolean;
  onApplied(): void;
}) {
  const [providerId, setProviderId] = useState<ExtensionContributionId | ''>(
    controller.providers[0]?.descriptor.id ?? '',
  );
  const [expanded, setExpanded] = useState(false);
  const loadCandidates = controller.load;
  useEffect(() => void loadCandidates(book.id), [book.id, loadCandidates]);
  useEffect(() => setExpanded(false), [book.id]);
  useEffect(() => {
    if (!controller.providers.some((provider) => provider.descriptor.id === providerId)) {
      setProviderId(controller.providers[0]?.descriptor.id ?? '');
    }
  }, [controller.providers, providerId]);
  const activeProviderIds = new Set(controller.providers.map((provider) => provider.descriptor.id));
  const visibleCandidates = controller.candidates.filter(
    (candidate) =>
      candidate.bookId === book.id &&
      (candidate.status === 'pending' || candidate.status === 'stale') &&
      activeProviderIds.has(candidate.provenance.contributionId),
  );
  const approvals = controller.receipts
    .filter((receipt) => receipt.bookId === book.id && receipt.action !== 'undo')
    .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  useEffect(() => {
    if (visibleCandidates.length > 0 || controller.error) setExpanded(true);
  }, [controller.error, visibleCandidates.length]);
  if (
    !controller.available ||
    (controller.providers.length === 0 && visibleCandidates.length === 0 && approvals.length === 0)
  ) {
    return null;
  }
  return (
    <section
      className={`metadata-section book-enrichment-inbox${expanded ? ' is-expanded' : ' is-collapsed'}`}
      aria-labelledby="book-enrichment-heading"
    >
      <div className="metadata-section-heading enrichment-heading-row">
        <button
          className="enrichment-collapse-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls="book-enrichment-content"
          onClick={() => setExpanded((current) => !current)}
        >
          <span id="book-enrichment-heading">
            <Sparkles size={17} /> 추천 정보
          </span>
          <small>
            {visibleCandidates.length > 0 ? `검토 ${visibleCandidates.length}개` : '새 추천 없음'}
            {approvals.length > 0 ? ` · 적용 기록 ${approvals.length}개` : ''}
          </small>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {controller.providers.length > 0 && (
          <div className="enrichment-provider-runner">
            {controller.providers.length > 1 && (
              <select
                aria-label="작품 정보 추천 방식"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value as ExtensionContributionId)}
              >
                {controller.providers.map((provider) => (
                  <option key={provider.descriptor.id} value={provider.descriptor.id}>
                    {provider.descriptor.title}
                  </option>
                ))}
              </select>
            )}
            <button
              className="ghost-btn"
              type="button"
              disabled={controller.busy || !providerId}
              onClick={() => {
                setExpanded(true);
                if (providerId) void controller.propose(book.id, providerId);
              }}
            >
              <RefreshCw size={15} className={controller.busy ? 'spin' : undefined} /> 정보 찾기
            </button>
          </div>
        )}
      </div>
      <div id="book-enrichment-content" className="enrichment-content" hidden={!expanded}>
        {controller.error && <p className="field-help warning">{controller.error}</p>}
        {visibleCandidates.length === 0 && controller.providers.length > 0 ? (
          <p className="enrichment-empty">새로 검토할 추천이 없습니다.</p>
        ) : visibleCandidates.length > 0 ? (
          <div className="enrichment-candidate-list">
            {visibleCandidates.map((candidate) =>
              candidate.kind === 'metadata' ? (
                <MetadataCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  controller={controller}
                  manualDraftDirty={manualDraftDirty}
                  onApplied={onApplied}
                />
              ) : (
                <CoverCandidateCard
                  key={candidate.id}
                  book={book}
                  candidate={candidate}
                  controller={controller}
                  manualDraftDirty={manualDraftDirty}
                  onApplied={onApplied}
                />
              ),
            )}
          </div>
        ) : null}
        <ApprovalHistory
          book={book}
          controller={controller}
          manualDraftDirty={manualDraftDirty}
          approvals={approvals}
          onApplied={onApplied}
        />
      </div>
    </section>
  );
}
