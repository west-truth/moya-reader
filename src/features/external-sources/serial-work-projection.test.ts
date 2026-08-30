import { describe, expect, it } from 'vitest';
import type { ExternalItemSummary, ExternalSourceLink } from '../../external-sources/contracts';
import { testChapter, testNovel } from '../book-workspace/book-workspace-test-fixtures';
import {
  externalReleaseRevisionChanged,
  projectLocalSeries,
  projectLocalSeriesReadingStates,
} from './serial-work-projection';

describe('projectLocalSeries', () => {
  it('does not treat Suwayomi page-count cache fill as a chapter update', () => {
    const item = {
      key: { connectorId: 'moya.external.suwayomi', remoteId: 'chapter:73' },
      remoteRevision: '73:1788000200',
    };

    expect(externalReleaseRevisionChanged(item, '73::1788000200')).toBe(false);
    expect(externalReleaseRevisionChanged(item, '73:62:1788000200')).toBe(false);
    expect(externalReleaseRevisionChanged(item, '73:62:1788000300')).toBe(true);
  });

  it('projects fixed-document pages into ordered release rows and keeps remote link identity', () => {
    const novel = testNovel({
      format: 'image_archive',
      title: '서른의 봄',
      documentSectionCount: 2,
      totalChapters: 3,
    });
    const chapters = [
      testChapter(1, {
        documentSectionId: 'chapter:11',
        documentSectionTitle: '01화',
        documentSectionIndex: 1,
      }),
      testChapter(2, {
        documentSectionId: 'chapter:11',
        documentSectionTitle: '01화',
        documentSectionIndex: 1,
      }),
      testChapter(3, {
        documentSectionId: 'chapter:12',
        documentSectionTitle: '02화',
        documentSectionIndex: 2,
      }),
    ];
    const link: ExternalSourceLink = {
      id: 'link-11',
      source: {
        connectorId: 'moya.external.suwayomi',
        accountConnectionId: 'local-suwayomi',
        remoteId: 'chapter:11',
      },
      localBookId: novel.id,
      collectionRemoteId: 'manga:1',
      importedRemoteRevision: '11:2:0',
      linkedAt: novel.createdAt,
    };

    const projection = projectLocalSeries(novel, chapters, [link]);

    expect(projection.items).toMatchObject([
      {
        key: link.source,
        title: '01화',
        subtitle: '2페이지',
        collection: { remoteId: 'manga:1' },
        release: { sourceOrder: 1 },
      },
      {
        key: { connectorId: 'moya.local.serial', remoteId: 'chapter:12' },
        title: '02화',
        subtitle: '1페이지',
        release: { sourceOrder: 2 },
      },
    ]);
    expect(projection.links).toHaveLength(2);
    expect(projection.links[1]).toMatchObject({ localBookId: novel.id, source: projection.items[1]?.key });
  });

  it('projects an ordinary local comic archive as its first mergeable release', () => {
    const novel = testNovel({
      format: 'image_archive',
      title: '로컬 만화',
      sourceFileName: '로컬 만화 1화.cbz',
      documentSectionCount: undefined,
      totalChapters: 12,
    });
    const projection = projectLocalSeries(
      novel,
      Array.from({ length: 12 }, (_, index) => testChapter(index + 1)),
      [],
    );

    expect(projection.items).toMatchObject([
      {
        key: { connectorId: 'moya.local.serial', remoteId: `local-legacy:${novel.id}` },
        title: '1화',
        subtitle: '12페이지',
      },
    ]);
    expect(projection.links).toHaveLength(1);
  });

  it('keeps legacy hosted release pages grouped without guessing skipped state while Suwayomi is offline', () => {
    const novel = testNovel({
      format: 'image_archive',
      title: '기존 연동 만화',
      documentSectionCount: 2,
      totalChapters: 3,
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, {
        title: '1화 · 1페이지',
        documentSectionTitle: '1화',
        documentSectionIndex: 1,
      }),
      testChapter(2, { title: '1화 · 2페이지', documentSectionTitle: '1화', documentSectionIndex: 1 }),
      testChapter(3, { title: '2화 · 1페이지', documentSectionTitle: '2화', documentSectionIndex: 2 }),
    ];

    const projection = projectLocalSeries(novel, chapters, []);

    expect(projection.items).toMatchObject([
      { title: '1화', subtitle: '2페이지', release: { sourceOrder: 1 } },
      { title: '2화', subtitle: '1페이지', release: { sourceOrder: 2 } },
    ]);
    expect([...projectLocalSeriesReadingStates(novel, chapters, [], { allowSequentialFallback: false })]).toEqual([
      [`local-section:${novel.id}:1`, 'unread'],
      [`local-section:${novel.id}:2`, 'current'],
    ]);
  });

  it('keeps the legacy sequential projection for local archives without durable section markers', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, { documentSectionId: 'local:1', documentSectionTitle: '1화', documentSectionIndex: 1 }),
      testChapter(2, { documentSectionId: 'local:1', documentSectionTitle: '1화', documentSectionIndex: 1 }),
      testChapter(3, { documentSectionId: 'local:2', documentSectionTitle: '2화', documentSectionIndex: 2 }),
      testChapter(4, { documentSectionId: 'local:3', documentSectionTitle: '3화', documentSectionIndex: 3 }),
    ];

    expect([...projectLocalSeriesReadingStates(novel, chapters)]).toEqual([
      ['local:1', 'read'],
      ['local:2', 'current'],
      ['local:3', 'unread'],
    ]);
  });

  it('projects previous, current and following comic releases from the saved page identity', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, {
        documentSectionId: 'release:1',
        documentSectionTitle: '1화',
        documentSectionIndex: 1,
        documentSectionReadAt: '2026-08-30T01:00:00.000Z',
      }),
      testChapter(2, { documentSectionId: 'release:1', documentSectionTitle: '1화', documentSectionIndex: 1 }),
      testChapter(3, { documentSectionId: 'release:2', documentSectionTitle: '2화', documentSectionIndex: 2 }),
      testChapter(4, { documentSectionId: 'release:3', documentSectionTitle: '3화', documentSectionIndex: 3 }),
    ];

    expect([...projectLocalSeriesReadingStates(novel, chapters)]).toEqual([
      ['release:1', 'read'],
      ['release:2', 'current'],
      ['release:3', 'unread'],
    ]);
    expect([
      ...projectLocalSeriesReadingStates(
        { ...novel, lastReadChapterId: undefined, lastReadChapterIndex: undefined, lastReadProgress: 0 },
        chapters,
      ),
    ]).toEqual([
      ['release:1', 'read'],
      ['release:2', 'unread'],
      ['release:3', 'unread'],
    ]);
  });

  it('projects canonical document section ids around the saved fixed-document page', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, {
        documentSectionId: 'chapter:101',
        documentSectionTitle: '1화',
        documentSectionIndex: 1,
        documentSectionReadAt: '2026-08-30T01:00:00.000Z',
      }),
      testChapter(2, { documentSectionId: 'chapter:101', documentSectionTitle: '1화', documentSectionIndex: 1 }),
      testChapter(3, { documentSectionId: 'chapter:102', documentSectionTitle: '2화', documentSectionIndex: 2 }),
      testChapter(4, { documentSectionId: 'chapter:103', documentSectionTitle: '3화', documentSectionIndex: 3 }),
    ];

    expect([...projectLocalSeriesReadingStates(novel, chapters)]).toEqual([
      ['chapter:101', 'read'],
      ['chapter:102', 'current'],
      ['chapter:103', 'unread'],
    ]);
  });

  it('recovers section ids for legacy hosted pages from unique remote release titles', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, { title: '1화 · 1페이지', documentSectionReadAt: '2026-08-30T01:00:00.000Z' }),
      testChapter(2, { title: '1화 · 2페이지' }),
      testChapter(3, { title: '2화 · 1페이지' }),
      testChapter(4, { title: '2화 · 2페이지' }),
      testChapter(5, { title: '3화 · 1페이지' }),
    ];
    const remoteItems = [
      {
        key: { connectorId: 'moya.external.suwayomi', remoteId: 'chapter:101' },
        kind: 'file',
        title: '1화',
        release: { title: '1화', sourceOrder: 1 },
        importability: 'supported',
      },
      {
        key: { connectorId: 'moya.external.suwayomi', remoteId: 'chapter:102' },
        kind: 'file',
        title: '2화',
        release: { title: '2화', sourceOrder: 2 },
        importability: 'supported',
      },
      {
        key: { connectorId: 'moya.external.suwayomi', remoteId: 'chapter:103' },
        kind: 'file',
        title: '3화',
        release: { title: '3화', sourceOrder: 3 },
        importability: 'supported',
      },
    ] satisfies readonly ExternalItemSummary[];

    expect([...projectLocalSeriesReadingStates(novel, chapters, remoteItems)]).toEqual([
      ['chapter:101', 'read'],
      ['chapter:102', 'current'],
      ['chapter:103', 'unread'],
    ]);
  });

  it('does not mark skipped fixed-document releases read when a later release is opened', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-6',
      lastReadChapterIndex: 6,
      lastReadProgress: 1,
    });
    const chapters = Array.from({ length: 6 }, (_, index) => {
      const release = index + 1;
      return testChapter(release, {
        documentSectionId: `chapter:${release}`,
        documentSectionTitle: `${release}화`,
        documentSectionIndex: release,
        documentSectionReadAt: release <= 3 || release === 6 ? `2026-08-30T01:0${release}:00.000Z` : undefined,
      });
    });

    expect([...projectLocalSeriesReadingStates(novel, chapters)]).toEqual([
      ['chapter:1', 'read'],
      ['chapter:2', 'read'],
      ['chapter:3', 'read'],
      ['chapter:4', 'unread'],
      ['chapter:5', 'unread'],
      ['chapter:6', 'current'],
    ]);
  });
});
