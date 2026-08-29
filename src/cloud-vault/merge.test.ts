import { describe, expect, it } from 'vitest';
import type { Bookmark, DocumentAnnotation, DocumentTextOrderOverride, LabeledSegment } from '../domain/types';
import {
  CLOUD_VAULT_FORMAT,
  CLOUD_VAULT_VERSION,
  DEFAULT_CLOUD_VAULT_SCOPE,
  type CloudVaultBookV1,
  type CloudVaultSnapshotV1,
} from './contracts';
import { mergeCloudVaultSnapshots } from './merge';

function segment(id: string, corrected: boolean): LabeledSegment {
  return {
    id,
    novelId: 'book-a',
    chapterId: 'chapter-a',
    paragraphId: 'paragraph-a',
    segmentIndex: 0,
    startOffset: 0,
    endOffset: 4,
    segmentTextHash: 'hash',
    type: 'quoted_dialogue',
    speakerId: corrected ? 'character-user' : 'unknown',
    candidateSpeakers: [],
    listenerIds: [],
    emotion: 'neutral',
    confidence: corrected ? 1 : 0.2,
    isUserCorrected: corrected,
  };
}

function book(input: {
  updatedAt: string;
  bookmarks?: Bookmark[];
  documentAnnotations?: DocumentAnnotation[];
  documentTextOrderOverrides?: DocumentTextOrderOverride[];
  segments?: LabeledSegment[];
}): CloudVaultBookV1 {
  return {
    identity: {
      bookId: 'book-a',
      normalizedTextHash: 'same-book-hash',
      format: 'txt',
      title: 'Book',
      favorite: false,
      metadataRevision: 1,
      updatedAt: input.updatedAt,
    },
    revisions: {
      metadataAt: input.updatedAt,
      readerAt: input.updatedAt,
      annotationsAt: input.updatedAt,
      statisticsAt: input.updatedAt,
      aiTtsAt: input.updatedAt,
    },
    chapters: [],
    paragraphs: [],
    bookmarks: input.bookmarks ?? [],
    highlights: [],
    notes: [],
    documentAnnotations: input.documentAnnotations ?? [],
    documentTextOrderOverrides: input.documentTextOrderOverrides ?? [],
    readingSessions: [],
    characters: [],
    characterRelations: [],
    segments: input.segments ?? [],
    voiceProfiles: [],
    corrections: [],
  };
}

function snapshot(deviceId: string, item: CloudVaultBookV1): CloudVaultSnapshotV1 {
  return {
    format: CLOUD_VAULT_FORMAT,
    version: CLOUD_VAULT_VERSION,
    generatedAt: item.identity.updatedAt,
    deviceId,
    scope: DEFAULT_CLOUD_VAULT_SCOPE,
    books: [item],
    shelves: [],
    shelfMemberships: [],
    tombstones: [],
  };
}

