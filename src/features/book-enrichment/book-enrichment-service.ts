import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { Novel } from '../../domain/types';
import { integrityHash, persistentId128 } from '../../domain/id-hash-contract';
import type { TrustedAnalysisWorkflowHostContext } from '../../extensions/analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../../extensions/reader-addon-host-context';
import type { TrustedExtensionRegistry } from '../../extensions/trusted-extension-registry';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { BookEnrichmentRepository } from '../../repositories/book-enrichment-repository';
import type { LibraryCatalogRepository } from '../../repositories/library-catalog-repository';
import type { ReaderRepository } from '../../repositories/reader-repository';
import {
  MAX_COVER_HEIGHT,
  MAX_COVER_INPUT_BYTES,
  MAX_COVER_WIDTH,
  detectCoverContentType,
} from '../../services/cover-image';
import {
  prepareBookEnrichmentCandidates,
  publicBookMetadataSnapshot,
  selectMetadataCandidateFields,
} from './book-enrichment-candidate';
import type {
  BookEnrichmentApprovalIntent,
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
  BookEnrichmentCoverSnapshot,
  BookEnrichmentMetadataField,
  BookEnrichmentMetadataValues,
  BookEnrichmentMutationSnapshot,
  BookEnrichmentProviderSummary,
} from './book-enrichment-contract';
import {
  BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION,
  BOOK_ENRICHMENT_METADATA_FIELDS,
  BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
} from './book-enrichment-contract';

export class BookEnrichmentCandidateConflictError extends Error {
  constructor(public readonly candidateId: string) {
    super('작품 정보가 변경되어 이 추천을 다시 검토해야 합니다.');
    this.name = 'BookEnrichmentCandidateConflictError';
  }
}

export class BookEnrichmentUndoConflictError extends Error {
  constructor(public readonly receiptId: string) {
    super('이후 변경이 있어 자동으로 되돌릴 수 없습니다.');
    this.name = 'BookEnrichmentUndoConflictError';
  }
}

type Registry = TrustedExtensionRegistry<TrustedReaderAddonHostContext, TrustedAnalysisWorkflowHostContext>;

export interface BookEnrichmentServiceDependencies {
  readonly registry: Registry;
  readonly repository: BookEnrichmentRepository;
  readonly books: Pick<ReaderRepository, 'getNovel'>;
  readonly catalog: LibraryCatalogRepository;
  readonly assets: BookAssetRepository;
}

function snapshotHash(value: unknown): string {
  return integrityHash(new TextEncoder().encode(JSON.stringify(value)));
}

// Prevent a projection in another tab from clearing an intent while a hosted
// mutation is still in flight. Exact applied state is recoverable immediately;
// only an unchanged intent waits for this lease before it is discarded.
const APPROVAL_INTENT_ACTIVE_GRACE_MS = 5 * 60_000;

function selectedMetadataSnapshot(
  novel: Novel,
  fields: readonly BookEnrichmentMetadataField[],
): BookEnrichmentMetadataValues {
  return Object.fromEntries(
    fields.map((field) => [field, field === 'tags' ? [...(novel.tags ?? [])] : (novel[field] ?? null)]),
  ) as BookEnrichmentMetadataValues;
}

function metadataMutationSnapshot(
  novel: Novel,
  fields: readonly BookEnrichmentMetadataField[],
): BookEnrichmentMutationSnapshot {
  return { kind: 'metadata', values: selectedMetadataSnapshot(novel, fields) };
}

function expectedMetadataMutationSnapshot(
  patch: BookEnrichmentMetadataValues,
  fields: readonly BookEnrichmentMetadataField[],
): BookEnrichmentMutationSnapshot {
  return {
    kind: 'metadata',
    values: Object.fromEntries(
      fields.map((field) => [field, field === 'tags' ? [...(patch.tags ?? [])] : (patch[field] ?? null)]),
    ) as BookEnrichmentMetadataValues,
  };
}

function coverSnapshot(
  novel: Novel,
  metadata?: { readonly id: string; readonly contentHash: string; readonly provenance: string },
): BookEnrichmentCoverSnapshot {
  return {
    present: Boolean(novel.coverAssetId && novel.coverContentHash),
    assetId: metadata?.id ?? novel.coverAssetId,
    contentHash: metadata?.contentHash ?? novel.coverContentHash,
    provenance: metadata?.provenance,
    fit: novel.coverFit ?? 'crop',
    positionX: novel.coverPositionX ?? 50,
    positionY: novel.coverPositionY ?? 50,
  };
}

