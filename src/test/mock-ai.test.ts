import { describe, expect, it } from 'vitest';
import { parseNovelFile } from '../domain/parser';
import { MockAIProvider } from '../providers/ai';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('MockAIProvider', () => {
  it('creates provider-agnostic segment labels without network calls', async () => {
    const parsed = await parseNovelFile(
      '샘플.txt',
      toBuffer(`제 1화

[시스템 알림: 시작합니다.]

"현우 씨, 준비됐나요?"

강현우는 고개를 끄덕였다.`),
      'utf-8',
    );
    const chapter = parsed.chapters[0];
    const paragraphs = parsed.paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id);
    const result = await new MockAIProvider().labelChapterSegments({
      novelId: parsed.novel.id,
      chapter,
      paragraphs,
    });

    expect(result.characters.length).toBeGreaterThan(0);
    expect(result.segments).toHaveLength(paragraphs.length);
    expect(result.segments.some((segment) => segment.type === 'system_message')).toBe(true);
    expect(result.segments.every((segment) => segment.confidence >= 0 && segment.confidence <= 1)).toBe(true);
  });

  it('consolidates graph candidates without automatic identity collapse', async () => {
    const provider = new MockAIProvider();
    const result = await provider.mergeCharacterGraph({
      novelId: 'book_1',
      existingGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'char_hyun',
            novelId: 'book_1',
            canonicalName: '강현우',
            aliases: ['현우'],
            color: '#3b82f6',
            description: '사용자가 확정한 이름.',
            confidence: 0.95,
            isUserConfirmed: true,
          },
        ],
        relations: [],
      },
      discoveredGraph: {
        novelId: 'book_1',
        characters: [
          {
            id: 'candidate_hyun',
            novelId: 'book_1',
            canonicalName: '현우',
            aliases: ['강 대리'],
            color: '#ef476f',
            description: '새 후보.',
            confidence: 0.75,
            isUserConfirmed: false,
          },
          {
            id: 'char_minseo',
            novelId: 'book_1',
            canonicalName: '박민서',
            aliases: ['팀장님'],
            color: '#2fbf71',
            confidence: 0.82,
            isUserConfirmed: false,
          },
        ],
        relations: [
          {
            id: 'rel_1',
            novelId: 'book_1',
            sourceCharacterId: 'candidate_hyun',
            targetCharacterId: 'char_minseo',
            relationLabel: 'work_colleague',
            termsUsedBySource: ['팀장님'],
            termsUsedByTarget: ['강 대리'],
            confidence: 0.7,
            evidence: ['호칭 근거.'],
          },
        ],
      },
    });

    expect(result.characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'char_hyun',
          canonicalName: '강현우',
          aliases: ['현우'],
          isUserConfirmed: true,
        }),
        expect.objectContaining({ id: 'candidate_hyun', canonicalName: '현우' }),
        expect.objectContaining({ id: 'char_minseo' }),
      ]),
    );
    expect(result.relations).toEqual([
      expect.objectContaining({
        sourceCharacterId: 'candidate_hyun',
        targetCharacterId: 'char_minseo',
        relationLabel: 'work_colleague',
      }),
    ]);
  });
});
