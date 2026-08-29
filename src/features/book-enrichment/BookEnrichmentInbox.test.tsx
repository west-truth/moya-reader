import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { testNovel } from '../book-workspace/book-workspace-test-fixtures';
import {
  BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
  type BookEnrichmentApprovalReceipt,
  type BookEnrichmentCandidate,
  type BookEnrichmentProvenance,
} from './book-enrichment-contract';
import { BookEnrichmentInbox } from './BookEnrichmentInbox';
import type { BookEnrichmentController } from './useBookEnrichmentController';

const provenance: BookEnrichmentProvenance = {
  extensionId: 'trusted.catalog',
  extensionVersion: '1.2.0',
  contributionId: 'trusted.catalog.books',
  origin: 'bundled_trusted',
  registrationFingerprint: 'registration-hash',
  sourceFingerprints: ['catalog:book-1'],
  generatedAt: '2026-08-24T01:00:00.000Z',
  sourceLabel: '공식 작품 카탈로그',
  licenseSummary: '개인 서재 사용 허용',
};

function receipt(overrides: Partial<BookEnrichmentApprovalReceipt> = {}): BookEnrichmentApprovalReceipt {
  return {
    schemaVersion: BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
    id: 'receipt-1',
    action: 'apply',
    candidateId: 'candidate-1',
    bookId: 'book-1',
    kind: 'metadata',
    baseMetadataRevision: 6,
    appliedMetadataRevision: 7,
    selectedFields: ['title'],
    beforeHash: 'before-hash',
    afterHash: 'after-hash',
    before: { kind: 'metadata', values: { title: '이전 제목' } },
    after: { kind: 'metadata', values: { title: '추천 제목' } },
    provenance,
    appliedAt: '2026-08-24T02:03:00.000Z',
    ...overrides,
  };
}

function candidate(): BookEnrichmentCandidate {
  return {
    schemaVersion: 1,
    id: 'candidate-1',
    bookId: 'book-1',
    kind: 'metadata',
    status: 'pending',
    baseMetadataRevision: 6,
    provenance,
    createdAt: '2026-08-24T01:00:00.000Z',
    updatedAt: '2026-08-24T01:00:00.000Z',
    baseValues: { title: '이전 제목' },
    patch: { title: '추천 제목' },
  };
}

function controller(overrides: Partial<BookEnrichmentController> = {}): BookEnrichmentController {
  return {
    available: true,
    providers: [
      {
        extensionId: 'trusted.catalog',
        extensionVersion: '1.2.0',
        descriptor: {
          id: 'trusted.catalog.books',
          schemaVersion: 1,
          title: '공식 서지 검색',
          capabilities: ['metadata'],
        },
      },
    ],
    candidates: [],
    receipts: [],
    busy: false,
    load: vi.fn(async () => undefined),
    propose: vi.fn(async () => undefined),
    applyMetadata: vi.fn(async () => true),
    applyCover: vi.fn(async () => true),
    reject: vi.fn(async () => undefined),
    undo: vi.fn(async () => true),
    ...overrides,
  };
}

function render(controllerValue: BookEnrichmentController, metadataRevision = 7, title = '추천 제목') {
  return renderToStaticMarkup(
    <BookEnrichmentInbox
      book={testNovel({ metadataRevision, title })}
      controller={controllerValue}
      manualDraftDirty={false}
      onApplied={vi.fn()}
    />,
  );
}

describe('BookEnrichmentInbox', () => {
  it('keeps host-owned approval history visible without a currently available provider', () => {
    const approval = receipt();
    const markup = render(controller({ providers: [], receipts: [approval] }));

    expect(markup).toContain('적용 기록');
    expect(markup).toContain('공식 작품 카탈로그');
    expect(markup).toContain('사용 조건 개인 서재 사용 허용');
    expect(markup).toContain('이전 제목');
    expect(markup).toContain('추천 제목');
    expect(markup).toContain('data-receipt-state="available"');
    expect(markup).toContain('되돌리기');
    expect(markup).not.toContain('추천 찾기');
    expect(markup).not.toContain('익스텐션');
  });

  it('does not render an empty host section when no provider, candidate, or receipt exists', () => {
    expect(render(controller({ providers: [], candidates: [], receipts: [] }))).toBe('');
  });

  it('hides pending candidates contributed by a provider that is no longer active', () => {
    expect(render(controller({ providers: [], candidates: [candidate()], receipts: [] }))).toBe('');
  });

  it('marks changed and undone approvals without offering an active undo action', () => {
    const changed = receipt({ id: 'receipt-changed', appliedMetadataRevision: 6 });
    const undone = receipt({ id: 'receipt-undone', appliedMetadataRevision: 5 });
    const undoReceipt = receipt({
      id: 'undo-receipt',
      action: 'undo',
      approvalReceiptId: undone.id,
      appliedMetadataRevision: 6,
    });
    const markup = render(controller({ providers: [], receipts: [changed, undone, undoReceipt] }));

    expect(markup).toContain('data-receipt-state="changed"');
    expect(markup).toContain('이후 변경 있음');
    expect(markup).toContain('data-receipt-state="undone"');
    expect(markup).toContain('되돌림 완료');
    expect(markup.match(/<button class="ghost-btn" type="button" disabled=""/g)).toHaveLength(2);
  });
});