function coverMutationSnapshot(
  novel: Novel,
  metadata?: { readonly id: string; readonly contentHash: string; readonly provenance: string },
): BookEnrichmentMutationSnapshot {
  return { kind: 'cover', cover: coverSnapshot(novel, metadata) };
}

function expectedCoverMutationSnapshot(input: {
  readonly contentHash: string;
  readonly fit: 'crop' | 'contain';
  readonly positionX: number;
  readonly positionY: number;
}): BookEnrichmentMutationSnapshot {
  return {
    kind: 'cover',
    cover: {
      present: true,
      contentHash: input.contentHash,
      fit: input.fit,
      positionX: input.positionX,
      positionY: input.positionY,
    },
  };
}

function metadataSnapshotsEqual(left: BookEnrichmentMutationSnapshot, right: BookEnrichmentMutationSnapshot): boolean {
  return left.kind === 'metadata' && right.kind === 'metadata' && snapshotHash(left) === snapshotHash(right);
}

function coverSnapshotsEqual(
  actual: BookEnrichmentMutationSnapshot,
  expected: BookEnrichmentMutationSnapshot,
): boolean {
  if (actual.kind !== 'cover' || expected.kind !== 'cover') return false;
  return (
    actual.cover.present === expected.cover.present &&
    actual.cover.assetId === expected.cover.assetId &&
    actual.cover.contentHash === expected.cover.contentHash &&
    actual.cover.provenance === expected.cover.provenance &&
    actual.cover.fit === expected.cover.fit &&
    actual.cover.positionX === expected.cover.positionX &&
    actual.cover.positionY === expected.cover.positionY
  );
}

function coverMatchesExpectedApplied(
  actual: BookEnrichmentMutationSnapshot,
  expected: BookEnrichmentMutationSnapshot,
): boolean {
  if (actual.kind !== 'cover' || expected.kind !== 'cover') return false;
  return (
    actual.cover.present === true &&
    Boolean(actual.cover.assetId) &&
    actual.cover.provenance === 'approved_enrichment' &&
    actual.cover.contentHash === expected.cover.contentHash &&
    actual.cover.fit === expected.cover.fit &&
    actual.cover.positionX === expected.cover.positionX &&
    actual.cover.positionY === expected.cover.positionY
  );
}

function approvalIntentIsFresh(intent: BookEnrichmentApprovalIntent): boolean {
  const stagedAt = Date.parse(intent.stagedAt);
  return Number.isFinite(stagedAt) && Date.now() - stagedAt < APPROVAL_INTENT_ACTIVE_GRACE_MS;
}

async function validateStoredCover(candidate: Extract<BookEnrichmentCandidate, { kind: 'cover' }>) {
  const { cover } = candidate;
  if (cover.blob.size <= 0 || cover.blob.size > MAX_COVER_INPUT_BYTES)
    throw new Error('추천 표지 크기가 올바르지 않습니다.');
  const bytes = new Uint8Array(await cover.blob.arrayBuffer());
  if (detectCoverContentType(bytes.subarray(0, 16)) !== cover.contentType) {
    throw new Error('추천 표지 형식이 저장된 정보와 다릅니다.');
  }
  if (integrityHash(bytes) !== cover.contentHash) throw new Error('추천 표지 무결성 검증에 실패했습니다.');
  if (typeof createImageBitmap !== 'function') throw new Error('이 환경에서는 추천 표지를 검증할 수 없습니다.');
  const bitmap = await createImageBitmap(cover.blob);
  try {
    if (
      bitmap.width !== cover.pixelWidth ||
      bitmap.height !== cover.pixelHeight ||
      bitmap.width > MAX_COVER_WIDTH ||
      bitmap.height > MAX_COVER_HEIGHT
    ) {
      throw new Error('추천 표지 픽셀 크기가 저장된 정보와 다릅니다.');
    }
  } finally {
    bitmap.close();
  }
}

export class BookEnrichmentService {
  constructor(private readonly dependencies: BookEnrichmentServiceDependencies) {}

