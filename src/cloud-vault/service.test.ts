import { describe, expect, it, vi } from 'vitest';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  CloudVaultWriteConflictError,
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultArtifactRepository,
  type CloudVaultBookV1,
  type CloudVaultContentProvider,
  type CloudVaultFileProvider,
  type CloudVaultSnapshotV1,
} from './contracts';
import type { CloudVaultContentTransferService } from './content-transfer';
import { decryptCloudVault, encryptCloudVault } from './crypto';
import { CloudVaultService } from './service';

function snapshot(): CloudVaultSnapshotV1 {
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt: '2026-08-28T00:00:00.000Z',
    deviceId: 'web-device',
    scope: DEFAULT_CLOUD_VAULT_SCOPE,
    books: [],
    shelves: [],
    shelfMemberships: [],
    tombstones: [],
  };
}

function contentBook(input: {
  hash: string;
  metadataAt: string;
  contentAt: string;
  contentDeviceId: string;
  title: string;
}): CloudVaultBookV1 {
  return {
    identity: {
      bookId: `book-${input.contentDeviceId}`,
      vaultBookId: 'vault-shared',
      normalizedTextHash: input.hash,
      format: 'txt',
      title: input.title,
      favorite: false,
      metadataRevision: 1,
      updatedAt: input.metadataAt,
    },
    revisions: {
      contentAt: input.contentAt,
      contentDeviceId: input.contentDeviceId,
      metadataAt: input.metadataAt,
      readerAt: input.metadataAt,
      annotationsAt: input.metadataAt,
      statisticsAt: input.metadataAt,
      aiTtsAt: input.metadataAt,
    },
    chapters: [],
    paragraphs: [],
    bookmarks: [],
    highlights: [],
    notes: [],
    readingSessions: [],
    characters: [],
    characterRelations: [],
    segments: [],
    voiceProfiles: [],
    corrections: [],
  };
}

