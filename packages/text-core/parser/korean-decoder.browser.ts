/** Browsers implement the WHATWG EUC-KR index, including CP949. Keep server ICU tables out of web bundles. */
export function decodeKoreanText(buffer: ArrayBuffer, fatal = false): string {
  return new TextDecoder('euc-kr', { fatal }).decode(buffer);
}
