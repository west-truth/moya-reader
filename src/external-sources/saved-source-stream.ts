import type { Chapter, Novel } from '../domain/types';
import type { BookAssetRepository } from '../repositories/book-asset-repository';
import type { ReaderRepository } from '../repositories/reader-repository';
import type { SourceStreamPort } from './source-stream';

/** Keep the viewer mounted across downloaded and remote episodes, reading saved bytes first. */
export function savedFirstSourceStream(
  remote: SourceStreamPort,
  input: {
    find(remoteId: string): Promise<{ novel: Novel; chapters: readonly Chapter[]; sectionId: string } | undefined>;
    getParagraphPage: ReaderRepository['getParagraphPage'];
    assets: Pick<BookAssetRepository, 'getEmbeddedResource'>;
  },
): SourceStreamPort {
  return {
    async open(remoteId, signal) {
      signal.throwIfAborted();
      const saved = await input.find(remoteId);
      signal.throwIfAborted();
      if (!saved) return remote.open(remoteId, signal);
      const chapters = saved.chapters
        .filter((chapter) => chapter.documentSectionId === saved.sectionId)
        .sort((a, b) => a.index - b.index);
      if (saved.novel.deletedAt || saved.novel.format !== 'image_archive' || !chapters.length)
        throw new Error('저장된 회차를 찾을 수 없습니다. 회차 목록을 확인해 주세요.');
      const lifetime = new AbortController();
      return {
        pageCount: chapters.length,
        async loadPage(index, request) {
          const active = AbortSignal.any([request, lifetime.signal]);
          active.throwIfAborted();
          const chapter = chapters[index];
          if (!chapter) throw new Error('존재하지 않는 페이지입니다.');
          const page = await input.getParagraphPage(chapter.id, 0, active);
          active.throwIfAborted();
          const assetId = page?.paragraphs[0]?.assetId;
          const resource = assetId
            ? await input.assets.getEmbeddedResource(saved.novel.id, assetId, active)
            : undefined;
          active.throwIfAborted();
          if (!resource)
            throw new Error('저장된 페이지를 읽지 못했습니다. 회차 목록에서 다운로드 상태를 확인해 주세요.');
          return resource.blob;
        },
        close() {
          lifetime.abort();
        },
      };
    },
  };
}
