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
});
