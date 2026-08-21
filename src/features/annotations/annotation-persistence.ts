import type { Bookmark, Chapter, Novel, ReaderHighlight, ReaderNote } from '../../domain/types';
import { bookmarkId, readerHighlightId, readerNoteId } from '../../domain/identity/reader-identities';
import { bookmarkRevision, highlightRevision, noteRevision } from '../../domain/resource-revisions';
import { formatProgress } from '../../utils/format';
import type {
  AnnotationLocation,
  AnnotationReaderPort,
  AnnotationRepository,
  AnnotationSelection,
} from './annotation-contract';
import { findBookmarkAtPosition } from './annotation-model';

interface MutationContext {
  readonly novel: Novel;
  readonly chapter: Chapter;
  readonly reader: AnnotationReaderPort;
  readonly readerProgress: number;
}

export class AnnotationPersistence {
  constructor(
    private readonly repository: AnnotationRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async toggleBookmark(
    context: MutationContext & { readonly bookmarks: readonly Bookmark[] },
    location = context.reader.getLocation(),
  ): Promise<{ status: 'created' | 'deleted'; bookmarks: Bookmark[] } | undefined> {
    if (!location) return undefined;
    const paragraphId = location.paragraph?.id;
    const existing = findBookmarkAtPosition(context.bookmarks, context.chapter.id, paragraphId, location.progress);
    if (existing) {
      await this.repository.deleteBookmark(existing.id, { expectedRevision: bookmarkRevision(existing) });
      return { status: 'deleted', bookmarks: context.bookmarks.filter((bookmark) => bookmark.id !== existing.id) };
    }
    const createdAt = this.now();
    const bookmark: Bookmark = {
      id: bookmarkId({
        novelId: context.novel.id,
        chapterId: context.chapter.id,
        paragraphId,
        progress: location.progress,
        createdAt,
      }),
      novelId: context.novel.id,
      chapterId: context.chapter.id,
      paragraphId,
      label: `${context.chapter.title} · ${formatProgress(location.progress)}`,
      progress: location.progress,
      scrollTop: location.scrollTop,
      createdAt,
    };
    await this.repository.saveBookmark(bookmark, { expectedRevision: bookmarkRevision() });
    return {
      status: 'created',
      bookmarks: [bookmark, ...context.bookmarks.filter((candidate) => candidate.id !== bookmark.id)],
    };
  }

  async saveNote(
    context: MutationContext & { readonly notes: readonly ReaderNote[] },
    draft: string,
    editingNoteId?: string,
  ): Promise<{ status: 'created' | 'updated'; notes: ReaderNote[] } | undefined> {
    const body = draft.trim();
    if (!body) return undefined;
    if (editingNoteId) {
      const existing = context.notes.find((note) => note.id === editingNoteId);
      if (!existing) return undefined;
      await this.repository.saveNote(
        { ...existing, body, updatedAt: this.now() },
        { expectedRevision: noteRevision(existing) },
      );
      return { status: 'updated', notes: await this.repository.listNotes(context.novel.id) };
    }

    const selection = context.reader.getSelection() ?? { text: '' };
    const location = context.reader.getLocation();
    const paragraph = await this.resolveParagraph(context.reader, selection, location);
    if (!paragraph) return undefined;
    const createdAt = this.now();
    const note: ReaderNote = {
      id: readerNoteId({
        novelId: context.novel.id,
        chapterId: context.chapter.id,
        paragraphId: paragraph.id,
        body,
        createdAt,
      }),
      novelId: context.novel.id,
      chapterId: context.chapter.id,
      paragraphId: paragraph.id,
      quote: selection.text || undefined,
      body,
      progress: location?.progress ?? context.readerProgress,
      createdAt,
      updatedAt: createdAt,
    };
    await this.repository.saveNote(note, { expectedRevision: noteRevision() });
    return { status: 'created', notes: await this.repository.listNotes(context.novel.id) };
  }

  async setHighlight(
    context: MutationContext & { readonly highlights: readonly ReaderHighlight[] },
    color: ReaderHighlight['color'],
    location = context.reader.getLocation(),
    selection: AnnotationSelection | undefined = context.reader.getSelection(),
  ): Promise<{ status: 'created' | 'updated' | 'deleted'; highlights: ReaderHighlight[] } | undefined> {
    if (!location) return undefined;
    const paragraph = await this.resolveParagraph(context.reader, selection, location);
    if (!paragraph) return undefined;
    const quote = selection?.text || paragraph.text;
    const existing = context.highlights.find(
      (highlight) => highlight.paragraphId === paragraph.id && highlight.quote === quote,
    );
    if (existing) {
      if (existing.color === color) {
        await this.repository.deleteHighlight(existing.id, { expectedRevision: highlightRevision(existing) });
        return { status: 'deleted', highlights: await this.repository.listHighlights(context.novel.id) };
      }
      await this.repository.saveHighlight(
        { ...existing, color, progress: location.progress, updatedAt: this.now() },
        { expectedRevision: highlightRevision(existing) },
      );
      return { status: 'updated', highlights: await this.repository.listHighlights(context.novel.id) };
    }

    const createdAt = this.now();
    const highlight: ReaderHighlight = {
      id: readerHighlightId({
        novelId: context.novel.id,
        chapterId: context.chapter.id,
        paragraphId: paragraph.id,
        quote,
        createdAt,
      }),
      novelId: context.novel.id,
      chapterId: context.chapter.id,
      paragraphId: paragraph.id,
      quote,
      color,
      progress: location.progress,
      createdAt,
      updatedAt: createdAt,
    };
    await this.repository.saveHighlight(highlight, { expectedRevision: highlightRevision() });
    return { status: 'created', highlights: await this.repository.listHighlights(context.novel.id) };
  }

  async deleteBookmark(novelId: string, bookmark: Bookmark): Promise<Bookmark[]> {
    await this.repository.deleteBookmark(bookmark.id, { expectedRevision: bookmarkRevision(bookmark) });
    return this.repository.listBookmarks(novelId);
  }

  async deleteHighlight(novelId: string, highlight: ReaderHighlight): Promise<ReaderHighlight[]> {
    await this.repository.deleteHighlight(highlight.id, { expectedRevision: highlightRevision(highlight) });
    return this.repository.listHighlights(novelId);
  }

  async deleteNote(novelId: string, note: ReaderNote): Promise<ReaderNote[]> {
    await this.repository.deleteNote(note.id, { expectedRevision: noteRevision(note) });
    return this.repository.listNotes(novelId);
  }

  private async resolveParagraph(
    reader: AnnotationReaderPort,
    selection: AnnotationSelection | undefined,
    location: AnnotationLocation | undefined,
  ) {
    if (!selection?.paragraphId) return location?.paragraph;
    return reader.getCachedParagraphById(selection.paragraphId) ?? this.repository.getParagraph(selection.paragraphId);
  }
}
