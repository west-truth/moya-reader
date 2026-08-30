import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNovelTextForSample } from '../../domain/parser';
import { integrityHash } from '../../domain/id-hash-contract';
import { createAppExtensionRuntime } from '../../extensions/app-extension-runtime';
import {
  LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID,
  libraryBookEnrichmentTrustedExtension,
} from '../../extensions/examples/library-book-enrichment-extension';
import { IndexedDbBookAssetRepository } from '../../repositories/indexeddb-book-asset-repository';
import { IndexedDbBookEnrichmentRepository } from '../../repositories/indexeddb-book-enrichment-repository';
import { IndexedDbLibraryCatalogRepository } from '../../repositories/indexeddb-library-catalog-repository';
import { IndexedDbReaderRepository } from '../../repositories/indexeddb-reader-repository';
import { saveImportedNovel } from '../../storage/db';
import { BOOK_ASSET_STORES, type StoredBookAsset, type StoredBookAssetBlob } from '../../storage/book-asset-schema';
import { requestToPromise, transactionDone } from '../../storage/indexeddb-transaction';
import { openReaderDb, resetReaderDbForTests } from '../../storage/reader-database';
import { listSyncOutbox } from '../../storage/sync-event-store';
import type { BookEnrichmentApprovalIntent, BookEnrichmentCoverCandidate } from './book-enrichment-contract';
import {
  BookEnrichmentCandidateConflictError,
  BookEnrichmentService,
  BookEnrichmentUndoConflictError,
} from './book-enrichment-service';

async function serviceFixture() {
  const parsed = await parseNovelTextForSample('[홍길동] 별의 노래.txt', '1화 시작\n\n별빛이 내렸다.');
  await saveImportedNovel(parsed);
  const repository = new IndexedDbBookEnrichmentRepository();
  const books = new IndexedDbReaderRepository();
  const catalog = new IndexedDbLibraryCatalogRepository();
  const assets = new IndexedDbBookAssetRepository();
  const registry = createAppExtensionRuntime({
    trustedDefinitions: [libraryBookEnrichmentTrustedExtension],
  }).trustedExtensions;
  const service = new BookEnrichmentService({ registry, repository, books, catalog, assets });
  return { parsed, repository, books, catalog, assets, service };
}

