import { TextDecoder as KoreanTextDecoder } from '@kayahr/text-encoding/no-encodings';
import '@kayahr/text-encoding/encodings/euc-kr';

// Node/ICU may accept the label but omit CP949's extended Hangul.
const nativeKoreanDecoder = (() => {
  try {
    return new TextDecoder('euc-kr').decode(Uint8Array.of(0x8c, 0x63)) === '똠';
  } catch {
    return false;
  }
})();

export function decodeKoreanText(buffer: ArrayBuffer, fatal = false): string {
  return nativeKoreanDecoder
    ? new TextDecoder('euc-kr', { fatal }).decode(buffer)
    : new KoreanTextDecoder('euc-kr', { fatal }).decode(buffer);
}
