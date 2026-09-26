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
    color: ReaderHighlight['color'] | 'remove',
    location = context.reader.getLocation(),
    selection: AnnotationSelection | undefined = context.reader.getSelection(),
  ): Promise<{ status: 'created' | 'updated' | 'deleted'; highlights: ReaderHighlight[] } | undefined> {
    if (!location || !selection?.text.trim()) return undefined;
    const parts =
      selection.parts ?? (selection.paragraphId ? [selection as { paragraphId: string; text: string }] : []);
    if (!parts.length) return undefined;
    // Validate every selected paragraph before making any mutation. Never fall back
    // to the visible first paragraph when selection is absent or no longer current.
    const selectedParagraphs = new Map<string, string>();
    for (const part of parts) {
      const paragraph = await this.resolveParagraph(context.reader, part, location);
      if (
        !paragraph ||
        paragraph.id !== part.paragraphId ||
        paragraph.novelId !== context.novel.id ||
        paragraph.chapterId !== context.chapter.id ||
        !part.text.trim() ||
        !paragraph.text.includes(part.text)
      )
        throw new Error('highlight_selection_stale');
      selectedParagraphs.set(part.paragraphId, paragraph.text);
    }
    let status: 'created' | 'updated' | 'deleted' = color === 'remove' ? 'deleted' : 'updated';
    for (const part of parts) {
      if (color === 'remove') {
        const text = selectedParagraphs.get(part.paragraphId)!;
        const start = text.indexOf(part.text);
        const end = start + part.text.length;
        const overlaps = context.highlights.filter((highlight) => {
          if (highlight.paragraphId !== part.paragraphId || !highlight.quote) return false;
          const highlightStart = text.indexOf(highlight.quote);
          return highlightStart >= 0 && highlightStart < end && highlightStart + highlight.quote.length > start;
        });
        for (const existing of overlaps)
          await this.repository.deleteHighlight(existing.id, { expectedRevision: highlightRevision(existing) });
        continue;
      }
      const existing = context.highlights.find(
        (highlight) => highlight.paragraphId === part.paragraphId && highlight.quote === part.text,
      );
      if (existing) {
        if (existing.color !== color)
          await this.repository.saveHighlight(
            { ...existing, color, updatedAt: this.now() },
            { expectedRevision: highlightRevision(existing) },
          );
        continue;
      }
      const createdAt = this.now();
      const highlight: ReaderHighlight = {
        id: readerHighlightId({
          novelId: context.novel.id,
          chapterId: context.chapter.id,
          paragraphId: part.paragraphId,
          quote: part.text,
          createdAt,
        }),
        novelId: context.novel.id,
        chapterId: context.chapter.id,
        paragraphId: part.paragraphId,
        quote: part.text,
        color,
        progress: location.progress,
        createdAt,
        updatedAt: createdAt,
      };
      await this.repository.saveHighlight(highlight, { expectedRevision: highlightRevision() });
      status = 'created';
    }
    return { status, highlights: await this.repository.listHighlights(context.novel.id) };
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
