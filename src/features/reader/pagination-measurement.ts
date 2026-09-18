import type { Paragraph, ReaderAnchor, ReaderPageBoundary } from '../../domain/types';
import { chapterSequenceLabel, showChapterSequence, type ReaderChapterHeadingData } from './ReaderChapterHeading';
import { compareReaderAnchors } from './reader-pagination-model';

function appendMeasurementInline(content: HTMLElement, paragraph: Paragraph, start: number, end: number): void {
  const marks = paragraph.inlineMarks ?? [];
  const semantics = paragraph.inlineSemantics ?? [];
  if (marks.length === 0 && semantics.length === 0) {
    content.textContent = paragraph.text.slice(start, end);
    return;
  }
  const boundaries = new Set([start, end]);
  for (const item of [...marks, ...semantics]) {
    if (item.end <= start || item.start >= end) continue;
    boundaries.add(Math.max(start, item.start));
    boundaries.add(Math.min(end, item.end));
  }
  const points = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentStart = points[index];
    const segmentEnd = points[index + 1];
    const activeMarks = marks.filter((mark) => mark.start <= segmentStart && mark.end >= segmentEnd);
    const activeSemantics = semantics.filter(
      (semantic) => semantic.start <= segmentStart && semantic.end >= segmentEnd,
    );
    let node: Node = document.createTextNode(paragraph.text.slice(segmentStart, segmentEnd));
    const ruby = activeSemantics.find((semantic) => semantic.kind === 'ruby' && semantic.value);
    if (ruby?.value) {
      const element = document.createElement('ruby');
      element.append(node);
      const annotation = document.createElement('rt');
      annotation.textContent = ruby.value;
      element.append(annotation);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'strong')) {
      const element = document.createElement('strong');
      element.append(node);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'emphasis')) {
      const element = document.createElement('em');
      element.append(node);
      node = element;
    }
    const language = activeSemantics.find((semantic) => semantic.kind === 'language' && semantic.value)?.value;
    if (language) {
      const element = document.createElement('span');
      element.lang = language;
      element.append(node);
      node = element;
    }
    if (activeMarks.some((mark) => mark.kind === 'link')) {
      const element = document.createElement('a');
      element.append(node);
      node = element;
    }
    content.append(node);
  }
}

function measurementBlock(paragraph: Paragraph, start: number, end: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'reader-virtual-row is-static';
  wrapper.dataset.readerMeasureBody = 'true';
  const paragraphRoot = document.createElement('div');
  paragraphRoot.className = 'reader-paragraph';
  let content: HTMLElement;
  switch (paragraph.documentKind) {
    case 'heading':
      content = document.createElement('h2');
      break;
    case 'blockquote':
      content = document.createElement('blockquote');
      break;
    case 'separator':
      content = document.createElement('hr');
      break;
    case 'image':
      content = document.createElement('div');
      content.className = 'reader-pagination-image-measure';
      break;
    default:
      content = document.createElement('p');
  }
  if (paragraph.documentKind === 'list_item') content.className = 'reader-list-item';
  if (paragraph.documentKind !== 'separator' && paragraph.documentKind !== 'image') {
    appendMeasurementInline(content, paragraph, start, end);
  }
  paragraphRoot.append(content);
  wrapper.append(paragraphRoot);
  return wrapper;
}

function measurementChapterHeading(chapter: ReaderChapterHeadingData): HTMLElement {
  const heading = document.createElement('header');
  heading.className = 'reader-chapter-heading';
  heading.dataset.readerChapterHeading = 'true';
  if (showChapterSequence(chapter)) {
    const sequence = document.createElement('p');
    sequence.className = 'chapter-kicker';
    sequence.textContent = chapterSequenceLabel(chapter);
    heading.append(sequence);
  }
  const title = document.createElement('h1');
  title.textContent = chapter.title;
  heading.append(title);
  return heading;
}

function resetMeasurementPage(
  measure: HTMLElement,
  chapter: ReaderChapterHeadingData,
  includeChapterHeading: boolean,
): void {
  measure.replaceChildren();
  measure.classList.toggle('has-chapter-heading', includeChapterHeading);
  if (includeChapterHeading) measure.append(measurementChapterHeading(chapter));
}

export interface PageMeasurementInput {
  readonly template: HTMLElement;
  readonly host: HTMLElement;
  readonly chapter: ReaderChapterHeadingData;
  readonly paragraphCount: number;
  readonly getParagraph: (index: number) => Promise<Paragraph | undefined>;
}

