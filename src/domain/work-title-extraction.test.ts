import { describe, expect, it } from 'vitest';
import { extractWorkTitle } from './work-title-extraction';

describe('work title extraction', () => {
  it('uses the canonical work title first and preserves the imported title as fallback', () => {
    expect(extractWorkTitle('바바리안 퀘스트 1-315 完')).toMatchObject({
      originalTitle: '바바리안 퀘스트 1-315 完',
      canonicalTitle: '바바리안 퀘스트',
      queryCandidates: ['바바리안 퀘스트', '바바리안 퀘스트 1-315 完'],
      parsed: {
        releaseKey: 'c:1-315',
        completion: 'complete',
      },
    });
  });

  it('uses a source filename as an additional hint without overriding a curated title', () => {
    expect(extractWorkTitle('바바리안 퀘스트', '[텍본] 바바리안 퀘스트 1-315 完.txt').queryCandidates).toEqual([
      '바바리안 퀘스트',
    ]);
    expect(extractWorkTitle('별칭', '바바리안 퀘스트 1-315 完.txt').queryCandidates).toEqual([
      '별칭',
      '바바리안 퀘스트',
    ]);
  });

  it.each(['1984', '제5공화국', '20th Century Boys', '2026-08-26', '[최애의 아이]'])(
    'does not strip meaningful title content from %s',
    (title) => {
      expect(extractWorkTitle(title)).toMatchObject({
        canonicalTitle: title,
        queryCandidates: [title],
      });
    },
  );
});
