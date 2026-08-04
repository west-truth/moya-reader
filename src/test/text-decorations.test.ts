import { describe, expect, it } from 'vitest';
import { decorateReaderText, readerInlineHighlightRanges } from '../reader/text-decorations';

describe('reader text decorations', () => {
  it('marks only the stored quote instead of the full paragraph', () => {
    expect(
      readerInlineHighlightRanges('첫 문장과 두 번째 문장입니다.', [{ quote: '두 번째 문장', color: 'yellow' }]),
    ).toEqual([{ start: 6, end: 13, color: 'yellow' }]);
  });

  it('skips missing quotes so the caller can keep the paragraph fallback', () => {
    expect(readerInlineHighlightRanges('본문입니다.', [{ quote: '없는 문장', color: 'green' }])).toEqual([]);
  });

  it('combines inline highlights with reader search marks', () => {
    expect(
      decorateReaderText('용사가 돌아왔다. 용사는 검을 들었다.', [{ quote: '용사는 검', color: 'blue' }], '용사'),
    ).toEqual([
      { text: '용사', searchHit: true, highlightColor: undefined },
      { text: '가 돌아왔다. ', searchHit: false, highlightColor: undefined },
      { text: '용사', searchHit: true, highlightColor: 'blue' },
      { text: '는 검', searchHit: false, highlightColor: 'blue' },
      { text: '을 들었다.', searchHit: false, highlightColor: undefined },
    ]);
  });

  it('uses the next non-overlapping occurrence for repeated quotes', () => {
    expect(
      readerInlineHighlightRanges('반복 반복 반복', [
        { quote: '반복', color: 'yellow' },
        { quote: '반복', color: 'pink' },
      ]),
    ).toEqual([
      { start: 0, end: 2, color: 'yellow' },
      { start: 3, end: 5, color: 'pink' },
    ]);
  });

  it('layers active TTS ranges with search and saved highlights', () => {
    expect(
      decorateReaderText('alpha beta gamma', [{ quote: 'beta', color: 'green' }], 'a', [{ start: 6, end: 10 }]),
    ).toEqual([
      { text: 'a', searchHit: true, highlightColor: undefined, ttsActive: undefined },
      { text: 'lph', searchHit: false, highlightColor: undefined, ttsActive: undefined },
      { text: 'a', searchHit: true, highlightColor: undefined, ttsActive: undefined },
      { text: ' ', searchHit: false, highlightColor: undefined, ttsActive: undefined },
      { text: 'bet', searchHit: false, highlightColor: 'green', ttsActive: true },
      { text: 'a', searchHit: true, highlightColor: 'green', ttsActive: true },
      { text: ' g', searchHit: false, highlightColor: undefined, ttsActive: undefined },
      { text: 'a', searchHit: true, highlightColor: undefined, ttsActive: undefined },
      { text: 'mm', searchHit: false, highlightColor: undefined, ttsActive: undefined },
      { text: 'a', searchHit: true, highlightColor: undefined, ttsActive: undefined },
    ]);
  });
});
