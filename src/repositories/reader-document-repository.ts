import type {
  BookFormat,
  ReaderAnchor,
  ReaderDocumentBlock,
  ReaderDocumentBlockPage,
  ReaderDocumentSection,
  ReadingPosition,
} from '../domain/types';
import type { ReaderRepository } from './reader-repository';

export interface ReaderDocumentManifest {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly format: BookFormat;
  readonly sections: readonly ReaderDocumentSection[];
}

export interface ReaderDocumentRepository {
  getDocumentManifest(bookId: string): Promise<ReaderDocumentManifest | undefined>;
  getBlockPage(
    sectionId: string,
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<ReaderDocumentBlockPage | undefined>;
  getBlock(blockId: string, signal?: AbortSignal): Promise<ReaderDocumentBlock | undefined>;
}

export function anchorFromReadingPosition(
  position: ReadingPosition,
  contentRevisionId: string,
): ReaderAnchor | undefined {
  if (!position.paragraphId || !contentRevisionId) return undefined;
  return {
    bookId: position.novelId,
    contentRevisionId,
    sectionId: position.chapterId,
    blockId: position.paragraphId,
    offset: Math.max(0, Math.floor(position.offsetInParagraph)),
  };
}

export function blockFromLegacyParagraph(input: {
  readonly bookId: string;
  readonly chapterId: string;
  readonly paragraphId: string;
  readonly paragraphIndex: number;
  readonly text: string;
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
  readonly kind?: ReaderDocumentBlock['kind'];
  readonly inlineMarks?: ReaderDocumentBlock['inlineMarks'];
  readonly inlineSemantics?: ReaderDocumentBlock['inlineSemantics'];
  readonly assetId?: string;
}): ReaderDocumentBlock {
  return {
    id: input.paragraphId,
    bookId: input.bookId,
    sectionId: input.chapterId,
    index: input.paragraphIndex,
    kind: input.kind ?? 'paragraph',
    plainText: input.text,
    inlineMarks: input.inlineMarks,
    inlineSemantics: input.inlineSemantics,
    assetId: input.assetId,
    sourceStart: input.sourceStart,
    sourceEnd: input.sourceEnd,
  };
}

function blockFromParagraph(paragraph: import('../domain/types').Paragraph): ReaderDocumentBlock {
  return blockFromLegacyParagraph({
    bookId: paragraph.novelId,
    chapterId: paragraph.chapterId,
    paragraphId: paragraph.id,
    paragraphIndex: paragraph.index,
    text: paragraph.text,
    sourceStart: paragraph.startOffsetInChapter,
    sourceEnd: paragraph.endOffsetInChapter,
    kind: paragraph.documentKind,
    inlineMarks: paragraph.inlineMarks,
    inlineSemantics: paragraph.inlineSemantics,
    assetId: paragraph.assetId,
  });
}

export class RepositoryBackedReaderDocumentRepository implements ReaderDocumentRepository {
  constructor(private readonly repository: ReaderRepository) {}

  async getDocumentManifest(bookId: string): Promise<ReaderDocumentManifest | undefined> {
    const novel = await this.repository.getNovel(bookId);
    if (!novel) return undefined;
    const chapters = await this.repository.listChapters(bookId);
    const sections = await Promise.all(
      chapters.map(async (chapter) => {
        const firstPage = await this.repository.getParagraphPage(chapter.id, 0);
        return {
          id: chapter.id,
          bookId,
          index: chapter.index,
          title: chapter.title,
          sourceHref: firstPage?.paragraphs[0]?.sourceHref,
          blockCount: chapter.paragraphCount,
        } satisfies ReaderDocumentSection;
      }),
    );
    return {
      bookId,
      contentRevisionId: novel.activeContentRevisionId ?? novel.normalizedTextHash,
      format: novel.format ?? (/\.md|\.markdown$/i.test(novel.sourceFileName) ? 'markdown' : 'txt'),
      sections,
    };
  }

  async getBlockPage(sectionId: string, pageIndex: number): Promise<ReaderDocumentBlockPage | undefined> {
    const page = await this.repository.getParagraphPage(sectionId, pageIndex);
    if (!page) return undefined;
    return {
      id: page.id,
      bookId: page.novelId,
      sectionId: page.chapterId,
      pageIndex: page.pageIndex,
      startBlockIndex: page.startParagraphIndex,
      endBlockIndex: page.endParagraphIndex,
      blocks: page.paragraphs.map(blockFromParagraph),
    };
  }

  async getBlock(blockId: string): Promise<ReaderDocumentBlock | undefined> {
    const paragraph = await this.repository.getParagraph(blockId);
    return paragraph ? blockFromParagraph(paragraph) : undefined;
  }
}
