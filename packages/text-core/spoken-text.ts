import type {
  ReaderDocumentInlineSemantic,
  SpokenTextProjection,
  SpokenTextRule,
  SpokenTextTransform,
} from '@noveldesk/contracts';
import { integrityHash, structuredIntegrityHash } from './hash';

interface Unit {
  char: string;
  sourceStart: number;
  sourceEnd: number;
  transform: SpokenTextTransform;
}

export interface ProjectSpokenTextInput {
  readonly text: string;
  readonly language?: string;
  readonly sourceOffset?: number;
  readonly semantics?: readonly ReaderDocumentInlineSemantic[];
  readonly rules?: readonly SpokenTextRule[];
  readonly rubyPolicy?: 'base' | 'reading';
  readonly footnotePolicy?: 'skip_marker' | 'read_marker';
}

const KO_DIGITS = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'] as const;

function koreanInteger(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, '');
  if (normalized.length > 12)
    return value
      .split('')
      .map((digit) => KO_DIGITS[Number(digit)])
      .join(' ');
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) return value;
  if (number === 0) return KO_DIGITS[0];
  const groups = ['', '만', '억', '조'];
  const small = ['', '십', '백', '천'];
  let remaining = number;
  const output: string[] = [];
  for (let group = 0; remaining > 0 && group < groups.length; group += 1) {
    const part = remaining % 10_000;
    remaining = Math.floor(remaining / 10_000);
    if (part === 0) continue;
    const words: string[] = [];
    let local = part;
    for (let position = 0; local > 0; position += 1) {
      const digit = local % 10;
      local = Math.floor(local / 10);
      if (digit === 0) continue;
      words.unshift(`${digit === 1 && position > 0 ? '' : KO_DIGITS[digit]}${small[position]}`);
    }
    output.unshift(`${words.join('')}${groups[group]}`);
  }
  return output.join(' ');
}

function koreanNumber(value: string): string {
  const normalized = value.replace(/,/g, '');
  const [integer, fraction] = normalized.split('.');
  if (fraction === undefined) return koreanInteger(integer);
  const fractionWords = [...fraction].map((digit) => KO_DIGITS[Number(digit)]).join(' ');
  return `${koreanInteger(integer)} 점 ${fractionWords}`;
}

function isValidCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function isValidTime(hourText: string, minuteText: string): boolean {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59;
}

function unitsFor(text: string, sourceOffset = 0): Unit[] {
  const units: Unit[] = [];
  let offset = 0;
  for (const char of text) {
    units.push({
      char,
      sourceStart: sourceOffset + offset,
      sourceEnd: sourceOffset + offset + char.length,
      transform: 'identity',
    });
    offset += char.length;
  }
  return units;
}

function replaceUnits(units: Unit[], start: number, end: number, value: string, transform: SpokenTextTransform): void {
  const covered = units.slice(start, end);
  if (covered.length === 0) return;
  const sourceStart = Math.min(...covered.map((unit) => unit.sourceStart));
  const sourceEnd = Math.max(...covered.map((unit) => unit.sourceEnd));
  units.splice(start, end - start, ...[...value].map((char) => ({ char, sourceStart, sourceEnd, transform })));
}

function replaceSourceRange(
  units: Unit[],
  sourceStart: number,
  sourceEnd: number,
  value: string,
  transform: SpokenTextTransform,
): void {
  const start = units.findIndex((unit) => unit.sourceEnd > sourceStart);
  if (start < 0) return;
  let end = start;
  while (end < units.length && units[end].sourceStart < sourceEnd) end += 1;
  replaceUnits(units, start, end, value, transform);
}

function replacePattern(
  units: Unit[],
  pattern: RegExp,
  transform: SpokenTextTransform,
  replacement: (match: RegExpExecArray) => string,
): void {
  let cursor = 0;
  while (cursor < units.length) {
    const value = units.map((unit) => unit.char).join('');
    pattern.lastIndex = cursor;
    const match = pattern.exec(value);
    if (!match || match.index === undefined) return;
    const start = [...value.slice(0, match.index)].length;
    const end = start + [...match[0]].length;
    const next = replacement(match);
    replaceUnits(units, start, end, next, transform);
    cursor = start + Math.max(1, [...next].length);
  }
}

