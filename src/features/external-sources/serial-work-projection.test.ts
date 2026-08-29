import { describe, expect, it } from 'vitest';
import type { ExternalSourceLink } from '../../external-sources/contracts';
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

  it('projects previous, current and following comic releases from the saved page identity', () => {
    const novel = testNovel({
      format: 'image_archive',
      lastReadChapterId: 'chapter-3',
      lastReadChapterIndex: 3,
      lastReadProgress: 0.5,
    });
    const chapters = [
      testChapter(1, { documentSectionId: 'release:1', documentSectionTitle: '1화', documentSectionIndex: 1 }),
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
      ['release:1', 'unread'],
      ['release:2', 'unread'],
      ['release:3', 'unread'],
    ]);
  });
});
