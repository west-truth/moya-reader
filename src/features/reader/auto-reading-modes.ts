import type { Paragraph, ReaderAnchor } from '../../domain/types';

export const AUTO_READING_MODES = [
  { id: 'pixel', label: '픽셀 단위 스크롤', description: '본문이 일정한 속도로 부드럽게 올라갑니다.' },
  { id: 'line', label: '줄 단위 스크롤', description: '일정한 간격으로 한 줄씩 올라갑니다.' },
  {
    id: 'page',
    label: '화면 단위 스크롤',
    description: '한 화면을 읽을 시간을 두고, 한 줄을 겹쳐 다음 화면으로 이동합니다.',
  },
  {
    id: 'blind-pixel',
    label: '픽셀 단위 블라인드',
    description: '아래쪽 가림막이 줄어들며 본문이 위에서부터 서서히 드러납니다.',
  },
  {
    id: 'blind-line',
    label: '줄 단위 블라인드',
    description: '아래쪽 가림막이 한 줄씩 줄어들며 보이는 본문이 늘어납니다.',
  },
  {
    id: 'rsvp',
    label: '속독 (RSVP)',
    description: '현재 위치부터 어절을 하나씩 보여줍니다. 삽화에서는 잠시 기다립니다.',
  },
] as const;
export type AutoReadingMode = (typeof AUTO_READING_MODES)[number]['id'];
export type AutoReadingResult = 'moving' | 'waiting' | 'end';
export function isAutoReadingMode(value: unknown): value is AutoReadingMode {
  return AUTO_READING_MODES.some((mode) => mode.id === value);
}
export function autoReadingRate(mode: AutoReadingMode, speed: number): number {
  if (mode === 'page') return 1 / (13 - speed);
  if (mode === 'rsvp') return (60 + speed * 30) / 60;
  if (mode === 'line' || mode === 'blind-line') return speed / 6;
  return speed * 5;
}
export function autoReadingSpeedLabel(mode: AutoReadingMode, speed: number): string {
  if (mode === 'page') return `${13 - speed}초마다`;
  if (mode === 'rsvp') return `분당 ${60 + speed * 30}어절`;
  if (mode === 'line' || mode === 'blind-line') return `분당 ${speed * 10}줄`;
  return `${speed}단계`;
}

// A bounded token scan preserves source offsets, including repeated whitespace and long unbroken text.
export function nextReadingToken(
  text: string,
  offset: number,
): { text: string; start: number; end: number } | undefined {
  const expression = /\S{1,24}/gu;
  expression.lastIndex = offset;
  const match = expression.exec(text);
  return match ? { text: match[0], start: match.index, end: expression.lastIndex } : undefined;
}

interface AutoReadingEnvironment {
  root: HTMLElement;
  overlay: HTMLElement;
  top: number;
  bottom: number;
  count: number;
  anchor: () => ReaderAnchor | undefined;
  paragraph: (index: number) => Paragraph | undefined;
  load: (index: number, isCurrent: () => boolean) => Promise<unknown>;
  range: (element: HTMLElement, start: number, end: number) => Range | undefined;
  advance: (pixels: number) => AutoReadingResult;
}

