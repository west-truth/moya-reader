export interface NormalizedTextRange {
  start: number;
  end: number;
}

export function normalizeNovelText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[ \u00A0]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function trimNormalizedTextRange(text: string, start: number, end: number): NormalizedTextRange {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart])) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1])) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}