  listProviders(): readonly BookEnrichmentProviderSummary[] {
    return this.dependencies.registry.getBookEnrichmentProviders().map((provider) => ({
      extensionId: provider.extensionId,
      extensionVersion: provider.extensionVersion,
      descriptor: provider.descriptor,
    }));
  }

  async listCandidates(bookId: string): Promise<BookEnrichmentCandidate[]> {
    await this.reconcileApprovalIntents(bookId);
    return this.dependencies.repository.listCandidates(bookId);
  }

  async listReceipts(bookId: string): Promise<BookEnrichmentApprovalReceipt[]> {
    await this.reconcileApprovalIntents(bookId);
    return this.dependencies.repository.listReceipts(bookId);
  }

  async propose(bookId: string, contributionId: ExtensionContributionId, signal?: AbortSignal) {
    const existingCandidates = await this.reconcileApprovalIntents(bookId);
    if (existingCandidates.some((candidate) => candidate.approvalIntent)) {
      throw new Error('이 작품의 이전 정보 적용 작업을 복구하고 있습니다. 잠시 후 다시 시도하세요.');
    }
    const [book, activeCover] = await Promise.all([
      this.dependencies.books.getNovel(bookId),
      this.dependencies.assets.getActiveCover(bookId),
    ]);
    if (!book) throw new Error('책을 찾을 수 없습니다.');
    const provider = this.dependencies.registry.getBookEnrichmentProvider(contributionId);
    if (!provider) throw new Error('사용할 수 없는 작품 정보 추천 익스텐션입니다.');
    const snapshot = publicBookMetadataSnapshot(book, activeCover?.metadata);
    const drafts = await this.dependencies.registry.executeBookEnrichmentProvider(contributionId, {
      book: snapshot,
      signal,
    });
    const candidates = await prepareBookEnrichmentCandidates(provider, snapshot, drafts);
    await this.dependencies.repository.replacePendingCandidates(bookId, contributionId, candidates);
    return candidates;
  }

  private async pendingCandidate(candidateId: string) {
    let candidate = await this.dependencies.repository.getCandidate(candidateId);
    if (candidate?.approvalIntent) candidate = await this.reconcileApprovalIntent(candidate);
    if (!candidate) throw new Error('추천 후보를 찾을 수 없습니다.');
    if (candidate.status !== 'pending') throw new Error('이미 처리되었거나 다시 검토해야 하는 추천입니다.');
    if (!this.dependencies.registry.getBookEnrichmentProvider(candidate.provenance.contributionId)) {
      throw new Error('해당 추천 제공자가 꺼져 있거나 사용할 수 없습니다.');
    }
    const current = await this.dependencies.books.getNovel(candidate.bookId);
    const stale =
      !current ||
      (current.metadataRevision ?? 0) !== candidate.baseMetadataRevision ||
      (candidate.baseContentRevisionId !== undefined &&
        current.activeContentRevisionId !== candidate.baseContentRevisionId);
    if (stale) {
      await this.dependencies.repository.updateCandidateStatus(candidate.id, 'stale', 'revision_changed');
      throw new BookEnrichmentCandidateConflictError(candidate.id);
    }
    return { candidate, current };
  }

  private approvalReceipt(
    candidate: BookEnrichmentCandidate,
    intent: BookEnrichmentApprovalIntent,
    appliedMetadataRevision: number,
    after: BookEnrichmentMutationSnapshot,
    appliedAt = new Date().toISOString(),
  ): BookEnrichmentApprovalReceipt {
    return {
      schemaVersion: BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
      id: persistentId128('book_enrichment_approval', [candidate.id, String(appliedMetadataRevision)]),
      action: 'apply',
      candidateId: candidate.id,
      bookId: candidate.bookId,
      kind: candidate.kind,
      baseMetadataRevision: candidate.baseMetadataRevision,
      appliedMetadataRevision,
      selectedFields: intent.selectedFields,
      beforeHash: snapshotHash(intent.before),
      afterHash: snapshotHash(after),
      before: intent.before,
      after,
      provenance: candidate.provenance,
      appliedAt,
      approvalOperationId: intent.operationId,
    };
  }

