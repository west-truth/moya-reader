import type { Paragraph, TTSFootnotePlaybackPolicy } from '../domain/types';

export interface EpubFootnotePlaybackPlan {
  readonly paragraphs: readonly Paragraph[];
  readonly sourceIndexByParagraphId: ReadonlyMap<string, number>;
}

function isFootnote(paragraph: Paragraph): boolean {
  return paragraph.documentPageType === 'footnote' || paragraph.documentPageType === 'endnote';
}

function referencedFootnotes(paragraph: Paragraph): string[] {
  return Array.from(
    new Set(
      (paragraph.inlineSemantics ?? [])
        .filter((semantic) => semantic.kind === 'footnote_reference')
        .map((semantic) => semantic.relatedBlockId?.trim())
        .filter((href): href is string => Boolean(href)),
    ),
  );
}

export function planEpubFootnotePlayback(input: {
  readonly paragraphs: readonly Paragraph[];
  readonly startIndex: number;
  readonly policy: TTSFootnotePlaybackPolicy;
}): EpubFootnotePlaybackPlan {
  const startIndex = Math.max(0, Math.min(input.paragraphs.length, Math.trunc(input.startIndex)));
  const sourceIndexByParagraphId = new Map(input.paragraphs.map((paragraph, index) => [paragraph.id, index]));
  const footnoteByHref = new Map<string, Paragraph[]>();
  for (const paragraph of input.paragraphs) {
    if (!isFootnote(paragraph) || !paragraph.sourceHref) continue;
    const rows = footnoteByHref.get(paragraph.sourceHref) ?? [];
    rows.push(paragraph);
    footnoteByHref.set(paragraph.sourceHref, rows);
  }

  const remaining = input.paragraphs.slice(startIndex);
  const body = remaining.filter((paragraph) => !isFootnote(paragraph));
  if (input.policy === 'skip') return { paragraphs: body, sourceIndexByParagraphId };

  const referenced = new Set(body.flatMap(referencedFootnotes));
  const eligibleNotes = input.paragraphs.filter(
    (paragraph, index) =>
      isFootnote(paragraph) &&
      Boolean(paragraph.sourceHref) &&
      (index >= startIndex || referenced.has(paragraph.sourceHref!)),
  );
  if (input.policy === 'end_of_chapter') {
    return { paragraphs: [...body, ...eligibleNotes], sourceIndexByParagraphId };
  }

  const emitted = new Set<string>();
  const paragraphs: Paragraph[] = [];
  for (const paragraph of body) {
    paragraphs.push(paragraph);
    for (const href of referencedFootnotes(paragraph)) {
      for (const note of footnoteByHref.get(href) ?? []) {
        if (emitted.has(note.id)) continue;
        emitted.add(note.id);
        paragraphs.push(note);
      }
    }
  }
  for (const note of eligibleNotes) {
    if (!emitted.has(note.id)) paragraphs.push(note);
  }
  return { paragraphs, sourceIndexByParagraphId };
}