function wholeLineBoundary(root: HTMLElement, boundary: number, minimum: number): number {
  if (typeof document === 'undefined') return boundary;
  const bounds = root.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range = document.caretRangeFromPoint?.(x, boundary);
  if (!range) {
    const caret = caretDocument.caretPositionFromPoint?.(x, boundary);
    if (!caret) return boundary;
    range = document.createRange();
    range.setStart(caret.offsetNode, caret.offset);
  }
  const node = range.startContainer;
  if (!root.contains(node) || node.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return boundary;
  const offset = Math.min(range.startOffset, node.textContent.length - 1);
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const rect = range.getBoundingClientRect();
  return rect.top < boundary && rect.bottom > boundary ? Math.max(minimum, rect.top - 1) : boundary;
}

export class AutoReadingPresentation {
  private revealedHeight = 0;
  private cursor?: { index: number; offset: number };
  private loading?: number;
  private holdUntil = 0;
  private mode?: AutoReadingMode;
  private generation = 0;
  reset(overlay?: HTMLElement | null) {
    this.generation++;
    this.revealedHeight = 0;
    this.cursor = undefined;
    this.loading = undefined;
    this.holdUntil = 0;
    this.mode = undefined;
    if (overlay) {
      overlay.hidden = true;
      overlay.replaceChildren();
    }
  }

  private load(index: number, env: AutoReadingEnvironment) {
    if (this.loading === index) return;
    this.loading = index;
    const generation = this.generation;
    void env
      .load(index, () => generation === this.generation)
      .finally(() => {
        if (generation === this.generation && this.loading === index) this.loading = undefined;
      })
      .catch(() => {});
  }

  advance(mode: AutoReadingMode, amount: number, env: AutoReadingEnvironment): AutoReadingResult {
    if (this.mode !== mode) {
      this.reset(env.overlay);
      this.mode = mode;
    }
    const status = env.advance(0);
    if (status === 'waiting') return status;
    const line =
      Number.parseFloat(getComputedStyle(env.root.querySelector('.reader-document') ?? env.root).lineHeight) || 32;
    const height = Math.max(line * 2, env.bottom - env.top);
    if (mode === 'pixel') return env.advance(amount);
    if (mode === 'line') return env.advance(amount > 0 ? line : 0);
    if (mode === 'page') return env.advance(amount > 0 ? Math.max(line, height - line) : 0);

    const bounds = env.root.getBoundingClientRect();
    Object.assign(env.overlay.style, { top: `${env.top}px`, left: `${bounds.left}px`, width: `${bounds.width}px` });
    env.overlay.dataset.mode = mode;
    env.overlay.hidden = false;
    if (mode !== 'rsvp') {
      const paintBlind = () => {
        const rawBoundary = env.top + this.revealedHeight;
        const boundary =
          mode === 'blind-line' && this.revealedHeight < height
            ? wholeLineBoundary(env.root, rawBoundary, env.top)
            : rawBoundary;
        env.overlay.style.top = `${boundary}px`;
        env.overlay.style.height = `${Math.max(0, env.top + height - boundary)}px`;
      };
      paintBlind();
      if (this.revealedHeight >= height) {
        // Leave the final revealed line readable before moving to another screen.
        if (Date.now() < this.holdUntil) return 'waiting';
        if (status === 'end') return 'end';
        const result = env.advance(Math.max(line, height - line));
        if (result !== 'waiting') {
          this.revealedHeight = 0;
          paintBlind();
        }
        return result;
      }
      this.revealedHeight = Math.min(
        height,
        this.revealedHeight + (mode === 'blind-line' ? (amount > 0 ? line : 0) : amount),
      );
      paintBlind();
      if (this.revealedHeight >= height) this.holdUntil = Date.now() + 1000;
      return 'moving';
    }

    env.overlay.style.height = `${height}px`;
    if (env.count === 0) return 'end';
    if (Date.now() < this.holdUntil) return 'waiting';
    if (!this.cursor) {
      const anchor = env.anchor();
      if (!anchor) return 'waiting';
      this.cursor = { index: anchor.blockIndex ?? 0, offset: anchor.offset };
    }
    // Bound work per tick even for a chapter made of empty paragraphs.
    for (let skipped = 0; skipped < 8; skipped++) {
      if (this.cursor.index >= env.count) return 'end';
      const paragraph = env.paragraph(this.cursor.index);
      if (!paragraph) {
        this.load(this.cursor.index, env);
        return 'waiting';
      }
      const element = [...env.root.querySelectorAll<HTMLElement>('[data-paragraph-id]')].find(
        (node) => node.dataset.paragraphId === paragraph.id,
      );
      if (!element) {
        this.load(this.cursor.index, env);
        return 'waiting';
      }
      if (paragraph.documentKind === 'image') {
        const image = element.querySelector('img');
        env.overlay.replaceChildren();
        if (image?.complete) env.overlay.append(image.cloneNode(true));
        else env.overlay.textContent = '삽화';
        env.root.scrollBy({ top: element.getBoundingClientRect().top - env.top, behavior: 'auto' });
        this.cursor = { index: this.cursor.index + 1, offset: 0 };
        this.holdUntil = Date.now() + 3000;
        return 'moving';
      }
      const token = nextReadingToken(paragraph.text, this.cursor.offset);
      if (!token) {
        this.cursor = { index: this.cursor.index + 1, offset: 0 };
        continue;
      }
      env.overlay.textContent = token.text;
      const rect = env.range(element, token.start, token.end)?.getBoundingClientRect();
      if (rect && rect.height > 0) env.root.scrollBy({ top: rect.top - env.top, behavior: 'auto' });
      this.cursor.offset = token.end;
      return 'moving';
    }
    return 'waiting';
  }
}
