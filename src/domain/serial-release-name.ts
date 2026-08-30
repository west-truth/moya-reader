export type SerialReleaseSpecialKind = 'extra' | 'special';

export interface SerialReleaseName {
  readonly original: string;
  readonly displayBaseName: string;
  readonly workTitle?: string;
  readonly normalizedWorkKey?: string;
  readonly looseWorkKey?: string;
  readonly releaseTitle: string;
  readonly releaseKey?: string;
  readonly chapterNumber?: number;
  readonly chapterEnd?: number;
  readonly volumeNumber?: number;
  readonly seasonNumber?: number;
  readonly specialKind?: SerialReleaseSpecialKind;
  readonly completion?: 'complete' | 'ongoing';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly evidence: readonly string[];
}

const KNOWN_LIBRARY_EXTENSION = /\.(?:txt|md|markdown|epub|pdf|mobi|azw3?|fb2|zip|cbz|rar|cbr|7z|cb7)$/iu;
const TRAILING_FILE_COPY_SUFFIX = /\s+\((?<copy>[1-9]\d{0,3})\)\s*$/u;
const LEADING_NOISE_GROUP =
  /^\s*[[(（【](?:텍본|웹소설|카카오페이지|네이버\s*시리즈|리디|노벨피아|문피아|digital|raw|scan|scans|kor|korean|jpn|japanese|eng|english)[\])）】]+\s*/iu;
const TRAILING_NOISE_GROUP =
  /\s*[[(（【](?:digital|web|raw|scan|scans|kor|korean|jpn|japanese|eng|english|텍본|웹소설|카카오페이지|네이버\s*시리즈|리디|노벨피아|문피아|\d{3,4}p|\d{3,5}px|(?:x|h)26[45]|avif|webp|complete|completed|완결작?|완료|완|完結|完)[\])）】]+\s*$/iu;
const TRAILING_NOISE_TOKEN =
  /\s+(?:digital|raw|텍본|웹소설|\d{3,4}p|\d{3,5}px|(?:x|h)26[45]|complete|completed|완결작?|완료|완|完結|完)\s*$/iu;
const TRAILING_ATTACHED_CJK_COMPLETION = /(?<=\d)\s*(?:完結|完)\s*$/u;
const TRAILING_TOTAL_COUNT =
  /\s+\(?\s*총\s*\d{1,6}(?:\.\d+)?\s*(?:화|회|장|권|편)(?:\s*[/|·-]?\s*(?:완결작?|완료|완|完結|完|연재중|미완결|ongoing|complete|completed))?\s*\)?\s*$/iu;
const COMPLETE_SUFFIX = /(?:\s|_|[[(（【])(?:완결작?|완료|완|完結|完|complete|completed)(?:\s*[\])）】])?\s*$/iu;
const ONGOING_SUFFIX = /(?:\s|_|[[(（【])(?:연재중|미완결|ongoing)(?:\s*[\])）】])?\s*$/iu;

interface NumericToken {
  readonly start: number;
  readonly end: number;
  readonly first: number;
  readonly last?: number;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function lastPathSegment(value: string): string {
  return value.replace(/\\/gu, '/').split('/').at(-1)?.trim() ?? value.trim();
}

interface PreparedBaseName {
  readonly value: string;
  readonly fileCopySuffix?: number;
}

function stripKnownLibraryExtensions(value: string): { readonly value: string; readonly stripped: boolean } {
  let stripped = false;
  let cleaned = value;
  let previousExtension = '';
  while (cleaned !== previousExtension) {
    previousExtension = cleaned;
    const next = cleaned.replace(KNOWN_LIBRARY_EXTENSION, '').trim();
    if (next !== cleaned) stripped = true;
    cleaned = next;
  }
  return { value: cleaned, stripped };
}

function prepareBaseName(value: string, stripFileCopySuffix: boolean): PreparedBaseName {
  const initial = lastPathSegment(value).normalize('NFKC').trim();
  const beforeCopy = stripKnownLibraryExtensions(initial);
  if (!stripFileCopySuffix || !beforeCopy.stripped) return { value: beforeCopy.value };

  const copySuffix = TRAILING_FILE_COPY_SUFFIX.exec(beforeCopy.value);
  if (!copySuffix?.groups?.copy) return { value: beforeCopy.value };
  const withoutCopy = beforeCopy.value.slice(0, copySuffix.index).trim();
  return {
    value: stripKnownLibraryExtensions(withoutCopy).value,
    fileCopySuffix: Number.parseInt(copySuffix.groups.copy, 10),
  };
}

function cleanPreparedBaseName(value: string): string {
  let cleaned = value;
  cleaned = cleaned
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[〜～]/gu, '~')
    .replace(/_+/gu, ' ');
  let previous = '';
  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(LEADING_NOISE_GROUP, '')
      .replace(TRAILING_NOISE_GROUP, '')
      .replace(TRAILING_TOTAL_COUNT, '')
      .replace(TRAILING_NOISE_TOKEN, '')
      .replace(TRAILING_ATTACHED_CJK_COMPLETION, '')
      .trim();
  }
  return cleaned.replace(/\s+/gu, ' ');
}

