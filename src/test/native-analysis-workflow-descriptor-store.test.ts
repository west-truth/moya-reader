import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { structuredIntegrityHash } from '../domain/identity/structured-integrity';
import type { BookAIWorkflowPlan } from '../providers/book-ai-workflow-plan';
import { IndexedDbReaderRepository } from '../repositories/indexeddb-reader-repository';
import type {
  NativeAnalysisWorkflowRepository,
  RevisionPinnedReaderRepository,
} from '../repositories/reader-repository';
import { deleteNovel, getNovel, listSyncOutbox, openReaderDb, resetReaderDbForTests } from '../storage/db';
import { purgeNovel } from '../storage/library-catalog-store';
import {
  getNativeAnalysisWorkflowDescriptor,
  nativeAnalysisWorkflowDescriptorFingerprint,
  nativeLabelingContractFingerprint,
  NATIVE_LABELING_CONTRACT_VERSION,
  saveNativeAnalysisWorkflowDescriptor,
  type NativeLabelingContract,
  type NativeAnalysisWorkflowDescriptorInput,
} from '../storage/native-analysis-workflow';
import { NATIVE_ANALYSIS_STORES } from '../storage/native-analysis-workflow/schema';
import { READER_DB_NAME, READER_DB_VERSION } from '../storage/reader-database';

const NOVEL_ID = 'descriptor-book';

const richLabelingContract: NativeLabelingContract = {
  version: NATIVE_LABELING_CONTRACT_VERSION,
  kind: 'rich_chapter_labeling_v2',
  requestProfileId: 'chapter-labeling-v2-strict-tts',
  promptVersion: 'chapter-labeler-v2-context-packet',
  schemaVersion: 'chapter-labeling-v2',
};

function plan(novelId = NOVEL_ID): BookAIWorkflowPlan {
  return {
    novelId,
    totalChapters: 1,
    totalCharacters: 120,
    stages: [
      { id: 'character_graph_bootstrap', itemIds: ['bundle-1'] },
      {
        id: 'character_graph_merge',
        dependsOn: 'character_graph_bootstrap',
        itemIds: ['character_graph_merge'],
      },
      { id: 'chapter_labeling', dependsOn: 'character_graph_merge', itemIds: ['label-window-1'] },
      { id: 'tts_ready_preparation', dependsOn: 'chapter_labeling', itemIds: ['chapter-1'] },
    ],
    bundleWindows: [
      {
        id: 'bundle-1',
        bundleId: 'bundle-1',
        sequence: 0,
        chapterIds: ['chapter-1'],
        startChapterIndex: 1,
        endChapterIndex: 1,
        characterCount: 120,
        textHashFingerprint: 'bundle-fingerprint',
      },
    ],
    labelingChapters: [
      {
        chapterId: 'chapter-1',
        chapterIndex: 1,
        textHash: 'chapter-hash',
        dependsOnGraph: true,
        windows: [
          {
            id: 'label-window-1',
            sequence: 0,
            chapterId: 'chapter-1',
            chapterIndex: 1,
            paragraphIds: ['paragraph-1'],
            startParagraphIndex: 1,
            endParagraphIndex: 1,
            characterCount: 120,
            textHashFingerprint: 'label-fingerprint',
            dependsOnGraph: true,
          },
        ],
      },
    ],
    labelingWindows: [
      {
        id: 'label-window-1',
        sequence: 0,
        chapterId: 'chapter-1',
        chapterIndex: 1,
        paragraphIds: ['paragraph-1'],
        startParagraphIndex: 1,
        endParagraphIndex: 1,
        characterCount: 120,
        textHashFingerprint: 'label-fingerprint',
        dependsOnGraph: true,
      },
    ],
    ttsReady: {
      chapterIds: ['chapter-1'],
      dependsOnLabelingWindowIds: ['label-window-1'],
    },
  };
}

function descriptor(
  overrides: Partial<NativeAnalysisWorkflowDescriptorInput> = {},
): NativeAnalysisWorkflowDescriptorInput {
  return {
    workflowId: 'workflow-1',
    workflowDefinitionId: 'moya.ai.tts.book-preparation',
    workflowVersion: '1.0.0',
    novelId: NOVEL_ID,
    contentRevisionId: 'revision-1',
    planHash: 'sha256:plan-1',
    plan: plan(),
    provider: {
      providerId: 'openai-compatible',
      modelId: 'model-1',
      providerOptions: { temperature: 0.2, metadata: { region: 'local', retries: 2 } },
    },
    ...overrides,
  };
}