function applySemantics(units: Unit[], input: ProjectSpokenTextInput, skipped: SpokenTextProjection['skipped']): void {
  const offset = input.sourceOffset ?? 0;
  const semantics = [...(input.semantics ?? [])].sort((a, b) => b.start - a.start);
  for (const semantic of semantics) {
    const start = semantic.start;
    const end = semantic.end;
    if (end <= offset || start >= offset + input.text.length) continue;
    if (semantic.kind === 'ruby' && input.rubyPolicy === 'reading' && semantic.value) {
      replaceSourceRange(
        units,
        Math.max(offset, start),
        Math.min(offset + input.text.length, end),
        semantic.value,
        'ruby',
      );
    }
    if (semantic.kind === 'footnote_reference' && input.footnotePolicy !== 'read_marker') {
      replaceSourceRange(units, Math.max(offset, start), Math.min(offset + input.text.length, end), '', 'identity');
      skipped.push({
        sourceStart: Math.max(offset, start),
        sourceEnd: Math.min(offset + input.text.length, end),
        ruleId: 'epub-footnote-marker',
      });
    }
  }
}

function applyRules(units: Unit[], input: ProjectSpokenTextInput, skipped: SpokenTextProjection['skipped']): void {
  const rules = [...(input.rules ?? [])].filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    const current = units.map((unit) => unit.char).join('');
    if (!rule.pattern) continue;
    const trimmed = current.trim();
    const shouldSkip =
      rule.kind === 'skip_line'
        ? trimmed === rule.pattern
        : rule.kind === 'skip_prefix'
          ? trimmed.startsWith(rule.pattern)
          : rule.kind === 'skip_suffix'
            ? trimmed.endsWith(rule.pattern)
            : false;
    if (shouldSkip) {
      const sourceStart = units[0]?.sourceStart ?? input.sourceOffset ?? 0;
      const sourceEnd = units.at(-1)?.sourceEnd ?? (input.sourceOffset ?? 0) + input.text.length;
      units.splice(0, units.length);
      skipped.push({ sourceStart, sourceEnd, ruleId: rule.id });
      return;
    }
    if (rule.kind === 'replace_literal') {
      let index = current.indexOf(rule.pattern);
      while (index >= 0) {
        const value = units.map((unit) => unit.char).join('');
        const start = [...value.slice(0, index)].length;
        const replacement = rule.replacement ?? '';
        replaceUnits(units, start, start + [...rule.pattern].length, replacement, 'pronunciation');
        index = units
          .map((unit) => unit.char)
          .join('')
          .indexOf(rule.pattern, start + [...replacement].length);
      }
    }
  }
}