  private async reconcileApprovalIntent(candidate: BookEnrichmentCandidate): Promise<BookEnrichmentCandidate> {
    const intent = candidate.approvalIntent;
    if (!intent) return candidate;
    const current = await this.dependencies.books.getNovel(candidate.bookId);
    if (
      !current ||
      current.deletedAt ||
      intent.schemaVersion !== BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION ||
      intent.kind !== candidate.kind ||
      intent.baseMetadataRevision !== candidate.baseMetadataRevision ||
      intent.before.kind !== candidate.kind ||
      intent.expected.kind !== candidate.kind
    ) {
      return (
        (await this.dependencies.repository.resolveApprovalIntent(
          candidate.id,
          intent.operationId,
          'stale',
          'approval_recovery_ambiguous',
        )) ?? candidate
      );
    }

    const actualRevision = current.metadataRevision ?? 0;
    const activeCover =
      candidate.kind === 'cover' ? await this.dependencies.assets.getActiveCover(candidate.bookId) : undefined;
    const actual =
      candidate.kind === 'metadata'
        ? metadataMutationSnapshot(current, intent.selectedFields)
        : coverMutationSnapshot(current, activeCover?.metadata);
    const matchesBefore =
      candidate.kind === 'metadata'
        ? metadataSnapshotsEqual(actual, intent.before)
        : coverSnapshotsEqual(actual, intent.before);
    const matchesExpected =
      candidate.kind === 'metadata'
        ? metadataSnapshotsEqual(actual, intent.expected)
        : coverMatchesExpectedApplied(actual, intent.expected);

    if (actualRevision === intent.baseMetadataRevision + 1 && matchesExpected) {
      const receipt = this.approvalReceipt(candidate, intent, actualRevision, actual, current.updatedAt);
      await this.dependencies.repository.recordApproval(candidate.id, receipt, intent.operationId);
      await this.dependencies.repository
        .reconcileCandidatesAfterApproval(candidate, actualRevision)
        .catch(() => undefined);
      return (await this.dependencies.repository.getCandidate(candidate.id)) ?? candidate;
    }
    if (actualRevision === intent.baseMetadataRevision && matchesBefore) {
      if (approvalIntentIsFresh(intent)) return candidate;
      return (
        (await this.dependencies.repository.resolveApprovalIntent(candidate.id, intent.operationId, 'pending')) ??
        candidate
      );
    }
    return (
      (await this.dependencies.repository.resolveApprovalIntent(
        candidate.id,
        intent.operationId,
        'stale',
        'approval_recovery_ambiguous',
      )) ?? candidate
    );
  }

  private async reconcileApprovalIntents(bookId: string): Promise<BookEnrichmentCandidate[]> {
    const candidates = await this.dependencies.repository.listCandidates(bookId);
    const reconciled: BookEnrichmentCandidate[] = [];
    for (const candidate of candidates) {
      reconciled.push(candidate.approvalIntent ? await this.reconcileApprovalIntent(candidate) : candidate);
    }
    return reconciled;
  }

  private async recoverApprovalReceiptAfterMutationError(
    candidate: BookEnrichmentCandidate,
  ): Promise<BookEnrichmentApprovalReceipt | undefined> {
    const reconciled = await this.reconcileApprovalIntent(candidate);
    if (reconciled.status !== 'applied') return undefined;
    return this.dependencies.repository.getReceipt(
      persistentId128('book_enrichment_approval', [candidate.id, String(candidate.baseMetadataRevision + 1)]),
    );
  }

  private async recordApproval(
    candidate: BookEnrichmentCandidate,
    intent: BookEnrichmentApprovalIntent,
    appliedMetadataRevision: number,
    after: BookEnrichmentMutationSnapshot,
  ) {
    const receipt = this.approvalReceipt(candidate, intent, appliedMetadataRevision, after);
    await this.dependencies.repository.recordApproval(candidate.id, receipt, intent.operationId);
    // The canonical mutation and approval receipt form the safety boundary. Candidate
    // cleanup is derived state and must not turn a durable approval into a reported
    // failure that callers then try to compensate.
    await this.dependencies.repository
      .reconcileCandidatesAfterApproval(candidate, appliedMetadataRevision)
      .catch(() => undefined);
    return receipt;
  }

  private async markRolledBackApprovalFailure(candidate: BookEnrichmentCandidate, error: unknown): Promise<never> {
    const operationId = candidate.approvalIntent?.operationId;
    await (
      operationId
        ? this.dependencies.repository.resolveApprovalIntent(
            candidate.id,
            operationId,
            'stale',
            'approval_record_failed_rolled_back',
          )
        : this.dependencies.repository.updateCandidateStatus(
            candidate.id,
            'stale',
            'approval_record_failed_rolled_back',
          )
    ).catch(() => undefined);
    throw error;
  }