describe('cloud vault merge', () => {
  it('merges annotations by entity timestamp and preserves user-corrected AI output', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const local = snapshot(
      'local',
      book({
        updatedAt: older,
        bookmarks: [
          {
            id: 'bookmark-a',
            novelId: 'book-a',
            chapterId: 'chapter-a',
            label: 'local old',
            progress: 0.2,
            scrollTop: 2,
            createdAt: older,
          },
        ],
        segments: [segment('segment-a', true)],
      }),
    );
    const remote = snapshot(
      'remote',
      book({
        updatedAt: newer,
        bookmarks: [
          {
            id: 'bookmark-a',
            novelId: 'book-a',
            chapterId: 'chapter-a',
            label: 'remote new',
            progress: 0.8,
            scrollTop: 8,
            createdAt: newer,
          },
        ],
        segments: [segment('segment-a', false)],
      }),
    );

    const merged = mergeCloudVaultSnapshots(local, remote, newer);
    expect(merged.books[0]?.bookmarks[0]?.label).toBe('remote new');
    expect(merged.books[0]?.segments[0]?.speakerId).toBe('character-user');
  });

  it('keeps a remote book when its source has not been imported on this device', () => {
    const remote = snapshot('remote', book({ updatedAt: '2026-08-01T00:00:00.000Z' }));
    const local: CloudVaultSnapshotV1 = {
      ...remote,
      deviceId: 'local',
      books: [],
    };
    expect(mergeCloudVaultSnapshots(local, remote).books).toHaveLength(1);
  });

  it('keeps the current device scope authoritative', () => {
    const item = book({ updatedAt: '2026-08-01T00:00:00.000Z' });
    const remote = snapshot('remote', item);
    const local: CloudVaultSnapshotV1 = {
      ...snapshot('local', item),
      scope: {
        ...DEFAULT_CLOUD_VAULT_SCOPE,
        annotations: false,
        aiTtsArtifacts: false,
      },
    };

    expect(mergeCloudVaultSnapshots(local, remote).scope).toEqual(local.scope);
  });

  it('merges fixed-document annotations and applies their deletion tombstones', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const annotation: DocumentAnnotation = {
      id: 'document-annotation-a',
      bookId: 'book-a',
      pageIndex: 1,
      type: 'text_note',
      anchor: {
        kind: 'fixed_text',
        bookId: 'book-a',
        pageIndex: 1,
        textRevisionId: 'revision-a',
        blockId: 'block-a',
        startOffset: 0,
        endOffset: 4,
        quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }],
      },
      quote: 'quote',
      body: 'old note',
      color: 'yellow',
      createdAt: older,
      updatedAt: older,
    };
    const local = snapshot('local', book({ updatedAt: older, documentAnnotations: [annotation] }));
    const remote = snapshot(
      'remote',
      book({
        updatedAt: newer,
        documentAnnotations: [{ ...annotation, body: 'new note', updatedAt: newer }],
      }),
    );

    expect(mergeCloudVaultSnapshots(local, remote, newer).books[0]?.documentAnnotations?.[0]?.body).toBe('new note');

    const deleted = mergeCloudVaultSnapshots(local, {
      ...remote,
      books: [],
      tombstones: [
        {
          id: `document_annotation:${annotation.id}`,
          entityType: 'document_annotation',
          entityId: annotation.id,
          bookHash: 'same-book-hash',
          deletedAt: newer,
        },
      ],
    });
    expect(deleted.books[0]?.documentAnnotations).toEqual([]);
  });

  it('merges PDF reading-order overrides and keeps a remote reset deleted', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const override: DocumentTextOrderOverride = {
      id: 'vault-order-page-1',
      bookId: 'book-a',
      pageIndex: 1,
      pageHash: 'page-hash',
      sourceRevisionId: 'revision-a',
      orderedBlockFingerprints: ['first', 'second'],
      excludedBlockFingerprints: [],
      createdAt: older,
      updatedAt: older,
    };
    const local = snapshot('local', book({ updatedAt: older, documentTextOrderOverrides: [override] }));
    const remote = snapshot(
      'remote',
      book({
        updatedAt: newer,
        documentTextOrderOverrides: [{ ...override, orderedBlockFingerprints: ['second', 'first'], updatedAt: newer }],
      }),
    );

    expect(mergeCloudVaultSnapshots(local, remote, newer).books[0]?.documentTextOrderOverrides?.[0]).toMatchObject({
      orderedBlockFingerprints: ['second', 'first'],
      updatedAt: newer,
    });

    const deleted = mergeCloudVaultSnapshots(local, {
      ...remote,
      books: [],
      tombstones: [
        {
          id: `document_text_order_override:${override.id}`,
          entityType: 'document_text_order_override',
          entityId: override.id,
          bookHash: 'same-book-hash',
          pageIndex: 1,
          deletedAt: newer,
        },
      ],
    });
    expect(deleted.books[0]?.documentTextOrderOverrides).toEqual([]);
  });

  it('keeps anchor references from devices with different local ids', () => {
    const updatedAt = '2026-08-01T00:00:00.000Z';
    const localBook: CloudVaultBookV1 = {
      ...book({ updatedAt }),
      chapters: [{ id: 'chapter-local', index: 0, title: '1화', textHash: 'chapter-hash' }],
      paragraphs: [
        {
          id: 'paragraph-local',
          chapterId: 'chapter-local',
          chapterIndex: 0,
          paragraphIndex: 0,
          textHash: 'paragraph-hash',
        },
      ],
    };
    const remoteBook: CloudVaultBookV1 = {
      ...book({ updatedAt }),
      chapters: [{ id: 'chapter-remote', index: 0, title: '1화', textHash: 'chapter-hash' }],
      paragraphs: [
        {
          id: 'paragraph-remote',
          chapterId: 'chapter-remote',
          chapterIndex: 0,
          paragraphIndex: 0,
          textHash: 'paragraph-hash',
        },
      ],
    };

    const merged = mergeCloudVaultSnapshots(snapshot('local', localBook), snapshot('remote', remoteBook));
    expect(merged.books[0]?.chapters.map((item) => item.id)).toEqual(['chapter-local', 'chapter-remote']);
    expect(merged.books[0]?.paragraphs.map((item) => item.id)).toEqual(['paragraph-local', 'paragraph-remote']);
  });

  it('keeps one stable book across content hash revisions and promotes a legacy hash match', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const remoteBook = {
      ...book({ updatedAt: older }),
      identity: {
        ...book({ updatedAt: older }).identity,
        vaultBookId: 'vault-shared',
        normalizedTextHash: 'old-content-hash',
      },
    };
    const localBook = {
      ...book({ updatedAt: newer }),
      identity: {
        ...book({ updatedAt: newer }).identity,
        vaultBookId: 'vault-shared',
        normalizedTextHash: 'new-content-hash',
      },
    };
    const merged = mergeCloudVaultSnapshots(snapshot('local', localBook), snapshot('remote', remoteBook), newer);
    expect(merged.books).toHaveLength(1);
    expect(merged.books[0]?.identity).toMatchObject({
      vaultBookId: 'vault-shared',
      normalizedTextHash: 'new-content-hash',
    });

    const legacyLocal = book({ updatedAt: newer });
    const promoted = mergeCloudVaultSnapshots(
      snapshot('local', legacyLocal),
      snapshot('remote', {
        ...book({ updatedAt: older }),
        identity: { ...book({ updatedAt: older }).identity, vaultBookId: 'vault-established' },
      }),
      newer,
    );
    expect(promoted.books).toHaveLength(1);
    expect(promoted.books[0]?.identity.vaultBookId).toBe('vault-established');
  });

  it('selects body ownership independently from newer library metadata', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const middle = '2026-08-02T00:00:00.000Z';
    const newer = '2026-08-03T00:00:00.000Z';
    const localNewBody: CloudVaultBookV1 = {
      ...book({ updatedAt: older }),
      identity: {
        ...book({ updatedAt: older }).identity,
        vaultBookId: 'vault-shared',
        normalizedTextHash: 'new-body',
        title: 'old metadata title',
      },
      revisions: {
        ...book({ updatedAt: older }).revisions,
        contentAt: newer,
        contentDeviceId: 'device-a',
      },
      chapters: [{ id: 'chapter-new', index: 0, title: 'new', textHash: 'new-chapter' }],
      sourceObject: {
        kind: 'source',
        objectKey: `content/v1/sha256/${'a'.repeat(64)}`,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteLength: 10,
        contentType: 'text/plain',
        fileName: 'new.txt',
      },
    };
    const remoteNewMetadata: CloudVaultBookV1 = {
      ...book({ updatedAt: middle }),
      identity: {
        ...book({ updatedAt: middle }).identity,
        vaultBookId: 'vault-shared',
        normalizedTextHash: 'old-body',
        title: 'new metadata title',
      },
      revisions: {
        ...book({ updatedAt: middle }).revisions,
        contentAt: older,
        contentDeviceId: 'device-b',
      },
      chapters: [{ id: 'chapter-old', index: 0, title: 'old', textHash: 'old-chapter' }],
      sourceObject: {
        kind: 'source',
        objectKey: `content/v1/sha256/${'b'.repeat(64)}`,
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteLength: 9,
        contentType: 'text/plain',
        fileName: 'old.txt',
      },
    };

    const merged = mergeCloudVaultSnapshots(
      snapshot('device-a', localNewBody),
      snapshot('device-b', remoteNewMetadata),
      newer,
    );

    expect(merged.books[0]?.identity).toMatchObject({
      title: 'new metadata title',
      normalizedTextHash: 'new-body',
    });
    expect(merged.books[0]?.revisions).toMatchObject({ contentAt: newer, contentDeviceId: 'device-a' });
    expect(merged.books[0]?.chapters.map((chapter) => chapter.id)).toEqual(['chapter-new']);
    expect(merged.books[0]?.sourceObject?.fileName).toBe('new.txt');
  });

  it('uses the content clock for newer raw sources even when normalized text is unchanged', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const local: CloudVaultBookV1 = {
      ...book({ updatedAt: older }),
      identity: { ...book({ updatedAt: older }).identity, vaultBookId: 'vault-shared', format: 'epub' },
      revisions: {
        ...book({ updatedAt: older }).revisions,
        contentAt: newer,
        contentDeviceId: 'device-new-source',
      },
      chapters: [{ id: 'chapter-local', index: 0, title: 'local', textHash: 'same-chapter' }],
      sourceObject: {
        kind: 'source',
        objectKey: `content/v1/sha256/${'c'.repeat(64)}`,
        contentHash: `sha256:${'c'.repeat(64)}`,
        byteLength: 12,
        contentType: 'application/epub+zip',
        fileName: 'updated.epub',
      },
    };
    const remote: CloudVaultBookV1 = {
      ...book({ updatedAt: newer }),
      identity: { ...book({ updatedAt: newer }).identity, vaultBookId: 'vault-shared', format: 'txt' },
      revisions: {
        ...book({ updatedAt: newer }).revisions,
        contentAt: older,
        contentDeviceId: 'device-old-source',
      },
      chapters: [{ id: 'chapter-remote', index: 0, title: 'remote', textHash: 'same-chapter' }],
      sourceObject: {
        kind: 'source',
        objectKey: `content/v1/sha256/${'d'.repeat(64)}`,
        contentHash: `sha256:${'d'.repeat(64)}`,
        byteLength: 9,
        contentType: 'text/plain',
        fileName: 'old.txt',
      },
    };

    const merged = mergeCloudVaultSnapshots(snapshot('local', local), snapshot('remote', remote), newer);

    expect(merged.books[0]?.identity.format).toBe('epub');
    expect(merged.books[0]?.sourceObject?.fileName).toBe('updated.epub');
    expect(merged.books[0]?.chapters.map((chapter) => chapter.id)).toEqual(['chapter-local', 'chapter-remote']);

    const pendingUpload = mergeCloudVaultSnapshots(
      snapshot('local', { ...local, sourceObject: undefined }),
      snapshot('remote', remote),
      newer,
    );
    expect(pendingUpload.books[0]?.sourceObject).toBeUndefined();
  });

  it('merges listening position by its own clock', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const newer = '2026-08-02T00:00:00.000Z';
    const position = (updatedAt: string, pageIndex: number) => ({
      id: 'listening-position',
      bookId: 'book-a',
      chapterId: 'chapter-a',
      anchor: { kind: 'fixed_page' as const, bookId: 'book-a', pageIndex, pageHash: `page-${pageIndex}` },
      queueItemFingerprint: `queue-${pageIndex}`,
      contentRevisionId: 'revision-a',
      settingsFingerprint: 'settings-a',
      deviceId: 'device-a',
      updatedAt,
    });
    const local = snapshot('local', { ...book({ updatedAt: newer }), listeningPosition: position(newer, 2) });
    const remote = snapshot('remote', { ...book({ updatedAt: older }), listeningPosition: position(older, 1) });

    expect(mergeCloudVaultSnapshots(local, remote, newer).books[0]?.listeningPosition?.anchor).toMatchObject({
      pageIndex: 2,
    });
  });

  it('propagates book and cover deletion while allowing a newer restore or replacement', () => {
    const older = '2026-08-01T00:00:00.000Z';
    const deletedAt = '2026-08-02T00:00:00.000Z';
    const restoredAt = '2026-08-03T00:00:00.000Z';
    const withCover = {
      ...book({ updatedAt: older }),
      identity: { ...book({ updatedAt: older }).identity, vaultBookId: 'vault-a', coverUpdatedAt: older },
      coverObject: {
        kind: 'cover' as const,
        objectKey: 'content/v1/sha256/cover',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteLength: 1,
        contentType: 'image/png',
        fileName: 'cover.png',
      },
    };
    const remote = {
      ...snapshot('remote', withCover),
      books: [],
      tombstones: [
        {
          id: 'book:vault-a',
          entityType: 'book' as const,
          entityId: 'vault-a',
          vaultBookId: 'vault-a',
          bookHash: 'same-book-hash',
          deletedAt,
        },
        {
          id: 'cover:vault-a',
          entityType: 'cover' as const,
          entityId: 'vault-a',
          vaultBookId: 'vault-a',
          bookHash: 'same-book-hash',
          deletedAt,
        },
      ],
    };
    expect(mergeCloudVaultSnapshots(snapshot('local', withCover), remote, deletedAt).books).toEqual([]);

    const restored = {
      ...withCover,
      identity: { ...withCover.identity, updatedAt: restoredAt, coverUpdatedAt: restoredAt },
      revisions: { ...withCover.revisions, metadataAt: restoredAt },
    };
    const mergedRestore = mergeCloudVaultSnapshots(snapshot('local', restored), remote, restoredAt);
    expect(mergedRestore.books).toHaveLength(1);
    expect(mergedRestore.books[0]?.coverObject).toBeDefined();
  });

  it('keeps a shelf membership re-added after its deletion tombstone', () => {
    const item = book({ updatedAt: '2026-08-01T00:00:00.000Z' });
    const local = {
      ...snapshot('local', item),
      shelfMemberships: [
        {
          id: 'membership-a',
          shelfId: 'shelf-a',
          bookHash: item.identity.normalizedTextHash,
          createdAt: '2026-08-03T00:00:00.000Z',
        },
      ],
    };
    const remote = {
      ...snapshot('remote', item),
      shelfMemberships: [],
      tombstones: [
        {
          id: 'shelf_membership:membership-a',
          entityType: 'shelf_membership' as const,
          entityId: 'membership-a',
          bookHash: item.identity.normalizedTextHash,
          shelfId: 'shelf-a',
          deletedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    };

    expect(mergeCloudVaultSnapshots(local, remote).shelfMemberships).toHaveLength(1);
  });
});
