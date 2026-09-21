import { decodeKoreanText } from '#korean-decoder';
import type { EncodingMode } from '@noveldesk/contracts';
import type { DecodedNovelText, ResolvedEncoding } from './contracts';

export const TEXT_ENCODING_LABELS: Readonly<Record<ResolvedEncoding, string>> = {
  'utf-8': 'UTF-8',
  'euc-kr': 'CP949 / EUC-KR',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  shift_jis: 'Shift_JIS / Windows-31J',
  'euc-jp': 'EUC-JP',
  'iso-2022-jp': 'ISO-2022-JP',
  gb18030: 'GB18030 / GBK',
  big5: 'Big5',
  'windows-1252': 'Windows-1252 (서유럽)',
  'windows-1251': 'Windows-1251 (키릴 문자)',
};

export function isEncodingMode(value: unknown): value is EncodingMode {
  return (
    typeof value === 'string' && (value === 'auto' || Object.prototype.hasOwnProperty.call(TEXT_ENCODING_LABELS, value))
  );
}

function supportsDecoder(label: string): boolean {
  if (label === 'euc-kr') return true;
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function decodeWithLabel(buffer: ArrayBuffer, label: ResolvedEncoding, fatal = false): string {
  if (label === 'euc-kr') return decodeKoreanText(buffer, fatal);
  return new TextDecoder(label, { fatal }).decode(buffer);
}

function replacementCount(text: string): number {
  return (text.match(/\uFFFD/g) ?? []).length;
}

/** Only infer BOM-less UTF-16 when repeated ASCII spacing has an unambiguous zero-byte lane. */
function unicodeEncoding(buffer: ArrayBuffer): ResolvedEncoding | undefined {
  const bytes = new Uint8Array(buffer);
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  )
    throw new Error('UTF-32 파일은 UTF-8로 변환한 뒤 가져와 주세요.');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes.length % 2 !== 0) return;
  const sample = bytes.subarray(0, 16 * 1024);
  let le = 0;
  let be = 0;
  const ascii = (byte: number) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
  for (let i = 0; i < sample.length; i += 2) {
    if (sample[i + 1] === 0 && ascii(sample[i]!)) le++;
    if (sample[i] === 0 && ascii(sample[i + 1]!)) be++;
  }
  const label = le >= 2 && be === 0 ? 'utf-16le' : be >= 2 && le === 0 ? 'utf-16be' : undefined;
  if (!label) return;
  try {
    const text = new TextDecoder(label, { fatal: true }).decode(sample, { stream: true });
    // Binary/control-filled input is not evidence of a Unicode text document.
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 && ![9, 10, 12, 13].includes(code)) return;
    }
    return label;
  } catch {
    /* Ambiguous input can still be opened with an explicit encoding. */
  }
}

export function decodeNovelTextWithEncoding(buffer: ArrayBuffer, mode: EncodingMode): DecodedNovelText {
  if (!isEncodingMode(mode)) throw new Error('지원하지 않는 텍스트 인코딩입니다.');
  const selected = mode === 'auto' ? unicodeEncoding(buffer) : mode;
  if (selected) {
    if (!supportsDecoder(selected)) throw new Error('이 환경에서 지원하지 않는 인코딩입니다. UTF-8로 변환해 주세요.');
    return {
      text: decodeWithLabel(buffer, selected),
      encoding: selected,
    };
  }

  try {
    return {
      text: decodeWithLabel(buffer, 'utf-8', true),
      encoding: 'utf-8',
    };
  } catch {
    const utf8 = decodeWithLabel(buffer, 'utf-8');
    if (!supportsDecoder('euc-kr')) {
      return { text: utf8, encoding: 'utf-8' };
    }

    const eucKr = decodeWithLabel(buffer, 'euc-kr');
    return replacementCount(eucKr) <= replacementCount(utf8)
      ? { text: eucKr, encoding: 'euc-kr' }
      : { text: utf8, encoding: 'utf-8' };
  }
}

export function decodeNovelText(buffer: ArrayBuffer, mode: EncodingMode): string {
  return decodeNovelTextWithEncoding(buffer, mode).text;
}
