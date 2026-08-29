import type { Chapter, Novel } from '../../domain/types';
import type {
  ExternalItemSummary,
  ExternalSourceLink,
  ExternalSourceWorkDetail,
} from '../../external-sources/contracts';
import { parseSerialReleaseName } from '../../domain/serial-release-name';

export type SerialReleaseReadingState = 'current' | 'read' | 'unread';

function comparableRemoteRevision(connectorId: string, remoteId: string, revision: string): string {
  if (!connectorId.startsWith('moya.external.suwayomi') || !remoteId.startsWith('chapter:')) return revision;
  const parts = revision.split(':');
  // v1 included pageCount between chapter id and upload date. It was unstable because
  // Suwayomi can populate it as a side effect of the first download.
  return parts.length >= 3 ? `${parts[0]}:${parts.at(-1)}` : revision;
}

export function externalReleaseRevisionChanged(
  item: Pick<ExternalItemSummary, 'key' | 'remoteRevision'>,
  importedRemoteRevision: string | undefined,
): boolean {
  if (!importedRemoteRevision || !item.remoteRevision) return false;
  return (
    comparableRemoteRevision(item.key.connectorId, item.key.remoteId, importedRemoteRevision) !==
    comparableRemoteRevision(item.key.connectorId, item.key.remoteId, item.remoteRevision)
  );
}

export function localSeriesDetail(novel: Novel): ExternalSourceWorkDetail {
  return {
    title: novel.title,
    author: novel.author,
    description: novel.description,
    tags: novel.tags,
  };
}

export function projectLocalSeriesReadingStates(
  novel: Novel,
  chapters: readonly Chapter[],
): ReadonlyMap<string, SerialReleaseReadingState> {
  const orderedChapters = [...chapters].sort((left, right) => left.index - right.index);
  const hasDocumentSections = orderedChapters.some((chapter) => Boolean(chapter.documentSectionId));
  const legacySectionId = `local-legacy:${novel.id}`;
  const sectionIds = [
    ...new Set(
      orderedChapters.flatMap((chapter) => {
        if (chapter.documentSectionId) return [chapter.documentSectionId];
        return !hasDocumentSections && novel.format === 'image_archive' ? [legacySectionId] : [];
      }),
    ),
  ];
  if (sectionIds.length === 0) return new Map();

  const hasReadActivity = Boolean(
    novel.lastReadChapterId ||
    novel.lastReadChapterIndex !== undefined ||
    novel.lastReadProgress > 0 ||
    novel.lastReadAt,
  );
  if (!hasReadActivity) return new Map(sectionIds.map((sectionId) => [sectionId, 'unread'] as const));

  const currentChapter =
    orderedChapters.find((chapter) => chapter.id === novel.lastReadChapterId) ??
    orderedChapters.find((chapter) => chapter.index === novel.lastReadChapterIndex);
  const currentSectionId = currentChapter?.documentSectionId ?? (!hasDocumentSections ? legacySectionId : undefined);
  const currentSectionIndex = currentSectionId ? sectionIds.indexOf(currentSectionId) : -1;
  if (currentSectionIndex < 0) return new Map(sectionIds.map((sectionId) => [sectionId, 'unread'] as const));

  return new Map(
    sectionIds.map((sectionId, index) => [
      sectionId,
      index < currentSectionIndex ? 'read' : index === currentSectionIndex ? 'current' : 'unread',
    ]),
  );
}

export function projectLocalSeries(
  novel: Novel,
  chapters: readonly Chapter[],
  persistedLinks: readonly ExternalSourceLink[],
): { readonly items: readonly ExternalItemSummary[]; readonly links: readonly ExternalSourceLink[] } {
  const sections = new Map<string, { title: string; index: number; pageCount: number; updatedAt?: string }>();
  [...chapters]
    .sort((left, right) => left.index - right.index)
    .forEach((chapter) => {
      if (!chapter.documentSectionId || !chapter.documentSectionTitle) return;
      const existing = sections.get(chapter.documentSectionId);
      if (existing) {
        existing.pageCount += 1;
        if (chapter.updatedAt > (existing.updatedAt ?? '')) existing.updatedAt = chapter.updatedAt;
        return;
      }
      sections.set(chapter.documentSectionId, {
        title: chapter.documentSectionTitle,
        index: chapter.documentSectionIndex ?? sections.size + 1,
        pageCount: 1,
        updatedAt: chapter.updatedAt,
      });
    });

  const relatedLinks = persistedLinks.filter((link) => link.localBookId === novel.id);
  const syntheticLinks: ExternalSourceLink[] = [];
  if (sections.size === 0 && novel.format === 'image_archive' && chapters.length > 0) {
    const parsed = parseSerialReleaseName(novel.sourceFileName, novel.title);
    sections.set(`local-legacy:${novel.id}`, {
      title: parsed.releaseKey ? parsed.releaseTitle : novel.title,
      index: 1,
      pageCount: chapters.length,
      updatedAt: novel.updatedAt,
    });
  }
  const items = [...sections.entries()]
    .sort((left, right) => left[1].index - right[1].index)
    .map(([sectionId, section]) => {
      const persisted = relatedLinks.find((link) => link.source.remoteId === sectionId);
      const key =
        persisted?.source ??
        ({ connectorId: 'moya.local.serial', remoteId: sectionId } satisfies ExternalItemSummary['key']);
      if (!persisted) {
        syntheticLinks.push({
          id: `local-series-link::${novel.id}::${sectionId}`,
          source: key,
          localBookId: novel.id,
          collectionRemoteId: `local-series:${novel.id}`,
          activeContentRevisionId: novel.activeContentRevisionId,
          linkedAt: novel.createdAt,
          lastCheckedAt: novel.updatedAt,
        });
      }
      return {
        key,
        kind: 'file' as const,
        title: section.title,
        subtitle: `${section.pageCount.toLocaleString()}페이지`,
        mimeType: 'application/vnd.comicbook+zip',
        formatHint: 'CBZ',
        remoteRevision: persisted?.importedRemoteRevision,
        updatedAt: section.updatedAt,
        collection: {
          remoteId: persisted?.collectionRemoteId ?? `local-series:${novel.id}`,
          title: novel.title,
          author: novel.author,
          description: novel.description,
          tags: novel.tags,
        },
        release: { title: section.title, sourceOrder: section.index },
        importability: 'supported' as const,
      };
    });
  return { items, links: [...persistedLinks, ...syntheticLinks] };
}
