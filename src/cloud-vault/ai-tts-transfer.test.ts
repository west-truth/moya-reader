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
import { decryptCloudVault, encryptCloudVault, isAccountCloudVault } from './crypto';
import { CloudVaultService } from './service';

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

describe('account-only Cloud Vault migration', () => {
  it.each([true, false])('preserves remote-only AI/TTS data with selected scope %s', async (aiTtsArtifacts) => {
    const { provider: objectsProvider, objects } = memoryProvider();
    const transfer = new CloudVaultAiTtsTransferService();
    const original = snapshot(book(true));
    const legacy = await transfer.externalize(original, objectsProvider, passphrase);
    const oldKey = legacy.snapshot.books[0]!.aiTtsObject!.objectKey;
    let stored = await encryptCloudVault(legacy.snapshot, passphrase);
    const provider = {
      ...objectsProvider,
      read: async () => ({ bytes: stored, revision: 'revision' }),
      write: vi.fn(async (bytes: Uint8Array) => {
        stored = bytes;
        return { revision: 'revision' };
      }),
    };
    const local = { ...original, scope: { ...original.scope, aiTtsArtifacts }, books: [] };
    const apply = vi.fn(async () => ({
      matchedBooks: 0,
      waitingForSourceBooks: 1,
      appliedRecords: 0,
      quarantinedRecords: 0,
      waitingBookTitles: ['Book'],
    }));
    const service = new CloudVaultService({ capture: async () => local, apply });
    const input = { provider, deviceId: 'new-device', scope: local.scope, accountAccess: true };
    await expect(service.sync({ ...input, passphrase: '' })).rejects.toThrow('legacy_cloud_vault_passphrase_required');
    expect(provider.write).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    await service.sync({ ...input, passphrase });
    expect(isAccountCloudVault(stored)).toBe(true);
    const converted = await decryptCloudVault(stored, '');
    const hydrated = await transfer.hydrateRemote(converted, original, provider, '');
    expect(hydrated.report.contentFailures).toEqual([]);
    expect(hydrated.snapshot!.books[0]!.segments).toEqual(original.books[0]!.segments);
    expect(objects.has(oldKey)).toBe(true);
    if (aiTtsArtifacts) expect(converted.books[0]!.aiTtsObject!.objectKey).not.toBe(oldKey);
    else expect(converted.books[0]!.aiTtsObject).toBeUndefined();
    await service.sync({ ...input, passphrase: '' });
    expect(provider.write).toHaveBeenCalledTimes(1);
  });

  it('does not replace the old manifest or apply local changes when a legacy sidecar is missing', async () => {
    const { provider: objectsProvider, objects } = memoryProvider();
    const original = snapshot(book(true));
    const legacy = await new CloudVaultAiTtsTransferService().externalize(original, objectsProvider, passphrase);
    const stored = await encryptCloudVault(legacy.snapshot, passphrase);
    objects.clear();
    const provider = {
      ...objectsProvider,
      read: async () => ({ bytes: stored, revision: 'revision' }),
      write: vi.fn(objectsProvider.write),
    };
    const apply = vi.fn();
    const service = new CloudVaultService({ capture: async () => original, apply });
    await expect(
      service.sync({ provider, passphrase, accountAccess: true, deviceId: 'device', scope: original.scope }),
    ).rejects.toThrow();
    expect(provider.write).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await decryptCloudVault(stored, passphrase)).toEqual(legacy.snapshot);
  });
});

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
