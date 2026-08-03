import type { EncodingMode } from '@noveldesk/contracts';
import type { DecodedNovelText, ResolvedEncoding } from './contracts';

function supportsDecoder(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function decodeWithLabel(buffer: ArrayBuffer, label: ResolvedEncoding, fatal = false): string {
  const decoderLabel = label === 'euc-kr' ? 'euc-kr' : 'utf-8';
  return new TextDecoder(decoderLabel, { fatal }).decode(buffer);
}

function replacementCount(text: string): number {
  return (text.match(/\uFFFD/g) ?? []).length;
}

export function decodeNovelTextWithEncoding(buffer: ArrayBuffer, mode: EncodingMode): DecodedNovelText {
  if (mode !== 'auto') {
    return {
      text: decodeWithLabel(buffer, mode),
      encoding: mode,
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