  private async markConflictIfRevisionChanged(candidate: BookEnrichmentCandidate, error: unknown): Promise<never> {
    const current = await this.dependencies.books.getNovel(candidate.bookId).catch(() => undefined);
    if (!current || (current.metadataRevision ?? 0) !== candidate.baseMetadataRevision) {
      await this.dependencies.repository.updateCandidateStatus(candidate.id, 'stale', 'revision_changed');
      throw new BookEnrichmentCandidateConflictError(candidate.id);
    }
    throw error;
  }

  async applyMetadata(candidateId: string, selectedFields: readonly BookEnrichmentMetadataField[]) {
    const { candidate, current } = await this.pendingCandidate(candidateId);
    if (candidate.kind !== 'metadata') throw new Error('메타데이터 추천 후보가 아닙니다.');
    const patch = selectMetadataCandidateFields(candidate, selectedFields);
    const fields = BOOK_ENRICHMENT_METADATA_FIELDS.filter(
      (field) => selectedFields.includes(field) && candidate.patch[field] !== undefined,
    );
    if (fields.length === 0) throw new Error('적용할 작품 정보가 없습니다.');
    const before = metadataMutationSnapshot(current, fields);
    if (before.kind !== 'metadata') throw new Error('작품 정보 복구 기준이 올바르지 않습니다.');
    const expected = expectedMetadataMutationSnapshot(patch, fields);
    const intent: BookEnrichmentApprovalIntent = {
      schemaVersion: BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION,
      operationId: persistentId128('book_enrichment_approval_intent', [
        candidate.id,
        String(candidate.baseMetadataRevision),
        snapshotHash(before),
        snapshotHash(expected),
      ]),
      stagedAt: new Date().toISOString(),
      kind: 'metadata',
      baseMetadataRevision: candidate.baseMetadataRevision,
      selectedFields: fields,
      before,
      expected,
    };
    const stagedCandidate = await this.dependencies.repository.stageApprovalIntent(candidate.id, intent);
    const effectiveIntent = stagedCandidate.approvalIntent ?? intent;
    let mutation: Awaited<ReturnType<LibraryCatalogRepository['patchMetadata']>>;
    try {
      mutation = await this.dependencies.catalog.patchMetadata(candidate.bookId, patch, {
        metadataRevision: candidate.baseMetadataRevision,
        activeContentRevisionId: candidate.baseContentRevisionId,
      });
    } catch (error) {
      const recovered = await this.recoverApprovalReceiptAfterMutationError(stagedCandidate);
      if (recovered) return recovered;
      return this.markConflictIfRevisionChanged(stagedCandidate, error);
    }

    try {
      const updated = await this.dependencies.books.getNovel(candidate.bookId);
      if (!updated) throw new Error('적용한 작품 정보를 다시 불러오지 못했습니다.');
      return await this.recordApproval(
        stagedCandidate,
        effectiveIntent,
        mutation.metadataRevision,
        metadataMutationSnapshot(updated, fields),
      );
    } catch (error) {
      try {
        await this.dependencies.catalog.patchMetadata(candidate.bookId, before.values, {
          metadataRevision: mutation.metadataRevision,
          activeContentRevisionId: candidate.baseContentRevisionId,
        });
      } catch (rollbackError) {
        throw Object.assign(new Error('작품 정보는 적용됐지만 승인 기록과 자동 복구를 완료하지 못했습니다.'), {
          cause: rollbackError,
        });
      }
      return this.markRolledBackApprovalFailure(stagedCandidate, error);
    }
  }