describe('CloudVaultService', () => {
  it('commits the independently selected body owner through the content transfer stage', async () => {
    const passphrase = 'correct horse battery staple';
    const scope = { ...DEFAULT_CLOUD_VAULT_SCOPE, sourceFiles: true };
    const local = {
      ...snapshot(),
      scope,
      books: [
        contentBook({
          hash: 'new-body',
          metadataAt: '2026-08-01T00:00:00.000Z',
          contentAt: '2026-08-03T00:00:00.000Z',
          contentDeviceId: 'local',
          title: 'old metadata',
        }),
      ],
    };
    const remote = {
      ...snapshot(),
      deviceId: 'remote',
      scope,
      books: [
        contentBook({
          hash: 'old-body',
          metadataAt: '2026-08-02T00:00:00.000Z',
          contentAt: '2026-08-01T00:00:00.000Z',
          contentDeviceId: 'remote',
          title: 'new metadata',
        }),
      ],
    };
    let stored = await encryptCloudVault(remote, passphrase);
    const provider: CloudVaultContentProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => ({ bytes: stored, revision: 'rev-1' }),
      write: async (bytes) => {
        stored = bytes;
        return { revision: 'rev-2' };
      },
      getObject: async () => undefined,
      putObject: async () => ({ created: false }),
    };
    const apply = vi.fn(async () => ({
      matchedBooks: 1,
      waitingForSourceBooks: 0,
      appliedRecords: 0,
      quarantinedRecords: 0,
      waitingBookTitles: [],
    }));
    const uploadLocalContent = vi.fn(async (merged: CloudVaultSnapshotV1) => ({
      snapshot: merged,
      report: {
        uploadedSourceFiles: 0,
        restoredSourceFiles: 0,
        uploadedContentBytes: 0,
        downloadedContentBytes: 0,
        contentFailures: [],
      },
    }));
    const content = {
      uploadLocalContent,
      restoreMissingContent: async () => ({
        uploadedSourceFiles: 0,
        restoredSourceFiles: 0,
        uploadedContentBytes: 0,
        downloadedContentBytes: 0,
        contentFailures: [],
      }),
    } as unknown as CloudVaultContentTransferService;
    const service = new CloudVaultService({ capture: async () => local, apply }, content);

    await service.sync({ provider, passphrase, deviceId: 'local', scope });

    expect(uploadLocalContent).toHaveBeenCalledWith(
      expect.objectContaining({
        books: [
          expect.objectContaining({
            identity: expect.objectContaining({ normalizedTextHash: 'new-body', title: 'new metadata' }),
          }),
        ],
      }),
      provider,
      local,
    );
    await expect(decryptCloudVault(stored, passphrase)).resolves.toMatchObject({
      books: [
        {
          identity: { normalizedTextHash: 'new-body', title: 'new metadata' },
          revisions: { contentAt: '2026-08-03T00:00:00.000Z', contentDeviceId: 'local' },
        },
      ],
    });
  });

  it('does not apply remote state until the manifest CAS succeeds', async () => {
    const apply = vi.fn(async () => ({
      matchedBooks: 0,
      waitingForSourceBooks: 0,
      appliedRecords: 0,
      quarantinedRecords: 0,
      waitingBookTitles: [],
    }));
    const service = new CloudVaultService({ capture: async () => snapshot(), apply });
    const provider: CloudVaultFileProvider = {
      kind: 'directory',
      label: 'conflict',
      read: async () => undefined,
      write: async () => {
        throw new CloudVaultWriteConflictError();
      },
    };

    await expect(
      service.sync({
        provider,
        passphrase: 'correct horse battery staple',
        deviceId: 'web-device',
        scope: DEFAULT_CLOUD_VAULT_SCOPE,
      }),
    ).rejects.toBeInstanceOf(CloudVaultWriteConflictError);
    expect(apply).not.toHaveBeenCalled();
  });

  it('retries instead of applying over a local mutation that occurred during network work', async () => {
    const original = snapshot();
    const changed = {
      ...snapshot(),
      shelves: [{ id: 'new', name: 'new', sortOrder: 0, createdAt: 'now', updatedAt: 'now', revision: 1 }],
    };
    let captures = 0;
    const apply = vi.fn(async () => ({
      matchedBooks: 0,
      waitingForSourceBooks: 0,
      appliedRecords: 0,
      quarantinedRecords: 0,
      waitingBookTitles: [],
    }));
    const service = new CloudVaultService({
      capture: async () => (++captures % 2 === 1 ? original : changed),
      apply,
    });
    let revision = 0;
    let stored: Uint8Array | undefined;
    const provider: CloudVaultFileProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => (stored ? { bytes: stored, revision: `rev-${revision}` } : undefined),
      write: async (bytes) => {
        stored = bytes;
        revision += 1;
        return { revision: `rev-${revision}` };
      },
    };

    await expect(
      service.sync({
        provider,
        passphrase: 'correct horse battery staple',
        deviceId: 'web-device',
        scope: DEFAULT_CLOUD_VAULT_SCOPE,
      }),
    ).rejects.toBeInstanceOf(CloudVaultWriteConflictError);
    expect(apply).not.toHaveBeenCalled();
    expect(revision).toBeGreaterThan(0);
  });

  it('keeps the metadata-only v1 path compatible when content sync is disabled', async () => {
    let stored: Uint8Array | undefined;
    const provider: CloudVaultFileProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => (stored ? { bytes: stored, revision: 'rev-1' } : undefined),
      write: async (bytes) => {
        stored = bytes;
        return { revision: 'rev-1' };
      },
    };
    const artifacts: CloudVaultArtifactRepository = {
      capture: vi.fn(async () => snapshot()),
      apply: vi.fn(async () => ({
        matchedBooks: 0,
        waitingForSourceBooks: 0,
        appliedRecords: 0,
        quarantinedRecords: 0,
        waitingBookTitles: [],
      })),
    };
    const service = new CloudVaultService(artifacts);

    const report = await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });

    expect(report).toMatchObject({
      uploadedSourceFiles: 0,
      restoredSourceFiles: 0,
      uploadedContentBytes: 0,
      downloadedContentBytes: 0,
      contentFailures: [],
    });
    expect(stored).toBeDefined();
    await expect(decryptCloudVault(stored!, 'correct horse battery staple')).resolves.toMatchObject({
      version: 1,
      scope: { sourceFiles: false },
    });
  });

  it('skips rewriting an unchanged encrypted manifest', async () => {
    let stored: Uint8Array | undefined;
    const write = vi.fn(async (bytes: Uint8Array) => {
      stored = bytes;
      return { revision: 'rev-1' };
    });
    const provider: CloudVaultFileProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => (stored ? { bytes: stored, revision: 'rev-1' } : undefined),
      write,
    };
    const artifacts: CloudVaultArtifactRepository = {
      capture: vi.fn(async () => snapshot()),
      apply: vi.fn(async () => ({
        matchedBooks: 0,
        waitingForSourceBooks: 0,
        appliedRecords: 0,
        quarantinedRecords: 0,
        waitingBookTitles: [],
      })),
    };
    const service = new CloudVaultService(artifacts);
    await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });
    const second = await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(second.uploadedBytes).toBe(0);
  });

  it('re-reads an unchanged manifest when its remote revision advanced during sync', async () => {
    let stored: Uint8Array | undefined;
    let revision = 'rev-1';
    let probes = 0;
    const write = vi.fn(async (bytes: Uint8Array) => {
      stored = bytes;
      return { revision };
    });
    const provider: CloudVaultFileProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => (stored ? { bytes: stored, revision } : undefined),
      getRevision: async () => {
        probes += 1;
        if (probes === 1) revision = 'rev-2';
        return revision;
      },
      write,
    };
    const apply = vi.fn(async () => ({
      matchedBooks: 0,
      waitingForSourceBooks: 0,
      appliedRecords: 0,
      quarantinedRecords: 0,
      waitingBookTitles: [],
    }));
    const service = new CloudVaultService({ capture: async () => snapshot(), apply });

    await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });
    const report = await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(probes).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(report.remoteRevision).toBe('rev-2');
    expect(report.uploadedBytes).toBe(0);
  });

  it('migrates inline AI/TTS arrays into an encrypted per-book object', async () => {
    const item = {
      identity: {
        bookId: 'book-1',
        normalizedTextHash: 'book-hash',
        format: 'txt',
        title: 'Book',
        favorite: false,
        metadataRevision: 1,
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
      revisions: {
        metadataAt: '2026-08-28T00:00:00.000Z',
        readerAt: '2026-08-28T00:00:00.000Z',
        annotationsAt: '2026-08-28T00:00:00.000Z',
        statisticsAt: '2026-08-28T00:00:00.000Z',
        aiTtsAt: '2026-08-28T00:00:00.000Z',
      },
      chapters: [],
      paragraphs: [],
      bookmarks: [],
      highlights: [],
      notes: [],
      readingSessions: [],
      characters: [],
      characterRelations: [],
      segments: [],
      voiceProfiles: [
        {
          id: 'voice-1',
          novelId: 'book-1',
          characterId: 'character-1',
          role: 'character' as const,
          providerId: 'system',
          providerVoiceId: 'voice',
          label: 'Voice',
          speed: 1,
          isUserSelected: true,
        },
      ],
      corrections: [],
    };
    const local = { ...snapshot(), books: [item] } satisfies CloudVaultSnapshotV1;
    let stored: Uint8Array | undefined;
    const objects = new Map<string, Blob>();
    const provider: CloudVaultContentProvider = {
      kind: 'directory',
      label: 'memory',
      read: async () => (stored ? { bytes: stored, revision: 'rev-1' } : undefined),
      write: async (bytes) => {
        stored = bytes;
        return { revision: 'rev-1' };
      },
      getObject: async (key) => {
        const blob = objects.get(key);
        return blob ? { blob } : undefined;
      },
      putObject: async (key, blob) => {
        objects.set(key, blob);
        return { created: true };
      },
    };
    const service = new CloudVaultService({
      capture: async () => local,
      apply: async () => ({
        matchedBooks: 1,
        waitingForSourceBooks: 0,
        appliedRecords: 0,
        quarantinedRecords: 0,
        waitingBookTitles: [],
      }),
    });
    const report = await service.sync({
      provider,
      passphrase: 'correct horse battery staple',
      deviceId: 'web-device',
      scope: DEFAULT_CLOUD_VAULT_SCOPE,
    });
    const persisted = await decryptCloudVault(stored!, 'correct horse battery staple');

    expect(report.uploadedAiTtsFiles).toBe(1);
    expect(persisted.books[0]?.voiceProfiles).toEqual([]);
    expect(persisted.books[0]?.aiTtsObject?.objectKey).toMatch(/^ai-tts\/v1\/sha256\//);
  });
});