function applyKoreanNormalization(units: Unit[]): void {
  replacePattern(units, /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, 'date', (match) =>
    isValidCalendarDate(match[1], match[2], match[3])
      ? `${koreanInteger(match[1])}년 ${koreanInteger(match[2])}월 ${koreanInteger(match[3])}일`
      : match[0],
  );
  replacePattern(units, /\b(\d{1,2}):(\d{2})\b/g, 'time', (match) =>
    isValidTime(match[1], match[2]) ? `${koreanInteger(match[1])}시 ${koreanInteger(match[2])}분` : match[0],
  );
  replacePattern(units, /₩\s*([\d,]+(?:\.\d+)?)/g, 'currency', (match) => `${koreanNumber(match[1])}원`);
  replacePattern(units, /\$\s*([\d,]+(?:\.\d+)?)/g, 'currency', (match) => `${koreanNumber(match[1])} 달러`);
  replacePattern(units, /\b([\d,]+(?:\.\d+)?)%/g, 'unit', (match) => `${koreanNumber(match[1])} 퍼센트`);
  replacePattern(units, /\b(\d[\d,]*\.\d+)\b/g, 'number', (match) => koreanNumber(match[1]));
  replacePattern(units, /\b(\d[\d,]*)\b/g, 'number', (match) => koreanNumber(match[1]));
  for (const [pattern, value] of [
    [/&/g, ' 앤드 '],
    [/@/g, ' 골뱅이 '],
    [/#/g, ' 샵 '],
    [/\+/g, ' 플러스 '],
    [/=/g, ' 이퀄 '],
  ] as const) {
    replacePattern(units, pattern, 'symbol', () => value);
  }
}

function applyJapaneseNormalization(units: Unit[]): void {
  replacePattern(units, /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, 'date', (match) =>
    isValidCalendarDate(match[1], match[2], match[3]) ? `${match[1]}年${match[2]}月${match[3]}日` : match[0],
  );
  replacePattern(units, /\b(\d{1,2}):(\d{2})\b/g, 'time', (match) =>
    isValidTime(match[1], match[2]) ? `${match[1]}時${match[2]}分` : match[0],
  );
  replacePattern(units, /₩\s*([\d,]+)/g, 'currency', (match) => `${match[1]}ウォン`);
  replacePattern(units, /\$\s*([\d,]+(?:\.\d+)?)/g, 'currency', (match) => `${match[1]}ドル`);
  replacePattern(units, /\b([\d,]+(?:\.\d+)?)%/g, 'unit', (match) => `${match[1]}パーセント`);
  for (const [pattern, value] of [
    [/&/g, ' アンド '],
    [/@/g, ' アット '],
    [/#/g, ' シャープ '],
    [/\+/g, ' プラス '],
    [/=/g, ' イコール '],
  ] as const) {
    replacePattern(units, pattern, 'symbol', () => value);
  }
}

function applyEnglishNormalization(units: Unit[]): void {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  replacePattern(units, /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, 'date', (match) => {
    if (!isValidCalendarDate(match[1], match[2], match[3])) return match[0];
    const month = months[Number(match[2]) - 1];
    return month ? `${month} ${Number(match[3])}, ${match[1]}` : match[0];
  });
  replacePattern(units, /\b([\d,]+(?:\.\d+)?)%/g, 'unit', (match) => `${match[1]} percent`);
  replacePattern(units, /₩\s*([\d,]+)/g, 'currency', (match) => `${match[1]} won`);
  replacePattern(units, /\$\s*([\d,]+(?:\.\d+)?)/g, 'currency', (match) => `${match[1]} dollars`);
  for (const [pattern, value] of [
    [/&/g, ' and '],
    [/@/g, ' at '],
    [/#/g, ' hash '],
    [/\+/g, ' plus '],
    [/=/g, ' equals '],
  ] as const) {
    replacePattern(units, pattern, 'symbol', () => value);
  }
}

function normalizeWhitespace(units: Unit[]): Unit[] {
  const output: Unit[] = [];
  for (const unit of units) {
    if (/\s/u.test(unit.char)) {
      if (output.length > 0 && output.at(-1)?.char !== ' ') output.push({ ...unit, char: ' ' });
    } else output.push(unit);
  }
  while (output[0]?.char === ' ') output.shift();
  while (output.at(-1)?.char === ' ') output.pop();
  return output;
}

function projectionSpans(units: Unit[]): SpokenTextProjection['spans'] {
  const spans: SpokenTextProjection['spans'] = [];
  let spokenOffset = 0;
  for (const unit of units) {
    const spokenEnd = spokenOffset + unit.char.length;
    const previous = spans.at(-1);
    if (
      previous &&
      previous.transform === unit.transform &&
      previous.sourceStart === unit.sourceStart &&
      previous.sourceEnd === unit.sourceEnd &&
      previous.spokenEnd === spokenOffset
    ) {
      previous.spokenEnd = spokenEnd;
    } else {
      spans.push({
        spokenStart: spokenOffset,
        spokenEnd,
        sourceStart: unit.sourceStart,
        sourceEnd: unit.sourceEnd,
        transform: unit.transform,
      });
    }
    spokenOffset = spokenEnd;
  }
  return spans;
}

export function projectSpokenText(input: ProjectSpokenTextInput): SpokenTextProjection {
  let units = unitsFor(input.text, input.sourceOffset);
  const skipped: SpokenTextProjection['skipped'] = [];
  applySemantics(units, input, skipped);
  applyRules(units, input, skipped);
  const sourceStart = input.sourceOffset ?? 0;
  const semanticLanguage = input.semantics?.find(
    (semantic) =>
      semantic.kind === 'language' &&
      semantic.value &&
      semantic.start <= sourceStart &&
      semantic.end >= sourceStart + input.text.length,
  )?.value;
  const effectiveLanguage = semanticLanguage ?? input.language;
  const language = (effectiveLanguage ?? 'ko').toLowerCase();
  if (language.startsWith('ko')) applyKoreanNormalization(units);
  else if (language.startsWith('ja')) applyJapaneseNormalization(units);
  else if (language.startsWith('en')) applyEnglishNormalization(units);
  units = normalizeWhitespace(units);
  const spokenText = units.map((unit) => unit.char).join('');
  const sourceTextHash = integrityHash(input.text);
  const spans = projectionSpans(units);
  return {
    sourceTextHash,
    spokenText,
    language: effectiveLanguage,
    spans,
    skipped,
    fingerprint: structuredIntegrityHash({
      version: 'spoken-text-v1',
      sourceTextHash,
      language: effectiveLanguage ?? '',
      spokenText,
      spans,
      skipped,
      rubyPolicy: input.rubyPolicy ?? 'base',
      footnotePolicy: input.footnotePolicy ?? 'skip_marker',
      rules: (input.rules ?? []).map((rule) => ({ ...rule })),
    }),
  };
}