async function createV14Database(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(READER_DB_NAME, 14);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('native analysis workflow descriptor store', () => {
  beforeEach(async () => {
    await resetReaderDbForTests();
  });

  it('saves idempotently through the repository without adding sync outbox data', async () => {
    const indexedDbRepository = new IndexedDbReaderRepository();
    const repository: NativeAnalysisWorkflowRepository = indexedDbRepository;
    const revisionSource: RevisionPinnedReaderRepository = indexedDbRepository;
    const input = descriptor();
    const first = await repository.saveNativeAnalysisWorkflowDescriptor(input);
    const second = await repository.saveNativeAnalysisWorkflowDescriptor({
      ...input,
      plan: structuredClone(input.plan),
      provider: {
        ...input.provider,
        providerOptions: { metadata: { retries: 2, region: 'local' }, temperature: 0.2 },
      },
    });

    expect(second).toEqual(first);
    expect(first.descriptorFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.createdAt).toBe(first.updatedAt);
    expect(await repository.getNativeAnalysisWorkflowDescriptor(input.workflowId)).toEqual(first);
    expect(revisionSource.openContentRevision).toBeTypeOf('function');
    expect(await listSyncOutbox()).toEqual([]);
    expect(await repository.deleteNativeAnalysisWorkflowDescriptor(input.workflowId)).toBe(true);
    expect(await repository.deleteNativeAnalysisWorkflowDescriptor(input.workflowId)).toBe(false);
  });

  it('includes durable workflow identity in newly written descriptor fingerprints', () => {
    const input = descriptor();
    expect(nativeAnalysisWorkflowDescriptorFingerprint(input)).toBe(
      structuredIntegrityHash({
        workflowId: input.workflowId,
        novelId: input.novelId,
        contentRevisionId: input.contentRevisionId,
        planHash: input.planHash,
        plan: input.plan,
        provider: input.provider,
        workflowDefinitionId: input.workflowDefinitionId,
        workflowVersion: input.workflowVersion,
      }),
    );
  });

  it('validates the legacy fingerprint before projecting the official default workflow identity', async () => {
    const input = descriptor();
    const legacyPayload = {
      workflowId: input.workflowId,
      novelId: input.novelId,
      contentRevisionId: input.contentRevisionId,
      planHash: input.planHash,
      plan: input.plan,
      provider: input.provider,
    };
    const db = await openReaderDb();
    const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readwrite');
    tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors).put({
      ...legacyPayload,
      descriptorFingerprint: structuredIntegrityHash(legacyPayload),
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    await expect(getNativeAnalysisWorkflowDescriptor(input.workflowId)).resolves.toMatchObject({
      workflowDefinitionId: 'moya.ai.tts.book-preparation',
      workflowVersion: '1.0.0',
      descriptorFingerprint: structuredIntegrityHash(legacyPayload),
    });
  });

  it('pins a versioned labeling contract and rejects stored contract tampering', async () => {
    const saved = await saveNativeAnalysisWorkflowDescriptor(descriptor({ labelingContract: richLabelingContract }));
    expect(saved.labelingContract).toEqual(richLabelingContract);
    expect(saved.labelingContractFingerprint).toBe(nativeLabelingContractFingerprint(richLabelingContract));

    const db = await openReaderDb();
    const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readwrite');
    tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors).put({
      ...saved,
      labelingContract: { ...richLabelingContract, promptVersion: 'tampered-prompt' },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    await expect(getNativeAnalysisWorkflowDescriptor(saved.workflowId)).rejects.toThrow(
      'labeling contract fingerprint mismatch',
    );
  });

  it('rejects descriptor drift and preserves the authoritative record', async () => {
    const input = descriptor();
    const saved = await saveNativeAnalysisWorkflowDescriptor(input);

    await expect(
      saveNativeAnalysisWorkflowDescriptor({
        ...input,
        provider: { ...input.provider, modelId: 'model-2' },
      }),
    ).rejects.toThrow('descriptor drift');
    expect(await getNativeAnalysisWorkflowDescriptor(input.workflowId)).toEqual(saved);
  });

  it('rejects recursive secrets and invalid identifiers before writing', async () => {
    await expect(
      saveNativeAnalysisWorkflowDescriptor(
        descriptor({
          provider: {
            providerId: 'openai-compatible',
            modelId: 'model-1',
            providerOptions: { nested: [{ runtime: { apiKey: 'sk-proj-secret-value' } }] },
          },
        }),
      ),
    ).rejects.toThrow('secret-like');
    await expect(saveNativeAnalysisWorkflowDescriptor(descriptor({ workflowId: 'x'.repeat(513) }))).rejects.toThrow(
      'must not exceed 512 characters',
    );
    await expect(saveNativeAnalysisWorkflowDescriptor(descriptor({ plan: plan('different-book') }))).rejects.toThrow(
      'plan novel id does not match novel id',
    );

    expect(await getNativeAnalysisWorkflowDescriptor('workflow-1')).toBeUndefined();
    expect(await listSyncOutbox()).toEqual([]);
  });

  it('upgrades v14 with the dedicated store and removes descriptors during book cleanup', async () => {
    await createV14Database();
    const db = await openReaderDb();

    expect(db.version).toBe(READER_DB_VERSION);
    expect(db.objectStoreNames.contains(NATIVE_ANALYSIS_STORES.descriptors)).toBe(true);
    const tx = db.transaction(NATIVE_ANALYSIS_STORES.descriptors, 'readonly');
    expect(tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors).keyPath).toBe('workflowId');
    expect(tx.objectStore(NATIVE_ANALYSIS_STORES.descriptors).indexNames.contains('novelId')).toBe(true);

    const seedTx = db.transaction('novels', 'readwrite');
    seedTx.objectStore('novels').put({
      id: NOVEL_ID,
      title: 'Descriptor book',
      sourceFileName: 'descriptor.txt',
      rawText: '',
      normalizedText: '',
      rawTextHash: 'raw',
      normalizedTextHash: 'normalized',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      totalChapters: 0,
      totalCharacters: 0,
      totalParagraphs: 0,
      coverSeed: 0,
      lastReadOffset: 0,
      lastReadProgress: 0,
      favorite: false,
      analysisStatus: 'not_analyzed',
    });
    await new Promise<void>((resolve, reject) => {
      seedTx.oncomplete = () => resolve();
      seedTx.onerror = () => reject(seedTx.error);
      seedTx.onabort = () => reject(seedTx.error);
    });

    await saveNativeAnalysisWorkflowDescriptor(descriptor());
    await deleteNovel(NOVEL_ID);
    const trashedNovel = await getNovel(NOVEL_ID);
    await purgeNovel(NOVEL_ID, trashedNovel?.metadataRevision);
    expect(await getNativeAnalysisWorkflowDescriptor('workflow-1')).toBeUndefined();
  });
});