function cleanBaseName(value: string): string {
  return cleanPreparedBaseName(prepareBaseName(value, false).value);
}

function completionFromBaseName(baseName: string): SerialReleaseName['completion'] {
  if (COMPLETE_SUFFIX.test(baseName)) return 'complete';
  if (ONGOING_SUFFIX.test(baseName)) return 'ongoing';
  return undefined;
}

export function normalizeSerialWorkKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[\s_.·•:：/\\|]+/gu, ' ')
    .replace(/\s*-\s*/gu, '-')
    .trim();
}

export function looseSerialWorkKey(value: string): string {
  return normalizeSerialWorkKey(value).replace(/[\p{P}\p{S}\s]+/gu, '');
}

function numericKey(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/u, '').replace(/\.$/u, '');
}

function removeRanges(value: string, ranges: readonly { start: number; end: number }[]): string {
  const ordered = [...ranges].sort((left, right) => right.start - left.start);
  let result = value;
  for (const range of ordered) result = `${result.slice(0, range.start)} ${result.slice(range.end)}`;
  return result
    .replace(/\s*[-–—_:：|]+\s*$/gu, '')
    .replace(/^\s*[-–—_:：|]+\s*/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function firstMatch(value: string, patterns: readonly RegExp[]): RegExpExecArray | undefined {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(value);
    if (match) return match;
  }
  return undefined;
}

function numericToken(match: RegExpExecArray | undefined): NumericToken | undefined {
  if (!match || match.index === undefined) return undefined;
  const first = finiteNumber(match.groups?.first);
  if (first === undefined) return undefined;
  return {
    start: match.index,
    end: match.index + match[0].length,
    first,
    last: finiteNumber(match.groups?.last),
  };
}

export function parseSerialReleaseName(
  value: string,
  fallbackWorkTitle?: string,
  options: { readonly stripFileCopySuffix?: boolean } = {},
): SerialReleaseName {
  const prepared = prepareBaseName(value, options.stripFileCopySuffix === true);
  const completion = completionFromBaseName(prepared.value);
  const displayBaseName = cleanPreparedBaseName(prepared.value);
  const fallback = fallbackWorkTitle ? cleanBaseName(fallbackWorkTitle) : undefined;
  const evidence: string[] = [];
  if (prepared.fileCopySuffix !== undefined) evidence.push('file_copy_suffix');
  if (completion) evidence.push(`completion:${completion}`);
  const removalRanges: Array<{ start: number; end: number }> = [];

  const seasonEpisode = firstMatch(displayBaseName, [/\bS(?<season>\d{1,3})\s*E(?<episode>\d{1,5}(?:\.\d+)?)\b/iu]);
  const seasonNumber = finiteNumber(seasonEpisode?.groups?.season);
  let chapterNumber = finiteNumber(seasonEpisode?.groups?.episode);
  let chapterEnd: number | undefined;
  if (seasonEpisode?.index !== undefined) {
    removalRanges.push({ start: seasonEpisode.index, end: seasonEpisode.index + seasonEpisode[0].length });
    evidence.push('season_episode');
  }

  const volumeMatch = firstMatch(displayBaseName, [
    /(?:제\s*|第\s*)?(?<first>\d{1,4}(?:\.\d+)?)\s*(?:권|巻)(?=\s*(?:$|[-_:：|]|(?:제\s*|第\s*)?\d+(?:\.\d+)?\s*(?:화|話)|(?:chapter|ch\.?|episode|ep\.?|c)\s*\d))/iu,
    /\b(?:vol(?:ume)?\.?|v)\s*(?<first>\d{1,4}(?:\.\d+)?)\b(?=\s*(?:$|[-_:：|]|(?:chapter|ch\.?|episode|ep\.?|c)\s*\d))/iu,
  ]);
  const volume = numericToken(volumeMatch);
  const volumeNumber = volume?.first;
  if (volume) {
    removalRanges.push(volume);
    evidence.push('volume');
  }

  const chapterMatch = seasonEpisode
    ? undefined
    : firstMatch(displayBaseName, [
        /(?:제\s*|第\s*)?(?<first>\d{1,5}(?:\.\d+)?)\s*(?:[-~]\s*(?<last>\d{1,5}(?:\.\d+)?))?\s*(?:화|회|話|장)/iu,
        /\b(?:chapter|ch(?:apter)?\.?|episode|ep(?:isode)?\.?)\s*(?<first>\d{1,5}(?:\.\d+)?)(?:\s*[-~]\s*(?<last>\d{1,5}(?:\.\d+)?))?\b/iu,
        /\bc\s*(?<first>\d{1,5}(?:\.\d+)?)(?:\s*[-~]\s*(?<last>\d{1,5}(?:\.\d+)?))?\b/iu,
      ]);
  const chapter = numericToken(chapterMatch);
  if (chapter) {
    chapterNumber = chapter.first;
    chapterEnd = chapter.last;
    removalRanges.push(chapter);
    evidence.push(chapter.last === undefined ? 'chapter' : 'chapter_range');
  }

  const specialMatch = /(?:외전|번외편|특별편|특별화|extra|special|side\s*story)/iu.exec(displayBaseName);
  let specialKind: SerialReleaseSpecialKind | undefined;
  if (specialMatch?.index !== undefined) {
    specialKind = /(?:외전|번외편|extra|side\s*story)/iu.test(specialMatch[0]) ? 'extra' : 'special';
    removalRanges.push({ start: specialMatch.index, end: specialMatch.index + specialMatch[0].length });
    evidence.push(specialKind);
  }

  if (
    chapterNumber === undefined &&
    volumeNumber === undefined &&
    seasonNumber === undefined &&
    fallbackWorkTitle &&
    /^#?\d{1,5}(?:\.\d+)?$/u.test(displayBaseName)
  ) {
    chapterNumber = finiteNumber(displayBaseName.replace(/^#/u, ''));
    removalRanges.push({ start: 0, end: displayBaseName.length });
    evidence.push('bare_chapter_with_parent');
  }

  if (chapterNumber === undefined && volumeNumber === undefined && seasonNumber === undefined) {
    const bareRange = /^(?<title>.+?\D)\s+(?<first>\d{1,5}(?:\.\d+)?)\s*[-~]\s*(?<last>\d{1,5}(?:\.\d+)?)$/u.exec(
      displayBaseName,
    );
    if (bareRange?.index !== undefined) {
      chapterNumber = finiteNumber(bareRange.groups?.first);
      chapterEnd = finiteNumber(bareRange.groups?.last);
      const tokenStart = bareRange.groups?.title?.length ?? 0;
      removalRanges.push({ start: tokenStart, end: displayBaseName.length });
      evidence.push('bare_range');
    } else if (fallback) {
      const bareChapter = /^(?<title>.+?\D)\s+#?(?<first>\d{1,5}(?:\.\d+)?)$/u.exec(displayBaseName);
      if (
        bareChapter?.index !== undefined &&
        normalizeSerialWorkKey(bareChapter.groups?.title ?? '') === normalizeSerialWorkKey(fallback)
      ) {
        chapterNumber = finiteNumber(bareChapter.groups?.first);
        const tokenStart = bareChapter.groups?.title?.length ?? 0;
        removalRanges.push({ start: tokenStart, end: displayBaseName.length });
        evidence.push('bare_chapter_with_parent');
      }
    }
  }

  const extractedTitle = removeRanges(displayBaseName, removalRanges);
  const workTitle = extractedTitle || fallback;
  const normalizedWorkKey = workTitle ? normalizeSerialWorkKey(workTitle) : undefined;
  const releaseParts: string[] = [];
  if (seasonNumber !== undefined) releaseParts.push(`시즌 ${numericKey(seasonNumber)}`);
  if (volumeNumber !== undefined) releaseParts.push(`${numericKey(volumeNumber)}권`);
  if (specialKind === 'extra') releaseParts.push('외전');
  if (specialKind === 'special') releaseParts.push('특별편');
  if (chapterNumber !== undefined) {
    releaseParts.push(
      chapterEnd !== undefined
        ? `${numericKey(chapterNumber)}-${numericKey(chapterEnd)}화`
        : `${numericKey(chapterNumber)}화`,
    );
  }
  const releaseTitle = releaseParts.join(' ') || displayBaseName;
  const releaseKeyParts: string[] = [];
  if (seasonNumber !== undefined) releaseKeyParts.push(`s:${numericKey(seasonNumber)}`);
  if (volumeNumber !== undefined) releaseKeyParts.push(`v:${numericKey(volumeNumber)}`);
  if (specialKind) releaseKeyParts.push(`special:${specialKind}`);
  if (chapterNumber !== undefined) {
    releaseKeyParts.push(
      chapterEnd !== undefined
        ? `c:${numericKey(chapterNumber)}-${numericKey(chapterEnd)}`
        : `c:${numericKey(chapterNumber)}`,
    );
  }

  const explicit = evidence.some(
    (item) =>
      item !== 'bare_chapter_with_parent' &&
      item !== 'bare_range' &&
      item !== 'file_copy_suffix' &&
      !item.startsWith('completion:'),
  );
  const confidence: SerialReleaseName['confidence'] = explicit
    ? workTitle
      ? 'high'
      : fallback
        ? 'medium'
        : 'low'
    : evidence.includes('bare_chapter_with_parent') || evidence.includes('bare_range')
      ? 'medium'
      : 'low';

  return {
    original: value,
    displayBaseName,
    workTitle,
    normalizedWorkKey,
    looseWorkKey: workTitle ? looseSerialWorkKey(workTitle) : undefined,
    releaseTitle,
    releaseKey: releaseKeyParts.length ? releaseKeyParts.join('/') : undefined,
    chapterNumber,
    chapterEnd,
    volumeNumber,
    seasonNumber,
    specialKind,
    completion,
    confidence,
    evidence,
  };
}