  async applyCover(candidateId: string, layout?: { fit: 'crop' | 'contain'; positionX: number; positionY: number }) {
    const { candidate, current } = await this.pendingCandidate(candidateId);
    if (candidate.kind !== 'cover') throw new Error('표지 추천 후보가 아닙니다.');
    if (!candidate.provenance.licenseSummary?.trim()) {
      throw new Error('사용 조건이 확인되지 않은 표지는 적용할 수 없습니다.');
    }
    const saveApprovedEnrichmentCover = this.dependencies.assets.saveApprovedEnrichmentCover;
    const restoreApprovedEnrichmentCover = this.dependencies.assets.restoreApprovedEnrichmentCover;
    if (!saveApprovedEnrichmentCover) {
      throw new Error('현재 저장소는 승인된 추천 표지의 안전한 복원을 지원하지 않습니다.');
    }
    if (!restoreApprovedEnrichmentCover) {
      throw new Error('현재 저장소는 승인된 추천 표지의 자동 복구를 지원하지 않습니다.');
    }
    await validateStoredCover(candidate);
    const cover = {
      ...candidate.cover,
      ...(layout ?? {}),
      expectedMetadataRevision: candidate.baseMetadataRevision,
      expectedContentRevisionId: candidate.baseContentRevisionId,
    };
    const activeCover = await this.dependencies.assets.getActiveCover(candidate.bookId);
    const before = coverMutationSnapshot(current, activeCover?.metadata);
    if (before.kind !== 'cover') throw new Error('표지 복구 기준이 올바르지 않습니다.');
    const expected = expectedCoverMutationSnapshot(cover);
    const intent: BookEnrichmentApprovalIntent = {
      schemaVersion: BOOK_ENRICHMENT_APPROVAL_INTENT_SCHEMA_VERSION,
      operationId: persistentId128('book_enrichment_approval_intent', [
        candidate.id,
        String(candidate.baseMetadataRevision),
        snapshotHash(before),
        snapshotHash(expected),
      ]),
      stagedAt: new Date().toISOString(),
      kind: 'cover',
      baseMetadataRevision: candidate.baseMetadataRevision,
      selectedFields: [],
      before,
      expected,
    };
    const stagedCandidate = await this.dependencies.repository.stageApprovalIntent(candidate.id, intent);
    const effectiveIntent = stagedCandidate.approvalIntent ?? intent;
    let mutation: Awaited<ReturnType<NonNullable<BookAssetRepository['saveApprovedEnrichmentCover']>>>;
    try {
      mutation = await saveApprovedEnrichmentCover.call(this.dependencies.assets, candidate.bookId, cover);
    } catch (error) {
      const recovered = await this.recoverApprovalReceiptAfterMutationError(stagedCandidate);
      if (recovered) return recovered;
      return this.markConflictIfRevisionChanged(stagedCandidate, error);
    }

    try {
      const updated = await this.dependencies.books.getNovel(candidate.bookId);
      if (!updated) throw new Error('적용한 표지를 다시 불러오지 못했습니다.');
      return await this.recordApproval(
        stagedCandidate,
        effectiveIntent,
        mutation.metadataRevision,
        coverMutationSnapshot(updated, mutation.current),
      );
    } catch (error) {
      try {
        await restoreApprovedEnrichmentCover.call(this.dependencies.assets, candidate.bookId, {
          expectedMetadataRevision: mutation.metadataRevision,
          expectedContentRevisionId: candidate.baseContentRevisionId,
          expectedActiveAssetId: mutation.current.id,
          expectedActiveContentHash: mutation.current.contentHash,
          previousAssetId: before.cover.assetId,
          previousContentHash: before.cover.contentHash,
          previousFit: before.cover.fit,
          previousPositionX: before.cover.positionX,
          previousPositionY: before.cover.positionY,
        });
      } catch (rollbackError) {
        throw Object.assign(new Error('표지는 적용됐지만 승인 기록과 자동 복구를 완료하지 못했습니다.'), {
          cause: rollbackError,
        });
      }
      return this.markRolledBackApprovalFailure(stagedCandidate, error);
    }
  }

  reject(candidateId: string) {
    return this.dependencies.repository.updateCandidateStatus(candidateId, 'rejected', 'user_rejected');
  }

