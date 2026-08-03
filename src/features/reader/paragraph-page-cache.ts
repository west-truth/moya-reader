import type { Paragraph, ParagraphPage } from '../../domain/types';
import { pruneReaderParagraphCache } from '../../reader/page-cache-policy';

export type ParagraphPageLoader = (chapterId: string, pageIndex: number) => Promise<ParagraphPage | undefined>;

export interface ParagraphPageCacheSnapshot {
  readonly generation: number;
  readonly revision: number;
}

export class ParagraphPageCache {
  private readonly paragraphs = new Map<number, Paragraph>();
  private readonly paragraphIndexById = new Map<string, number>();
  private readonly loadedPages = new Set<number>();
  private readonly failedPages = new Set<number>();
  private readonly loadingPages = new Map<number, Promise<void>>();
  private generation = 0;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly paragraphsPerPage: number,
    private readonly onChange: () => void,
  ) {}

  snapshot(): ParagraphPageCacheSnapshot {
    return { generation: this.generation, revision: this.revision };
  }

  reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.paragraphs.clear();
    this.paragraphIndexById.clear();
    this.loadedPages.clear();
    this.failedPages.clear();
    this.loadingPages.clear();
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.paragraphs.clear();
    this.paragraphIndexById.clear();
    this.loadedPages.clear();
    this.failedPages.clear();
    this.loadingPages.clear();
  }

  paragraphAt(index: number): Paragraph | undefined {
    return this.paragraphs.get(index);
  }

  paragraphById(paragraphId: string): Paragraph | undefined {
    const index = this.paragraphIndexById.get(paragraphId);
    return index === undefined ? undefined : this.paragraphs.get(index);
  }

  isPageFailed(pageIndex: number): boolean {
    return this.failedPages.has(pageIndex);
  }

  async loadIndexes(
    chapterId: string,
    paragraphIndexes: readonly number[],
    loader: ParagraphPageLoader,
  ): Promise<void> {
    const pageIndexes = [
      ...new Set(
        paragraphIndexes.filter((index) => index >= 0).map((index) => Math.floor(index / this.paragraphsPerPage)),
      ),
    ];
    await Promise.all(pageIndexes.map((pageIndex) => this.loadPage(chapterId, pageIndex, loader)));
  }

  async retryPage(chapterId: string, pageIndex: number, loader: ParagraphPageLoader): Promise<void> {
    if (this.failedPages.delete(pageIndex)) this.changed();
    this.loadedPages.delete(pageIndex);
    await this.loadPage(chapterId, pageIndex, loader);
  }

  prune(visibleParagraphIndexes: readonly number[]): void {
    const result = pruneReaderParagraphCache({
      paragraphCache: this.paragraphs,
      loadedPageIndexes: this.loadedPages,
      failedPageIndexes: this.failedPages,
      visibleParagraphIndexes: [...visibleParagraphIndexes],
      paragraphsPerPage: this.paragraphsPerPage,
    });
    if (!result.changed) return;

    this.paragraphIndexById.clear();
    for (const [index, paragraph] of this.paragraphs) this.paragraphIndexById.set(paragraph.id, index);
    this.changed();
  }

  private loadPage(chapterId: string, pageIndex: number, loader: ParagraphPageLoader): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loadedPages.has(pageIndex)) return Promise.resolve();
    const activeLoad = this.loadingPages.get(pageIndex);
    if (activeLoad) return activeLoad;

    const requestedGeneration = this.generation;
    const load = loader(chapterId, pageIndex)
      .then((page) => {
        if (this.disposed || requestedGeneration !== this.generation) return;
        if (!page) {
          this.failedPages.add(pageIndex);
          this.changed();
          return;
        }

        let changed = false;
        for (const paragraph of page.paragraphs) {
          const index = paragraph.index - 1;
          if (this.paragraphs.get(index) !== paragraph) {
            this.paragraphs.set(index, paragraph);
            this.paragraphIndexById.set(paragraph.id, index);
            changed = true;
          }
        }
        this.loadedPages.add(pageIndex);
        changed = this.failedPages.delete(pageIndex) || changed;
        if (changed) this.changed();
      })
      .catch(() => {
        if (this.disposed || requestedGeneration !== this.generation) return;
        this.failedPages.add(pageIndex);
        this.changed();
      })
      .finally(() => {
        if (requestedGeneration === this.generation) this.loadingPages.delete(pageIndex);
      });
    this.loadingPages.set(pageIndex, load);
    return load;
  }

  private changed(): void {
    if (this.disposed) return;
    this.revision += 1;
    this.onChange();
  }
}
