import { PARAGRAPHS_PER_PAGE } from '../../repositories/reader-defaults';
import {
  isTextStream,
  type SourceReadingPort,
  type SourceTextStreamPort,
} from '../../external-sources/source-text-stream';
import type { SourceStreamPort } from '../../external-sources/source-stream';
import { savedFirstSourceStream } from '../../external-sources/saved-source-stream';
import { externalItemKeyId } from '../../external-sources/contracts';
import { externalItemSectionId } from './serial-work-projection';
import type { ExternalSourceItemView, UseExternalSourceControllerOptions } from './useExternalSourceController';

type LibraryOptions = Pick<
  UseExternalSourceControllerOptions,
  'state' | 'assets' | 'getParagraphPage' | 'getNovel' | 'listChapters' | 'saveTextPosition' | 'saveStreamPosition'
>;

/** Loaded when opening streamed content, rather than while booting the library. */
export function savedSourceStream(
  port: SourceTextStreamPort,
  getOptions: () => LibraryOptions,
  item: ExternalSourceItemView,
): SourceTextStreamPort;
export function savedSourceStream(
  port: SourceStreamPort,
  getOptions: () => LibraryOptions,
  item: ExternalSourceItemView,
): SourceStreamPort;
export function savedSourceStream(
  port: SourceReadingPort,
  getOptions: () => LibraryOptions,
  item: ExternalSourceItemView,
): SourceReadingPort {
  const { assets, getParagraphPage } = getOptions();
  const textPort: SourceReadingPort =
    isTextStream(port) && getParagraphPage
      ? {
          kind: 'text',
          open: async (remoteId, signal, remoteRevision) => {
            const current = getOptions();
            const link = (await current.state.listLinks(item.key.connectorId)).find(
              (candidate) =>
                !candidate.pendingImport &&
                externalItemKeyId(candidate.source) === externalItemKeyId({ ...item.key, remoteId }),
            );
            signal.throwIfAborted();
            if (!link) return port.open(remoteId, signal, remoteRevision);
            const novel = await current.getNovel(link.localBookId);
            if (!novel || novel.deletedAt) throw new Error('저장된 회차를 찾을 수 없습니다.');
            const sectionId = externalItemSectionId({ ...item, key: { ...item.key, remoteId } });
            const chapters = (await current.listChapters(novel.id))
              .filter((chapter) => chapter.documentSectionId === sectionId)
              .sort((a, b) => a.index - b.index);
            if (!chapters.length) throw new Error('저장된 회차 본문을 찾을 수 없습니다.');
            const text: string[] = [];
            for (const chapter of chapters) {
              for (
                let pageIndex = 0;
                pageIndex < Math.ceil(chapter.paragraphCount / PARAGRAPHS_PER_PAGE);
                pageIndex++
              ) {
                signal.throwIfAborted();
                const page = await getParagraphPage(chapter.id, pageIndex, signal);
                if (!page) throw new Error('저장된 회차 본문이 누락됐습니다.');
                text.push(...page.paragraphs.map((p) => p.text));
              }
            }
            signal.throwIfAborted();
            return { text: text.join('\n\n') };
          },
        }
      : port;
  const savedPort =
    !isTextStream(port) && assets && getParagraphPage
      ? savedFirstSourceStream(port, {
          assets,
          getParagraphPage,
          find: async (remoteId) => {
            const current = getOptions();
            const link = (await current.state.listLinks(item.key.connectorId)).find(
              (candidate) =>
                !candidate.pendingImport &&
                externalItemKeyId(candidate.source) === externalItemKeyId({ ...item.key, remoteId }),
            );
            if (!link) return undefined;
            const novel = await current.getNovel(link.localBookId);
            if (!novel || novel.deletedAt)
              throw new Error('저장된 회차를 찾을 수 없습니다. 회차 목록을 확인해 주세요.');
            return {
              novel,
              chapters: await current.listChapters(novel.id),
              sectionId: externalItemSectionId({ ...item, key: { ...item.key, remoteId } }),
            };
          },
        })
      : textPort;
  return savedPort;
}

export async function saveTextStreamPosition(
  current: LibraryOptions,
  item: ExternalSourceItemView,
  position: { paragraphIndex: number; offset: number; textHash: string; count: number },
): Promise<void> {
  if (!current.getParagraphPage || !current.saveTextPosition) return;
  const link = (await current.state.listLinks(item.key.connectorId)).find(
    (link) => !link.pendingImport && externalItemKeyId(link.source) === externalItemKeyId(item.key),
  );
  if (!link) return;
  const novel = await current.getNovel(link.localBookId);
  if (!novel || novel.deletedAt) return;
  const chapters = (await current.listChapters(novel.id))
    .filter((chapter) => chapter.documentSectionId === externalItemSectionId(item))
    .sort((a, b) => a.index - b.index);
  if (chapters.reduce((sum, c) => sum + c.paragraphCount, 0) !== position.count) return;
  let index = position.paragraphIndex;
  for (const chapter of chapters) {
    if (index > chapter.paragraphCount) {
      index -= chapter.paragraphCount;
      continue;
    }
    const page = await current.getParagraphPage(chapter.id, Math.floor((index - 1) / PARAGRAPHS_PER_PAGE));
    const paragraph = page?.paragraphs.find((p) => p.index === index);
    if (!paragraph || paragraph.textHash !== position.textHash) return;
    await current.saveTextPosition({
      novelId: novel.id,
      expectedContentRevisionId: novel.activeContentRevisionId,
      chapterId: chapter.id,
      documentSectionId: chapter.documentSectionId,
      paragraphIndex: index,
      paragraphId: paragraph.id,
      offsetInParagraph: position.offset,
      chapterProgress: (index - 1) / Math.max(1, chapter.paragraphCount),
      scrollTop: 0,
    });
    break;
  }
}

export async function saveImageStreamPosition(
  current: LibraryOptions,
  item: ExternalSourceItemView,
  page: number,
  count: number,
): Promise<void> {
  if (!current.saveStreamPosition) return;
  const link = (await current.state.listLinks(item.key.connectorId)).find(
    (link) => externalItemKeyId(link.source) === externalItemKeyId(item.key) && !link.pendingImport,
  );
  if (!link) return;
  const novel = await current.getNovel(link.localBookId);
  if (!novel || novel.deletedAt) return;
  const ordered = (await current.listChapters(novel.id)).sort((a, b) => a.index - b.index);
  const chapters = ordered.filter((chapter) => chapter.documentSectionId === externalItemSectionId(item));
  if (chapters.length !== count || !chapters[page]) return;
  await current.saveStreamPosition(
    ordered.findIndex((chapter) => chapter.id === chapters[page].id),
    chapters[page],
    novel,
  );
}