  async undo(receiptId: string): Promise<BookEnrichmentApprovalReceipt> {
    const approval = await this.dependencies.repository.getReceipt(receiptId);
    if (
      !approval ||
      approval.schemaVersion !== BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION ||
      approval.action !== 'apply' ||
      !approval.before ||
      !approval.after ||
      snapshotHash(approval.before) !== approval.beforeHash ||
      snapshotHash(approval.after) !== approval.afterHash
    ) {
      throw new BookEnrichmentUndoConflictError(receiptId);
    }
    const receipts = await this.dependencies.repository.listReceipts(approval.bookId);
    if (receipts.some((receipt) => receipt.action === 'undo' && receipt.approvalReceiptId === approval.id)) {
      throw new BookEnrichmentUndoConflictError(receiptId);
    }
    const current = await this.dependencies.books.getNovel(approval.bookId);
    if (!current) {
      throw new BookEnrichmentUndoConflictError(receiptId);
    }

    let appliedMetadataRevision: number;
    let restoredSnapshot: BookEnrichmentMutationSnapshot;
    try {
      if (approval.kind === 'metadata') {
        if (approval.before.kind !== 'metadata' || approval.after.kind !== 'metadata') {
          throw new BookEnrichmentUndoConflictError(receiptId);
        }
        const currentSnapshot = metadataMutationSnapshot(current, approval.selectedFields);
        if (snapshotHash(currentSnapshot) !== approval.afterHash) {
          throw new BookEnrichmentUndoConflictError(receiptId);
        }
        const mutation = await this.dependencies.catalog.patchMetadata(
          approval.bookId,
          approval.before.values,
          {
            metadataRevision: current.metadataRevision ?? 0,
            activeContentRevisionId: current.activeContentRevisionId,
          },
        );
        const updated = await this.dependencies.books.getNovel(approval.bookId);
        if (!updated) throw new BookEnrichmentUndoConflictError(receiptId);
        appliedMetadataRevision = mutation.metadataRevision;
        restoredSnapshot = metadataMutationSnapshot(updated, approval.selectedFields);
      } else {
        if (
          approval.before.kind !== 'cover' ||
          approval.after.kind !== 'cover' ||
          !approval.after.cover.assetId ||
          !approval.after.cover.contentHash ||
          !this.dependencies.assets.restoreApprovedEnrichmentCover
        ) {
          throw new BookEnrichmentUndoConflictError(receiptId);
        }
        const activeCover = await this.dependencies.assets.getActiveCover(approval.bookId);
        const currentSnapshot = coverMutationSnapshot(current, activeCover?.metadata);
        if (snapshotHash(currentSnapshot) !== approval.afterHash) {
          throw new BookEnrichmentUndoConflictError(receiptId);
        }
        const mutation = await this.dependencies.assets.restoreApprovedEnrichmentCover(approval.bookId, {
          expectedMetadataRevision: current.metadataRevision ?? 0,
          expectedContentRevisionId: current.activeContentRevisionId,
          expectedActiveAssetId: approval.after.cover.assetId,
          expectedActiveContentHash: approval.after.cover.contentHash,
          previousAssetId: approval.before.cover.assetId,
          previousContentHash: approval.before.cover.contentHash,
          previousFit: approval.before.cover.fit,
          previousPositionX: approval.before.cover.positionX,
          previousPositionY: approval.before.cover.positionY,
        });
        const updated = await this.dependencies.books.getNovel(approval.bookId);
        if (!updated) throw new BookEnrichmentUndoConflictError(receiptId);
        appliedMetadataRevision = mutation.metadataRevision;
        restoredSnapshot = coverMutationSnapshot(updated, mutation.current);
      }
    } catch (error) {
      if (error instanceof BookEnrichmentUndoConflictError) throw error;
      throw new BookEnrichmentUndoConflictError(receiptId);
    }

    if (snapshotHash(restoredSnapshot) !== approval.beforeHash) {
      throw new Error('되돌린 작품 정보가 승인 이전 기록과 일치하지 않습니다.');
    }
    const appliedAt = new Date().toISOString();
    const undoReceipt: BookEnrichmentApprovalReceipt = {
      schemaVersion: BOOK_ENRICHMENT_RECEIPT_SCHEMA_VERSION,
      id: persistentId128('book_enrichment_undo', [approval.id, String(appliedMetadataRevision)]),
      action: 'undo',
      approvalReceiptId: approval.id,
      candidateId: approval.candidateId,
      bookId: approval.bookId,
      kind: approval.kind,
      baseMetadataRevision: approval.appliedMetadataRevision,
      appliedMetadataRevision,
      selectedFields: approval.selectedFields,
      beforeHash: approval.afterHash,
      afterHash: approval.beforeHash,
      before: approval.after,
      after: restoredSnapshot,
      provenance: approval.provenance,
      appliedAt,
    };
    await this.dependencies.repository.recordUndo(undoReceipt);
    return undoReceipt;
  }
}
