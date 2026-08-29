import { describe, expect, it, vi } from 'vitest';
import type { LabeledSegment } from '../domain/types';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultBookV1,
  type CloudVaultContentProvider,
  type CloudVaultSnapshotV1,
} from './contracts';
import { CloudVaultAiTtsTransferService } from './ai-tts-transfer';

const passphrase = 'correct horse battery staple';

function segment(): LabeledSegment {
  return {
    id: 'segment-1',
    novelId: 'book-1',
    chapterId: 'chapter-1',
    paragraphId: 'paragraph-1',
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 3,
    segmentTextHash: 'text-hash',
    type: 'quoted_dialogue',
    speakerId: 'character-1',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: 1,
    isUserCorrected: true,
  };
}

function book(withAi: boolean): CloudVaultBookV1 {
  return {
    identity: {
      bookId: 'book-1',
      normalizedTextHash: 'book-hash',
      format: 'txt',
      title: 'Book',
      favorite: false,
      metadataRevision: 1,
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    revisions: {
      metadataAt: '2026-08-29T00:00:00.000Z',
      readerAt: '2026-08-29T00:00:00.000Z',
      annotationsAt: '2026-08-29T00:00:00.000Z',
      statisticsAt: '2026-08-29T00:00:00.000Z',
      aiTtsAt: '2026-08-29T00:00:00.000Z',
    },
    chapters: [{ id: 'chapter-1', index: 1, title: '1', textHash: 'chapter-hash' }],
    paragraphs: [
      { id: 'paragraph-1', chapterId: 'chapter-1', chapterIndex: 1, paragraphIndex: 0, textHash: 'text-hash' },
    ],
    bookmarks: [],
    highlights: [],
    notes: [],
    readingSessions: [],
    characters: [],
    characterRelations: [],
    segments: withAi ? [segment()] : [],
    voiceProfiles: [],
    corrections: [],
  };
}

function snapshot(item: CloudVaultBookV1): CloudVaultSnapshotV1 {
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt: '2026-08-29T00:00:00.000Z',
    deviceId: 'device-1',
    scope: DEFAULT_CLOUD_VAULT_SCOPE,
    books: [item],
    shelves: [],
    shelfMemberships: [],
    tombstones: [],
  };
}

function memoryProvider() {
  const objects = new Map<string, Blob>();
  const provider: CloudVaultContentProvider = {
    kind: 'directory',
    label: 'memory',
    read: async () => undefined,
    write: async () => ({ revision: 'revision' }),
    getObject: vi.fn(async (key) => {
      const blob = objects.get(key);
      return blob ? { blob } : undefined;
    }),
    putObject: vi.fn(async (key, blob) => {
      if (objects.has(key)) return { created: false };
      objects.set(key, blob);
      return { created: true };
    }),
  };
  return { objects, provider };
}

describe('Cloud Vault per-book AI/TTS transfer', () => {
  it('externalizes inline artifacts and restores only the referenced work file', async () => {
    const transfer = new CloudVaultAiTtsTransferService();
    const { provider } = memoryProvider();
    const externalized = await transfer.externalize(snapshot(book(true)), provider, passphrase);

    expect(externalized.report.uploadedAiTtsFiles).toBe(1);
    expect(externalized.snapshot.books[0]?.segments).toEqual([]);
    expect(externalized.snapshot.books[0]?.aiTtsObject?.objectKey).toMatch(/^ai-tts\/v1\/sha256\//);

    const restored = await transfer.hydrateRemote(externalized.snapshot, snapshot(book(false)), provider, passphrase);
    expect(restored.report.restoredAiTtsFiles).toBe(1);
    expect(restored.snapshot?.books[0]?.segments).toHaveLength(1);
  });

  it('does not download a sidecar already applied on this device', async () => {
    const transfer = new CloudVaultAiTtsTransferService();
    const { provider } = memoryProvider();
    const externalized = await transfer.externalize(snapshot(book(true)), provider, passphrase);
    const descriptor = externalized.snapshot.books[0]!.aiTtsObject!;
    vi.mocked(provider.getObject).mockClear();

    const restored = await transfer.hydrateRemote(externalized.snapshot, snapshot(book(true)), provider, passphrase, {
      'book-hash': descriptor.objectKey,
    });

    expect(provider.getObject).not.toHaveBeenCalled();
    expect(restored.report.restoredAiTtsFiles).toBe(0);
  });
});
