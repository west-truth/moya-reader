import type { ChapterHeadingInfo } from './contracts';

const maxHeadingLength = 140;
const clearStandaloneHeadings =
  /^(프롤로그|prologue|서장|序章|에필로그|epilogue|종장|終章|외전|번외|막간|interlude|side\s*story|special|특별편|작가\s*후기|후기)(?:\s*[:.\-–—]\s*.+)?$/i;
const numberedStandaloneHeading =
  /^(프롤로그|prologue|서장|序章|에필로그|epilogue|종장|終章|외전|번외|막간|interlude|side\s*story|special|특별편)\s*(\d{1,5}|[IVXLCDM]{1,8})(?:\s|$|[.:\-–—_]).*$/i;

const koreanNumberChars = '영공일이삼사오육칠팔구십백천만零〇一二三四五六七八九十百千万萬两兩';
const numberedUnit = '(화|話|话|장|章|편|篇|회|回|부|部|권|卷|막|幕|절|節|节)';
const numberToken = `(\\d{1,5}|[${koreanNumberChars}]+)`;
const headingTailBoundary = '(\\s|$|[.:：\\-–—_「『《〈(（\\[【])';

const headingPatterns: Array<{ family: string; pattern: RegExp; requiresSequence?: boolean }> = [
  {
    family: 'bracket_explicit',
    pattern: new RegExp(
      `^[\\[【〔「『]\\s*(?:제|第)\\s*${numberToken}\\s*${numberedUnit}\\s*[\\]】〕」』](?:\\s*.+)?$`,
      'i',
    ),
  },
  {
    family: 'bracket_numbered_unit',
    pattern: new RegExp(`^[\\[【〔「『]\\s*${numberToken}\\s*${numberedUnit}\\s*[\\]】〕」』](?:\\s+.+)?$`, 'i'),
  },
  {
    family: 'brace_explicit',
    pattern: new RegExp(`^\\{\\s*(?:제|第)\\s*${numberToken}\\s*${numberedUnit}\\s*\\}(?:\\s*.+)?$`, 'i'),
  },
  {
    family: 'brace_numbered_unit',
    pattern: new RegExp(`^\\{\\s*${numberToken}\\s*${numberedUnit}\\s*\\}(?:\\s*.+)?$`, 'i'),
  },
  {
    family: 'paren_explicit',
    pattern: new RegExp(`^\\(\\s*(?:제|第)?\\s*${numberToken}\\s*${numberedUnit}\\s*\\)(?:\\s*.+)?$`, 'i'),
  },
  {
    family: 'je_hwa_jang',
    pattern: new RegExp(`^(제|第)\\s*${numberToken}\\s*${numberedUnit}${headingTailBoundary}.*$`, 'i'),
  },
  {
    family: 'numbered_hwa_jang',
    pattern: new RegExp(`^(\\d{1,5})\\s*${numberedUnit}${headingTailBoundary}.*$`, 'i'),
  },
  {
    family: 'special_numbered',
    pattern: new RegExp(`^(외전|번외|특별편|special|side\\s*story)\\s*${numberToken}(?:\\s|$|[.:\\-–—_]).*$`, 'i'),
  },
  {
    family: 'title_prefix_hwa',
    pattern: new RegExp(`^.{1,70}\\s+(\\d{1,5})\\s*${numberedUnit}(\\s|$|[.:\\-–—_]).*$`, 'i'),
    requiresSequence: true,
  },
  { family: 'hash_number', pattern: /^#\s*(\d{1,5})(?:\s*$|\s*[.\-:–—]\s*.*|\s+.+)$/ },
  {
    family: 'bracket_ep_title',
    pattern: /^\[\s*(ep|episode|chapter|chap|ch)\.?\s*#?\s*(\d{1,5}|[IVXLCDM]{1,8})\s*\](?:\s+.+)?$/i,
  },
  {
    family: 'ep_title',
    pattern: /^(ep|episode|chapter|chap|ch)\.?\s*#?\s*(\d{1,5}|[IVXLCDM]{1,8})(?:\s|$|[.:\-–—_]).*$/i,
  },
  { family: 'e_number', pattern: /^e\s*#?(\d{1,5})(?:\s|$|[.:\-–—_]).*$/i, requiresSequence: true },
  { family: 'no_title', pattern: /^(no|number|num)\.?\s*(\d{1,5})(?:\s|$|[.:\-–—_]).*$/i },
  {
    family: 'part_book',
    pattern: /^(part|book|volume|vol)\.?\s*(\d{1,5}|[IVXLCDM]{1,8})(?:\s|$|[.:\-–—_]).*$/i,
  },
  {
    family: 'cjk_episode',
    pattern: new RegExp(`^第\\s*(\\d{1,5})\\s*(話|话|章|回)${headingTailBoundary}.*$`, 'i'),
  },
  {
    family: 'bracket_dash_episode',
    pattern: /^\[\s*(?:\(?\s*(수정|수정본|수정판|개정|revised|rev)\s*\)?\s*)?(\d{2,5})\s*[-–—]\s*.+\]$/i,
    requiresSequence: true,
  },
  { family: 'bracket_dot_episode', pattern: /^\[\s*(\d{2,5})\.\s+.+\]$/i, requiresSequence: true },
  {
    family: 'bracket_number_title',
    pattern: /^(?:\[|【|〔|「|『)\s*(\d{2,5})\s*(?:\]|】|〕|」|』)\s+\S.+$/i,
    requiresSequence: true,
  },
  {
    family: 'brace_dash_episode',
    pattern: /^\{\s*(?:\(?\s*(수정|수정본|수정판|개정|revised|rev)\s*\)?\s*)?(\d{1,5})\s*[-–—]\s*.+\}$/i,
    requiresSequence: true,
  },
  {
    family: 'paren_dash_episode',
    pattern: /^\(\s*(?:\(?\s*(수정|수정본|수정판|개정|revised|rev)\s*\)?\s*)?(\d{1,5})\s*[-–—]\s*.+\)$/i,
    requiresSequence: true,
  },
  { family: 'leading_5digits', pattern: /^(\d{5,})\s+.+$/, requiresSequence: true },
  {
    family: 'bracket_number',
    pattern: /^(?:\[|【|〔|「|『)\s*(\d{1,5})\s*(?:\]|】|〕|」|』)$/,
    requiresSequence: true,
  },
  { family: 'brace_number', pattern: /^\{\s*(\d{1,5})\s*\}$/, requiresSequence: true },
  { family: 'number_underscore', pattern: /^(\d{1,5})[_＿][^\s].+$/, requiresSequence: true },
  { family: 'number_title', pattern: /^(\d{1,5})\s+\S.+$/, requiresSequence: true },
  {
    family: 'bullet_dash_episode',
    pattern: /^[-•]\s*(?:\(?\s*(수정|수정본|수정판|개정|revised|rev)\s*\)?\s*)?(\d{1,5})\s*[-–—]\s*.+$/i,
    requiresSequence: true,
  },
  {
    family: 'dash_episode',
    pattern: /^(?:\(?\s*(수정|수정본|수정판|개정|revised|rev)\s*\)?\s*)?(\d{1,5})\s*[-–—]\s*.+$/i,
    requiresSequence: true,
  },
  { family: 'dot_episode', pattern: /^(\d{1,5})\.\s+.+$/, requiresSequence: true },
  { family: 'colon_episode', pattern: /^(\d{1,5})\s*[:：]\s*.+$/, requiresSequence: true },
  { family: 'paren_episode', pattern: /^(\d{1,5})[)]\s+.+$/, requiresSequence: true },
  { family: 'number_only', pattern: /^(\d{1,5})$/, requiresSequence: true },
];

const systemOrListLike =
  /^\[(?!\s*(?:(?:\d{1,5}|[영공일이삼사오육칠팔구십백천만]+)\s*(?:화|話|话|장|章|편|회|回|부|권|막|절)|제\s*(?:\d{1,5}|[영공일이삼사오육칠팔구십백천만]+)\s*(?:화|話|话|장|章|편|회|回|부|권|막|절)|(?:ep|episode|chapter|ch)\.?\s*#?\s*(?:\d{1,5}|[IVXLCDM]{1,8})|\d{2,5}\s*(?:[-–—]|\.)\s*.+|\d{1,5})\s*\]).+\]$/i;
const statusLikeHeading = /(시스템|상태창|알림|퀘스트|스킬|아이템|선택지|로그|system|status|quest|skill|item|log)/i;
const koreanDigitMap: Record<string, number> = {
  영: 0,
  공: 0,
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  칠: 7,
  팔: 8,
  구: 9,
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  两: 2,
  兩: 2,
};
const koreanUnitMap: Record<string, number> = {
  십: 10,
  백: 100,
  천: 1000,
  만: 10000,
  十: 10,
  百: 100,
  千: 1000,
  万: 10000,
  萬: 10000,
};

function stripOuterAngle(line: string): { text: string; hadAngle: boolean } {
  const trimmed = line.trim();
  const match = trimmed.match(/^[<〈《]\s*(.+?)\s*[>〉》]$/);
  return match ? { text: match[1].trim(), hadAngle: true } : { text: trimmed, hadAngle: false };
}

function normalizeNumericWidth(text: string): string {
  return text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function normalizeDecoratedHeading(text: string): string {
  return text
    .trim()
    .replace(/^[=~*]{3,}\s*/, '')
    .replace(/\s*[=~*]{3,}$/, '')
    .replace(/^[-–—]{2,}\s*/, '')
    .replace(/\s*[-–—]{2,}$/, '')
    .trim();
}

function cleanupHeadingTitle(text: string): string {
  return normalizeDecoratedHeading(text)
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s*[=]{3,}\s*$/, '')
    .replace(/\s*[-–—]{3,}\s*$/, '')
    .trim();
}

function parseKoreanNumber(text: string): number | undefined {
  if (!text || ![...text].every((char) => char in koreanDigitMap || char in koreanUnitMap)) return undefined;

  if (![...text].some((char) => char in koreanUnitMap)) {
    return [...text].reduce((total, char) => total * 10 + koreanDigitMap[char], 0);
  }

  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of text) {
    if (char in koreanDigitMap) {
      current = koreanDigitMap[char];
      continue;
    }

    const unit = koreanUnitMap[char];
    const value = current || 1;
    if (unit === 10000) {
      total += (section + value) * unit;
      section = 0;
    } else {
      section += value * unit;
    }
    current = 0;
  }

  return total + section + current;
}

function parseRomanNumber(text: string): number | undefined {
  const normalized = text.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(normalized)) return undefined;

  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const value = values[normalized[index]];
    const next = values[normalized[index + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : undefined;
}

function parseNumberish(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const token = text.trim();
  if (/^\d{1,6}$/.test(token)) return Number.parseInt(token, 10);
  const korean = parseKoreanNumber(token);
  if (korean !== undefined) return korean;
  return parseRomanNumber(token);
}

function extractNumberFromMatch(match: RegExpMatchArray): number | undefined {
  for (const capture of match.slice(1)) {
    const parsed = parseNumberish(capture);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function parseChapterHeading(line: string): ChapterHeadingInfo | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > maxHeadingLength) return undefined;

  const markdown = trimmed.match(/^#{1,6}\s+(.+)$/);
  const source = normalizeNumericWidth(markdown ? markdown[1].trim() : trimmed);
  const { text: strippedText, hadAngle } = stripOuterAngle(source);
  const text = normalizeDecoratedHeading(strippedText);

  if (!text || text.length > maxHeadingLength) return undefined;
  if (systemOrListLike.test(text)) return undefined;

  if (clearStandaloneHeadings.test(text)) {
    return {
      title: cleanupHeadingTitle(text),
      family: hadAngle ? 'angle_standalone' : 'standalone_special',
      number: parseNumberish(text.match(/\((\d{1,5})\)$/)?.[1]),
      requiresSequence: false,
    };
  }

  const numberedStandalone = text.match(numberedStandaloneHeading);
  if (numberedStandalone) {
    return {
      title: cleanupHeadingTitle(text),
      family: hadAngle ? 'angle_numbered_special' : 'numbered_special',
      number: parseNumberish(numberedStandalone[2]),
      requiresSequence: false,
    };
  }

  if (hadAngle && /^.+\(\s*\d{1,5}\s*\)$/.test(text) && !statusLikeHeading.test(text)) {
    return {
      title: cleanupHeadingTitle(text),
      family: 'angle_standalone',
      number: parseNumberish(text.match(/\((\d{1,5})\)$/)?.[1]),
      requiresSequence: false,
    };
  }

  for (const { family, pattern, requiresSequence } of headingPatterns) {
    const match = text.match(pattern);
    if (match) {
      const number = extractNumberFromMatch(match);
      // Korean zero words followed by a unit are common nouns (for example, 공장/영화).
      // A numeric zero written with a digit remains a valid explicit heading.
      if (number === 0 && !/\d/.test(match[0])) continue;

      const sentenceLikeBroadUnit =
        family === 'numbered_hwa_jang' &&
        /^\d{1,5}\s*(?:부|部|권|卷|막|幕|절|節|节)\s+\S/u.test(text) &&
        text.length > 40;
      return {
        title: cleanupHeadingTitle(text),
        family: hadAngle ? `angle_${family}` : family,
        number,
        requiresSequence: Boolean((requiresSequence || sentenceLikeBroadUnit) && !hadAngle),
      };
    }
  }

  return undefined;
}

export function isLikelyChapterHeading(line: string): boolean {
  const heading = parseChapterHeading(line);
  return heading !== undefined && !heading.requiresSequence;
}