/** Measure only the source adjacent to the requested edge, including oversized paragraphs. */
export async function measureAdjacentPage(
  input: PageMeasurementInput,
  edge: ReaderAnchor,
  direction: -1 | 1,
  signal: AbortSignal,
): Promise<ReaderPageBoundary | undefined> {
  signal.throwIfAborted();
  if (input.paragraphCount === 0 || (direction > 0 && (edge.blockIndex ?? 0) >= input.paragraphCount)) return undefined;
  if (direction < 0 && (edge.blockIndex ?? 0) === 0 && edge.offset === 0) return undefined;
  if (direction > 0 && (edge.blockIndex ?? 0) >= input.paragraphCount - 1) {
    const last = await input.getParagraph(input.paragraphCount - 1);
    signal.throwIfAborted();
    if (last && last.text.length > 0 && edge.offset >= last.text.length) return undefined;
  }
  await document.fonts?.ready;
  signal.throwIfAborted();
  const measure = input.template.cloneNode(false) as HTMLElement;
  input.host.append(measure);
  const getParagraph = async (index: number) => {
    signal.throwIfAborted();
    const paragraph = await input.getParagraph(index);
    signal.throwIfAborted();
    if (!paragraph) throw new Error(`Paragraph ${index} is unavailable during pagination.`);
    return paragraph;
  };
  const anchor = (paragraph: Paragraph, index: number, offset: number): ReaderAnchor => ({
    ...edge,
    blockId: paragraph.id,
    blockIndex: index,
    offset,
    sourceLocator: paragraph.sourceLocator,
  });
  const fits = () => {
    const last = measure.lastElementChild;
    return (
      !last || last.getBoundingClientRect().bottom <= measure.getBoundingClientRect().top + measure.clientHeight - 2
    );
  };
  const setHeading = (include: boolean) => {
    measure.querySelector('[data-reader-chapter-heading]')?.remove();
    measure.classList.toggle('has-chapter-heading', include);
    if (include) measure.prepend(measurementChapterHeading(input.chapter));
  };
  try {
    let index = edge.blockIndex ?? 0;
    let offset = edge.offset;
    let includeEmpty = direction < 0 && index >= input.paragraphCount;
    if (includeEmpty) {
      index = input.paragraphCount - 1;
      offset = (await getParagraph(index)).text.length;
    }
    let boundary: ReaderAnchor | undefined;
    let pageStart = edge;
    resetMeasurementPage(measure, input.chapter, direction > 0 && index === 0 && offset === 0);
    while (index >= 0 && index < input.paragraphCount) {
      const paragraph = await getParagraph(index);
      const length = paragraph.text.length;
      offset = Math.max(0, Math.min(length, offset));
      if (direction < 0 && offset === 0 && !(includeEmpty && length === 0)) {
        index -= 1;
        includeEmpty = true;
        if (index >= 0) offset = (await getParagraph(index)).text.length;
        continue;
      }
      if (direction > 0 && offset === length && length > 0) {
        index += 1;
        offset = 0;
        continue;
      }
      const existing = Boolean(measure.querySelector('[data-reader-measure-body]'));
      if (direction > 0 && !existing) pageStart = anchor(paragraph, index, offset);
      const atomic = ['image', 'separator', 'heading'].includes(paragraph.documentKind ?? '') || length === 0;
      const available = direction > 0 ? length - offset : offset;
      const tryLength = (count: number, keep = false) => {
        const start = direction > 0 ? offset : offset - count;
        const end = direction > 0 ? offset + count : offset;
        setHeading(
          direction > 0 ? (pageStart.blockIndex ?? 0) === 0 && pageStart.offset === 0 : index === 0 && start === 0,
        );
        const block = measurementBlock(paragraph, start, end);
        if (direction > 0) measure.append(block);
        else {
          const first = measure.querySelector('[data-reader-measure-body]');
          if (first) measure.insertBefore(block, first);
          else measure.append(block);
        }
        const fit = fits();
        if (!keep) block.remove();
        return fit;
      };
      if (atomic) {
        if (!tryLength(available) && existing) break;
        tryLength(available, true);
        boundary =
          direction > 0 && length === 0
            ? anchor(index + 1 < input.paragraphCount ? await getParagraph(index + 1) : paragraph, index + 1, 0)
            : anchor(paragraph, index, direction > 0 ? length : 0);
      } else {
        // Exponential probing avoids laying out an entire unbroken novel for every page.
        let low = 0;
        let high = Math.min(256, available);
        while (tryLength(high)) {
          low = high;
          if (high === available) break;
          high = Math.min(available, high * 2);
        }
        if (low < high) {
          let right = high - 1;
          while (low < right) {
            const middle = Math.ceil((low + right) / 2);
            if (tryLength(middle)) low = middle;
            else right = middle - 1;
          }
        }
        if (low === 0) {
          if (existing) break;
          throw new Error('Pagination could not fit text on an empty page.');
        }
        let split = direction > 0 ? offset + low : offset - low;
        if (low < available) {
          // Move inward to a whitespace or Unicode boundary, never past the measured fit.
          if (direction > 0) {
            const match = paragraph.text.slice(offset, split).match(/\s\S*$/u);
            if (match?.index !== undefined && match.index > 0) split = offset + match.index + 1;
          } else {
            const match = paragraph.text.slice(split, offset).match(/^\S*\s/u);
            if (match && match[0].length < low) split += match[0].length;
          }
          const previous = paragraph.text.charCodeAt(split - 1);
          const next = paragraph.text.charCodeAt(split);
          if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) split -= direction;
        }
        tryLength(Math.abs(split - offset), true);
        boundary = anchor(paragraph, index, split);
        if (low < available) break;
      }
      if (direction > 0 && index + 1 < input.paragraphCount) {
        boundary = anchor(await getParagraph(index + 1), index + 1, 0);
      }
      index += direction;
      includeEmpty = direction < 0;
      offset = direction > 0 || index < 0 ? 0 : (await getParagraph(index)).text.length;
    }
    if (!boundary || compareReaderAnchors(boundary, edge) * direction <= 0) return undefined;
    return { index: 0, start: direction > 0 ? pageStart : boundary, end: direction > 0 ? boundary : edge };
  } finally {
    measure.remove();
  }
}
