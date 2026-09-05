import type { ComicPageLayoutHint } from './comic-layout';

export interface LoadedArchivePage {
  readonly blob: Blob;
  readonly hint?: ComicPageLayoutHint;
}

export interface ArchivePageImage {
  readonly url: string;
  readonly identity: string;
  readonly hint?: ComicPageLayoutHint;
}

export interface ArchivePageSnapshot {
  readonly pages: ReadonlyMap<number, ArchivePageImage>;
  readonly errors: ReadonlyMap<number, string>;
}

/** One bounded queue for the current viewport, replaced on every navigation. */
export class ArchivePageLoader {
  private readonly pages = new Map<number, ArchivePageImage>();
  private readonly errors = new Map<number, string>();
  private readonly inFlight = new Map<number, AbortController>();
  private readonly identities = new Map<number, string>();
  private identityForPage: (index: number) => string = String;
  private wanted: number[] = [];
  private currentPage?: number;
  private disposed = false;

  constructor(
    private readonly load: (index: number, signal: AbortSignal) => Promise<LoadedArchivePage>,
    private readonly onChange: (snapshot: ArchivePageSnapshot) => void,
    private readonly concurrency = 3,
    private readonly cacheSize = 20,
  ) {}

  update(currentPage: number, wanted: readonly number[], identityForPage: (index: number) => string = String): void {
    if (this.disposed) return;
    this.identityForPage = identityForPage;
    for (const [index, identity] of this.identities) {
      if (identity === identityForPage(index)) continue;
      this.inFlight.get(index)?.abort();
      const page = this.pages.get(index);
      if (page) URL.revokeObjectURL(page.url);
      this.pages.delete(index);
      this.errors.delete(index);
      this.identities.delete(index);
    }
    this.wanted = [...new Set([currentPage, ...wanted])];
    if (this.currentPage !== currentPage) this.errors.delete(currentPage);
    this.currentPage = currentPage;
    for (const [index, controller] of this.inFlight) {
      if (!this.wanted.includes(index)) controller.abort();
    }
    // A new foreground page must not wait for three still-wanted prefetches.
    if (!this.pages.has(currentPage) && !this.inFlight.has(currentPage) && this.inFlight.size >= this.concurrency) {
      for (const index of [...this.wanted].reverse()) {
        const controller = this.inFlight.get(index);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          break;
        }
      }
    }
    this.prune();
    this.publish();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = [];
    for (const controller of this.inFlight.values()) controller.abort();
    for (const page of this.pages.values()) URL.revokeObjectURL(page.url);
    this.pages.clear();
    this.errors.clear();
    this.identities.clear();
  }

  private prune(): void {
    for (const [index, page] of this.pages) {
      if (this.pages.size <= this.cacheSize) break;
      if (this.wanted.includes(index)) continue;
      URL.revokeObjectURL(page.url);
      this.pages.delete(index);
      this.identities.delete(index);
    }
    for (const index of this.errors.keys()) {
      if (!this.wanted.includes(index)) {
        this.errors.delete(index);
        this.identities.delete(index);
      }
    }
  }

  private publish(): void {
    if (!this.disposed) this.onChange({ pages: new Map(this.pages), errors: new Map(this.errors) });
  }

  private pump(): void {
    if (this.disposed) return;
    for (const index of this.wanted) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.pages.has(index) || this.errors.has(index) || this.inFlight.has(index)) continue;
      const controller = new AbortController();
      this.inFlight.set(index, controller);
      this.identities.set(index, this.identityForPage(index));
      void this.run(index, controller);
    }
  }

  private async run(index: number, controller: AbortController): Promise<void> {
    try {
      const page = await this.load(index, controller.signal);
      if (this.disposed || controller.signal.aborted || !this.wanted.includes(index)) return;
      this.pages.set(index, {
        url: URL.createObjectURL(page.blob),
        identity: this.identities.get(index)!,
        hint: page.hint,
      });
      this.errors.delete(index);
      this.prune();
      this.publish();
    } catch (error) {
      if (this.disposed || controller.signal.aborted || !this.wanted.includes(index)) return;
      this.errors.set(index, error instanceof Error ? error.message : `${index + 1}페이지 이미지를 열지 못했습니다.`);
      this.publish();
    } finally {
      this.inFlight.delete(index);
      if (!this.pages.has(index) && !this.errors.has(index)) this.identities.delete(index);
      // Aborted work keeps its slot until the repository has actually settled.
      this.pump();
    }
  }
}