function coverCandidate(bookId: string, baseMetadataRevision: number, bytes: Uint8Array): BookEnrichmentCoverCandidate {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `candidate-cover-${baseMetadataRevision}`,
    bookId,
    kind: 'cover',
    status: 'pending',
    baseMetadataRevision,
    baseCover: { present: baseMetadataRevision > 0 },
    cover: {
      blob: new Blob([bytes.slice().buffer], { type: 'image/png' }),
      fileName: 'candidate.png',
      contentType: 'image/png',
      contentHash: integrityHash(bytes),
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'contain',
      positionX: 50,
      positionY: 50,
    },
    derivationFingerprint: 'cover-v1',
    provenance: {
      extensionId: 'test.enrichment',
      extensionVersion: '1.0.0',
      contributionId: LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID,
      origin: 'bundled_trusted',
      registrationFingerprint: 'sha256:registration',
      sourceFingerprints: ['catalog:cover-1'],
      sourceLabel: '테스트 표지 카탈로그',
      licenseSummary: '테스트에서 재사용을 허용한 이미지',
      generatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('BookEnrichmentService', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('keeps proposals local and applies only selected metadata fields through the revision fence', async () => {
    const { parsed, repository, books, service } = await serviceFixture();
    const before = await books.getNovel(parsed.novel.id);
    const outboxBefore = (await listSyncOutbox()).length;

    const proposed = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);

    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ kind: 'metadata', status: 'pending', baseMetadataRevision: 0 });
    expect((await books.getNovel(parsed.novel.id))?.metadataRevision ?? 0).toBe(0);
    expect(await listSyncOutbox()).toHaveLength(outboxBefore);

    const metadataCandidate = proposed[0];
    if (!metadataCandidate || metadataCandidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const receipt = await service.applyMetadata(metadataCandidate.id, ['author']);
    const updated = await books.getNovel(parsed.novel.id);

    expect(updated).toMatchObject({
      title: before?.title,
      author: '홍길동',
      metadataRevision: 1,
    });
    expect(receipt).toMatchObject({ selectedFields: ['author'], baseMetadataRevision: 0, appliedMetadataRevision: 1 });
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      action: 'apply',
      before: { kind: 'metadata', values: { author: null } },
      after: { kind: 'metadata', values: { author: '홍길동' } },
    });
    expect(await repository.listReceipts(parsed.novel.id)).toEqual([receipt]);
    expect((await repository.getCandidate(metadataCandidate.id))?.status).toBe('applied');
    expect(await listSyncOutbox()).toHaveLength(outboxBefore + 1);
  });

  it('restores metadata when the approval receipt cannot be persisted', async () => {
    const { parsed, repository, books, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    vi.spyOn(repository, 'recordApproval').mockRejectedValueOnce(new Error('receipt store unavailable'));

    await expect(service.applyMetadata(candidate.id, ['author'])).rejects.toThrow('receipt store unavailable');

    expect(await books.getNovel(parsed.novel.id)).toMatchObject({ author: undefined, metadataRevision: 2 });
    expect(await repository.listReceipts(parsed.novel.id)).toEqual([]);
    expect(await repository.getCandidate(candidate.id)).toMatchObject({
      status: 'stale',
      statusReason: 'approval_record_failed_rolled_back',
    });
  });

  it('reconstructs a metadata approval receipt from a durable intent after canonical mutation', async () => {
    const { parsed, repository, catalog, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const intent: BookEnrichmentApprovalIntent = {
      schemaVersion: 1,
      operationId: 'metadata-crash-operation',
      stagedAt: new Date().toISOString(),
      kind: 'metadata',
      baseMetadataRevision: 0,
      selectedFields: ['author'],
      before: { kind: 'metadata', values: { author: null } },
      expected: { kind: 'metadata', values: { author: '홍길동' } },
    };
    await repository.stageApprovalIntent(candidate.id, intent);
    await catalog.patchMetadata(candidate.bookId, { author: '홍길동' }, { metadataRevision: 0 });

    const receipts = await service.listReceipts(candidate.bookId);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      candidateId: candidate.id,
      appliedMetadataRevision: 1,
      selectedFields: ['author'],
      approvalOperationId: intent.operationId,
      before: intent.before,
      after: intent.expected,
    });
    expect(await repository.getCandidate(candidate.id)).toMatchObject({
      status: 'applied',
      approvalIntent: undefined,
    });
  });

  it('finishes the durable approval when a metadata mutation commits but its response is lost', async () => {
    const { parsed, repository, books, catalog, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const patchMetadata = catalog.patchMetadata.bind(catalog);
    vi.spyOn(catalog, 'patchMetadata').mockImplementationOnce(async (...args) => {
      expect((await repository.getCandidate(candidate.id))?.approvalIntent).toMatchObject({
        kind: 'metadata',
        selectedFields: ['author'],
        before: { kind: 'metadata', values: { author: null } },
        expected: { kind: 'metadata', values: { author: '홍길동' } },
      });
      await patchMetadata(...args);
      throw new Error('response lost after commit');
    });

    const receipt = await service.applyMetadata(candidate.id, ['author']);

    expect(receipt).toMatchObject({ candidateId: candidate.id, approvalOperationId: expect.any(String) });
    expect(await books.getNovel(candidate.bookId)).toMatchObject({ author: '홍길동', metadataRevision: 1 });
    expect(await repository.getCandidate(candidate.id)).toMatchObject({
      status: 'applied',
      approvalIntent: undefined,
    });
  });

  it('clears an expired durable intent when the canonical metadata mutation never started', async () => {
    const { parsed, repository, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    await repository.stageApprovalIntent(candidate.id, {
      schemaVersion: 1,
      operationId: 'metadata-before-mutation-crash',
      stagedAt: '2000-01-01T00:00:00.000Z',
      kind: 'metadata',
      baseMetadataRevision: 0,
      selectedFields: ['author'],
      before: { kind: 'metadata', values: { author: null } },
      expected: { kind: 'metadata', values: { author: '홍길동' } },
    });

    const [recovered] = await service.listCandidates(candidate.bookId);

    expect(recovered).toMatchObject({ status: 'pending', approvalIntent: undefined });
    expect(await repository.listReceipts(candidate.bookId)).toEqual([]);
  });

  it('undoes an unchanged metadata approval and records a linked forward receipt', async () => {
    const { parsed, repository, books, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const approval = await service.applyMetadata(candidate.id, ['author']);

    const undo = await service.undo(approval.id);

    expect(await books.getNovel(parsed.novel.id)).toMatchObject({ author: undefined, metadataRevision: 2 });
    expect(undo).toMatchObject({
      action: 'undo',
      approvalReceiptId: approval.id,
      baseMetadataRevision: 1,
      appliedMetadataRevision: 2,
      before: approval.after,
      after: approval.before,
    });
    expect(await repository.listReceipts(parsed.novel.id)).toHaveLength(2);
  });

  it('keeps metadata and cover from one resolved match applicable and undoable in sequence', async () => {
    const { parsed, repository, books, assets, service } = await serviceFixture();
    const [proposedMetadata] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!proposedMetadata || proposedMetadata.kind !== 'metadata') throw new Error('metadata candidate missing');
    const proposalGroupId = 'catalog:work-42';
    const metadataCandidate = { ...proposedMetadata, id: `${proposedMetadata.id}-grouped`, proposalGroupId };
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const preparedCover = coverCandidate(parsed.novel.id, 0, candidateBytes);
    const cover = {
      ...preparedCover,
      proposalGroupId,
      provenance: {
        ...preparedCover.provenance,
        extensionId: proposedMetadata.provenance.extensionId,
        contributionId: proposedMetadata.provenance.contributionId,
        registrationFingerprint: proposedMetadata.provenance.registrationFingerprint,
      },
    };
    await repository.updateCandidateStatus(proposedMetadata.id, 'rejected', 'test_replaced');
    await repository.replacePendingCandidates(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID, [
      metadataCandidate,
      cover,
    ]);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );

    try {
      const metadataApproval = await service.applyMetadata(metadataCandidate.id, ['author']);
      expect(await repository.getCandidate(cover.id)).toMatchObject({ status: 'pending', baseMetadataRevision: 1 });

      const coverApproval = await service.applyCover(cover.id, { fit: 'contain', positionX: 50, positionY: 50 });
      expect(await books.getNovel(parsed.novel.id)).toMatchObject({
        author: '홍길동',
        metadataRevision: 2,
      });
      expect((await assets.getActiveCover(parsed.novel.id))?.metadata.provenance).toBe('approved_enrichment');

      await service.undo(coverApproval.id);
      await service.undo(metadataApproval.id);

      expect(await books.getNovel(parsed.novel.id)).toMatchObject({ author: undefined, metadataRevision: 4 });
      expect(await assets.getActiveCover(parsed.novel.id)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not rebase a same-named proposal group from another provider registration', async () => {
    const { parsed, repository, service } = await serviceFixture();
    const [proposedMetadata] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!proposedMetadata || proposedMetadata.kind !== 'metadata') throw new Error('metadata candidate missing');
    const proposalGroupId = 'catalog:shared-name';
    const metadataCandidate = { ...proposedMetadata, id: `${proposedMetadata.id}-provider-a`, proposalGroupId };
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const preparedCover = coverCandidate(parsed.novel.id, 0, candidateBytes);
    const otherProviderCover = {
      ...preparedCover,
      id: `${preparedCover.id}-provider-b`,
      proposalGroupId,
      provenance: {
        ...preparedCover.provenance,
        contributionId: 'another.provider.cover' as const,
        registrationFingerprint: 'sha256:another-registration',
      },
    };
    await repository.updateCandidateStatus(proposedMetadata.id, 'rejected', 'test_replaced');
    await repository.replacePendingCandidates(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID, [
      metadataCandidate,
      otherProviderCover,
    ]);

    await service.applyMetadata(metadataCandidate.id, ['author']);

    expect(await repository.getCandidate(otherProviderCover.id)).toMatchObject({
      status: 'stale',
      baseMetadataRevision: 0,
    });
  });

  it('fails closed when a user edits an approved metadata field before undo', async () => {
    const { parsed, books, catalog, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const approval = await service.applyMetadata(candidate.id, ['author']);
    await catalog.patchMetadata(parsed.novel.id, { author: '직접 수정한 작가' }, {
      metadataRevision: approval.appliedMetadataRevision,
    });

    await expect(service.undo(approval.id)).rejects.toBeInstanceOf(BookEnrichmentUndoConflictError);

    expect(await books.getNovel(parsed.novel.id)).toMatchObject({ author: '직접 수정한 작가', metadataRevision: 2 });
  });

  it('stores an approved enrichment cover separately and restores the retained user cover', async () => {
    const { parsed, repository, books, assets, service } = await serviceFixture();
    const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const original = await assets.saveCover(parsed.novel.id, {
      blob: new Blob([originalBytes], { type: 'image/jpeg' }),
      fileName: 'user.jpg',
      contentType: 'image/jpeg',
      contentHash: integrityHash(originalBytes),
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'crop',
      positionX: 40,
      positionY: 60,
      expectedMetadataRevision: 0,
    });
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const candidate = coverCandidate(parsed.novel.id, 1, candidateBytes);
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );

    try {
      const approval = await service.applyCover(candidate.id, { fit: 'contain', positionX: 50, positionY: 50 });
      expect((await assets.getActiveCover(parsed.novel.id))?.metadata).toMatchObject({
        provenance: 'approved_enrichment',
      });
      expect(approval).toMatchObject({
        action: 'apply',
        before: { kind: 'cover', cover: { assetId: original.id, provenance: 'user_supplied' } },
        after: { kind: 'cover', cover: { provenance: 'approved_enrichment' } },
      });
      await expect(
        assets.saveGeneratedCover(parsed.novel.id, {
          ...candidate.cover,
          derivationFingerprint: 'later-generated-preview',
        }),
      ).resolves.toBeUndefined();

      await service.undo(approval.id);

      expect((await assets.getActiveCover(parsed.novel.id))?.metadata).toMatchObject({
        id: original.id,
        provenance: 'user_supplied',
      });
      expect(await books.getNovel(parsed.novel.id)).toMatchObject({
        coverAssetId: original.id,
        coverFit: 'crop',
        coverPositionX: 40,
        coverPositionY: 60,
        metadataRevision: 3,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('restores the prior cover when the approval receipt cannot be persisted', async () => {
    const { parsed, repository, books, assets, service } = await serviceFixture();
    const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const original = await assets.saveCover(parsed.novel.id, {
      blob: new Blob([originalBytes], { type: 'image/jpeg' }),
      fileName: 'user.jpg',
      contentType: 'image/jpeg',
      contentHash: integrityHash(originalBytes),
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'crop',
      positionX: 40,
      positionY: 60,
      expectedMetadataRevision: 0,
    });
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const candidate = coverCandidate(parsed.novel.id, 1, candidateBytes);
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    vi.spyOn(repository, 'recordApproval').mockRejectedValueOnce(new Error('receipt store unavailable'));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );

    try {
      await expect(service.applyCover(candidate.id)).rejects.toThrow('receipt store unavailable');

      expect((await assets.getActiveCover(parsed.novel.id))?.metadata).toMatchObject({
        id: original.id,
        provenance: 'user_supplied',
      });
      expect(await books.getNovel(parsed.novel.id)).toMatchObject({
        coverAssetId: original.id,
        coverFit: 'crop',
        coverPositionX: 40,
        coverPositionY: 60,
        metadataRevision: 3,
      });
      expect(await repository.listReceipts(parsed.novel.id)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reconstructs a cover approval receipt from the expected hash and layout after a crash', async () => {
    const { parsed, repository, assets, service } = await serviceFixture();
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const candidate = coverCandidate(parsed.novel.id, 0, candidateBytes);
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    const intent: BookEnrichmentApprovalIntent = {
      schemaVersion: 1,
      operationId: 'cover-crash-operation',
      stagedAt: new Date().toISOString(),
      kind: 'cover',
      baseMetadataRevision: 0,
      selectedFields: [],
      before: {
        kind: 'cover',
        cover: { present: false, fit: 'crop', positionX: 50, positionY: 50 },
      },
      expected: {
        kind: 'cover',
        cover: {
          present: true,
          contentHash: candidate.cover.contentHash,
          fit: 'contain',
          positionX: 35,
          positionY: 65,
        },
      },
    };
    await repository.stageApprovalIntent(candidate.id, intent);
    await assets.saveApprovedEnrichmentCover!(candidate.bookId, {
      ...candidate.cover,
      fit: 'contain',
      positionX: 35,
      positionY: 65,
      expectedMetadataRevision: 0,
    });

    const receipts = await service.listReceipts(candidate.bookId);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      candidateId: candidate.id,
      kind: 'cover',
      approvalOperationId: intent.operationId,
      before: intent.before,
      after: {
        kind: 'cover',
        cover: {
          contentHash: candidate.cover.contentHash,
          provenance: 'approved_enrichment',
          fit: 'contain',
          positionX: 35,
          positionY: 65,
        },
      },
    });
    expect(await repository.getCandidate(candidate.id)).toMatchObject({
      status: 'applied',
      approvalIntent: undefined,
    });
  });

  it('does not mistake a same-hash user cover for the staged approved enrichment cover', async () => {
    const { parsed, repository, assets, service } = await serviceFixture();
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const candidate = coverCandidate(parsed.novel.id, 0, candidateBytes);
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    const intent: BookEnrichmentApprovalIntent = {
      schemaVersion: 1,
      operationId: 'cover-same-hash-user-operation',
      stagedAt: new Date().toISOString(),
      kind: 'cover',
      baseMetadataRevision: 0,
      selectedFields: [],
      before: {
        kind: 'cover',
        cover: { present: false, fit: 'crop', positionX: 50, positionY: 50 },
      },
      expected: {
        kind: 'cover',
        cover: {
          present: true,
          contentHash: candidate.cover.contentHash,
          fit: 'contain',
          positionX: 50,
          positionY: 50,
        },
      },
    };
    await repository.stageApprovalIntent(candidate.id, intent);
    await assets.saveCover(candidate.bookId, {
      ...candidate.cover,
      expectedMetadataRevision: 0,
    });

    await service.listCandidates(candidate.bookId);

    expect(await repository.getCandidate(candidate.id)).toMatchObject({
      status: 'stale',
      statusReason: 'approval_recovery_ambiguous',
      approvalIntent: undefined,
    });
    expect(await repository.listReceipts(candidate.bookId)).toEqual([]);
  });

  it('does not mutate the active approved cover when the retained previous blob hash is invalid', async () => {
    const { parsed, repository, books, assets, service } = await serviceFixture();
    const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const original = await assets.saveCover(parsed.novel.id, {
      blob: new Blob([originalBytes], { type: 'image/jpeg' }),
      fileName: 'user.jpg',
      contentType: 'image/jpeg',
      contentHash: integrityHash(originalBytes),
      pixelWidth: 1,
      pixelHeight: 1,
      fit: 'crop',
      positionX: 50,
      positionY: 50,
      expectedMetadataRevision: 0,
    });
    const candidateBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const candidate = coverCandidate(parsed.novel.id, 1, candidateBytes);
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );

    try {
      const approval = await service.applyCover(candidate.id, { fit: 'contain', positionX: 50, positionY: 50 });
      const db = await openReaderDb();
      const tx = db.transaction([BOOK_ASSET_STORES.assets, BOOK_ASSET_STORES.blobs], 'readwrite');
      const done = transactionDone(tx);
      const stored = await requestToPromise<StoredBookAsset>(tx.objectStore(BOOK_ASSET_STORES.assets).get(original.id));
      const blobStore = tx.objectStore(BOOK_ASSET_STORES.blobs);
      const storedBlob = await requestToPromise<StoredBookAssetBlob>(blobStore.get(stored.storageKey));
      blobStore.put({ ...storedBlob, blob: new Blob([new Uint8Array([0x00])]) });
      await done;

      await expect(service.undo(approval.id)).rejects.toBeInstanceOf(BookEnrichmentUndoConflictError);

      expect(await books.getNovel(parsed.novel.id)).toMatchObject({
        coverContentHash: candidate.cover.contentHash,
        metadataRevision: 2,
      });
      expect((await assets.getActiveCover(parsed.novel.id))?.metadata.provenance).toBe('approved_enrichment');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks a candidate stale without another canonical mutation after an intervening edit', async () => {
    const { parsed, repository, books, catalog, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    await catalog.patchMetadata(parsed.novel.id, { favorite: true }, { metadataRevision: 0 });
    const revisionBeforeApply = (await books.getNovel(parsed.novel.id))?.metadataRevision;

    await expect(service.applyMetadata(candidate.id, ['author'])).rejects.toBeInstanceOf(
      BookEnrichmentCandidateConflictError,
    );

    expect(await books.getNovel(parsed.novel.id)).toMatchObject({
      favorite: true,
      metadataRevision: revisionBeforeApply,
    });
    expect(await repository.getCandidate(candidate.id)).toMatchObject({ status: 'stale' });
    expect(await repository.listReceipts(parsed.novel.id)).toEqual([]);
  });

  it('does not apply a stored candidate after its provider contribution is disabled', async () => {
    const { parsed, repository, books, catalog, assets, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    const disabledService = new BookEnrichmentService({
      registry: createAppExtensionRuntime({ trustedDefinitions: [] }).trustedExtensions,
      repository,
      books,
      catalog,
      assets,
    });

    await expect(disabledService.applyMetadata(candidate.id, ['author'])).rejects.toThrow(
      '해당 추천 제공자가 꺼져 있거나 사용할 수 없습니다.',
    );
    expect((await books.getNovel(parsed.novel.id))?.metadataRevision ?? 0).toBe(0);
  });

  it('round-trips a cover candidate Blob in the host-owned local store', async () => {
    const repository = new IndexedDbBookEnrichmentRepository();
    const now = new Date().toISOString();
    const binary = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const candidate: BookEnrichmentCoverCandidate = {
      schemaVersion: 1,
      id: 'candidate-cover-1',
      bookId: 'book-cover-1',
      kind: 'cover',
      status: 'pending',
      baseMetadataRevision: 3,
      baseCover: { present: false },
      cover: {
        blob: binary,
        fileName: 'candidate.png',
        contentType: 'image/png',
        contentHash: 'sha256:test',
        pixelWidth: 1,
        pixelHeight: 1,
        fit: 'contain',
        positionX: 50,
        positionY: 50,
      },
      derivationFingerprint: 'cover-v1',
      provenance: {
        extensionId: 'test.enrichment',
        extensionVersion: '1.0.0',
        contributionId: 'test.enrichment.cover',
        origin: 'bundled_trusted',
        registrationFingerprint: 'sha256:registration',
        sourceFingerprints: [],
        generatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    await repository.replacePendingCandidates(candidate.bookId, candidate.provenance.contributionId, [candidate]);
    const restored = (await repository.listCandidates(candidate.bookId))[0];
    if (!restored || restored.kind !== 'cover') throw new Error('cover candidate missing');
    expect([...new Uint8Array(await restored.cover.blob.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('removes local candidates and receipts when a trashed book is permanently purged', async () => {
    const { parsed, repository, catalog, service } = await serviceFixture();
    const [candidate] = await service.propose(parsed.novel.id, LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID);
    if (!candidate || candidate.kind !== 'metadata') throw new Error('metadata candidate missing');
    await service.applyMetadata(candidate.id, ['author']);
    const trashed = await catalog.moveToTrash(parsed.novel.id, { metadataRevision: 1 });

    await catalog.purge(parsed.novel.id, { metadataRevision: trashed.metadataRevision });

    expect(await repository.listCandidates(parsed.novel.id)).toEqual([]);
    expect(await repository.listReceipts(parsed.novel.id)).toEqual([]);
  });
});
