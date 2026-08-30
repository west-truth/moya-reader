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

  it('uses an OS-copy-cleaned source filename only as the leading catalog query', () => {
    expect(extractWorkTitle('아기는 악당을 키운다 완 (1)', '아기는 악당을 키운다 완 (1).txt')).toMatchObject({
      originalTitle: '아기는 악당을 키운다 완 (1)',
      canonicalTitle: '아기는 악당을 키운다',
      queryCandidates: ['아기는 악당을 키운다', '아기는 악당을 키운다 완 (1)'],
      evidence: expect.arrayContaining(['file_copy_suffix', 'completion:complete', 'title_cleanup']),
    });
  });

  it('does not let a copied source filename override a curated title or a meaningful chapter marker', () => {
    expect(extractWorkTitle('별칭', '아기는 악당을 키운다 완 (1).txt').queryCandidates).toEqual([
      '별칭',
      '아기는 악당을 키운다',
    ]);
    expect(extractWorkTitle('작품 (1)', '작품 (1) 2화.txt')).toMatchObject({
      canonicalTitle: '작품 (1)',
      queryCandidates: ['작품 (1)'],
    });
  });
});
