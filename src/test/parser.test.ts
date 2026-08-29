import { describe, expect, it, vi } from 'vitest';
import {
  decodeNovelTextWithEncoding,
  isLikelyChapterHeading,
  normalizeNovelText,
  parseNovelFile,
  parseNovelFileForImport,
  previewNovelChapterSplit,
} from '../domain/parser';
import type { Paragraph, ParsedNovelImportChapterSource } from '../domain/types';

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function bytesToBuffer(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

function expectedTitle(input: string): string {
  const trimmed = input.trim();
  const angle = trimmed.match(/^<\s*(.+?)\s*>$/);
  return angle ? angle[1].trim() : trimmed;
}

async function collectImportParagraphs(source: ParsedNovelImportChapterSource) {
  const paragraphs: Paragraph[] = [];
  for await (const chapter of source) {
    paragraphs.push(...chapter.paragraphs);
  }
  return paragraphs;
}

describe('novel parser', () => {
  it('detects strong Korean, English, and angle-wrapped chapter headings', () => {
    expect(isLikelyChapterHeading('<1화>')).toBe(true);
    expect(isLikelyChapterHeading('<작품명 2화>')).toBe(true);
    expect(isLikelyChapterHeading('제 12화 균열')).toBe(true);
    expect(isLikelyChapterHeading('제 십이화 선택')).toBe(true);
    expect(isLikelyChapterHeading('[1화] 균열')).toBe(true);
    expect(isLikelyChapterHeading('[제 12화] 균열')).toBe(true);
    expect(isLikelyChapterHeading('【제1화】 균열')).toBe(true);
    expect(isLikelyChapterHeading('第1화 균열')).toBe(true);
    expect(isLikelyChapterHeading('１２화 균열')).toBe(true);
    expect(isLikelyChapterHeading('Chapter 4 - Return')).toBe(true);
    expect(isLikelyChapterHeading('Episode #12 - Return')).toBe(true);
    expect(isLikelyChapterHeading('[Chapter IV] Return')).toBe(true);
    expect(isLikelyChapterHeading('Chap. 7 - Return')).toBe(true);
    expect(isLikelyChapterHeading('EP. 004 - Return')).toBe(true);
    expect(isLikelyChapterHeading('#4 - 제목')).toBe(true);
    expect(isLikelyChapterHeading('제12화「귀환」')).toBe(true);
    expect(isLikelyChapterHeading('第十二章 归来')).toBe(true);
    expect(isLikelyChapterHeading('第十二話「帰還」')).toBe(true);
    expect(isLikelyChapterHeading('[第十話] 帰還')).toBe(true);
    expect(isLikelyChapterHeading('{제3화} 돌아온 밤')).toBe(true);
    expect(isLikelyChapterHeading('외전 1 어느 겨울')).toBe(true);
    expect(isLikelyChapterHeading('<프롤로그 : 제목>')).toBe(true);
    expect(isLikelyChapterHeading('<생각지도 못한 첫 직장(1)>')).toBe(true);
    expect(isLikelyChapterHeading('평범한 문장입니다.')).toBe(false);
  });

  it('does not treat ambiguous list-like lines as standalone chapter headings', () => {
    expect(isLikelyChapterHeading('[시스템 알림: 선택지가 열렸습니다.]')).toBe(false);
    expect(isLikelyChapterHeading('[1] 각주 내용입니다.')).toBe(false);
    expect(isLikelyChapterHeading('1. 아이템을 확인한다')).toBe(false);
    expect(isLikelyChapterHeading('001')).toBe(false);
    expect(isLikelyChapterHeading('【001】')).toBe(false);
    expect(isLikelyChapterHeading('작품명 1화')).toBe(false);
    expect(isLikelyChapterHeading('나는 3회 연속 실패했다')).toBe(false);
    expect(isLikelyChapterHeading('<시스템 알림(1)>')).toBe(false);
    expect(isLikelyChapterHeading('2026.07.04')).toBe(false);
  });

  it('normalizes line endings without rewriting body content', () => {
    expect(normalizeNovelText('\uFEFF첫 줄\r\n둘째 줄  \r\n\r\n끝')).toBe('첫 줄\n둘째 줄\n\n끝');
  });

  it('records the imported text format without relying on the reader UI', async () => {
    const txt = await parseNovelFile('본문.TXT', toBuffer('첫 문단'), 'utf-8');
    const markdown = await parseNovelFile('본문.markdown', toBuffer('# 제목\n\n첫 문단'), 'utf-8');

    expect(txt.novel.format).toBe('txt');
    expect(markdown.novel.format).toBe('markdown');
  });

  it('detects UTF-8 and CP949/EUC-KR text in auto mode', async () => {
    const utf8 = toBuffer('제 1화 시작\n\n강현우는 눈을 떴다.');
    const cp949 = bytesToBuffer([
      0xc1, 0xa6, 0x20, 0x31, 0xc8, 0xad, 0x20, 0xbd, 0xc3, 0xc0, 0xdb, 0x0a, 0x0a, 0xb0, 0xad, 0xc7, 0xf6, 0xbf, 0xec,
      0xb4, 0xc2, 0x20, 0xb4, 0xab, 0xc0, 0xbb, 0x20, 0xb6, 0xb9, 0xb4, 0xd9, 0x2e, 0x0a, 0x0a, 0xc1, 0xa6, 0x20, 0x32,
      0xc8, 0xad, 0x20, 0xbc, 0xb1, 0xc5, 0xc3, 0x0a, 0x0a, 0xb4, 0xd9, 0xc0, 0xbd, 0x20, 0xb9, 0xae, 0xb4, 0xdc, 0xc0,
      0xd4, 0xb4, 0xcf, 0xb4, 0xd9, 0x2e,
    ]);

    expect(decodeNovelTextWithEncoding(utf8, 'auto')).toMatchObject({
      encoding: 'utf-8',
      text: '제 1화 시작\n\n강현우는 눈을 떴다.',
    });
    expect(decodeNovelTextWithEncoding(cp949, 'auto')).toMatchObject({
      encoding: 'euc-kr',
      text: '제 1화 시작\n\n강현우는 눈을 떴다.\n\n제 2화 선택\n\n다음 문단입니다.',
    });

    const parsed = await parseNovelFile('CP949소설.txt', cp949, 'auto');
    expect(parsed.novel.sourceEncoding).toBe('euc-kr');
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작', '제 2화 선택']);
  });

  it('respects manual CP949/EUC-KR encoding selection', () => {
    const cp949 = bytesToBuffer([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xba, 0xbb, 0xb9, 0xae]);

    expect(decodeNovelTextWithEncoding(cp949, 'euc-kr')).toEqual({
      encoding: 'euc-kr',
      text: '한글 본문',
    });
  });

  it.each([
    ['angle_hwa', '<1화>', '<2화>'],
    ['title_prefix_hwa', 'Novel Title 1화', 'Novel Title 2화'],
    ['leading_5digits', '00001 <-- 작품명 -->', '00002 <-- 작품명 -->'],
    ['bracket_number', '[1]', '[002]'],
    ['decorative_bracket_number', '【001】', '『002』'],
    ['bracket_number_title', '[001] Prologue', '[002] Return'],
    ['number_underscore', '040_Title', '041_Cambrai (41)'],
    ['number_title', '001 첫 번째 장', '002 Second chapter'],
    ['dash_episode', '001 - 제목', '002 - 제목'],
    ['dot_episode', '1. 제목', '2. 제목'],
    ['number_only', '001', '002'],
    ['hash_number', '#1', '#2 - 제목'],
    ['ep_title', 'EP 1 - 제목', '< Episode 2. End >'],
    ['ep_hash_title', 'Episode #1 - 제목', 'Episode #2 - 제목'],
    ['bracket_ep_title', '[Chapter 001]', '[Chapter 002]'],
    ['roman_chapter', 'Chapter I - Gate', 'Chapter II - Return'],
    ['e_number', 'E01 제목', 'E02 제목'],
    ['bracket_dash_episode', '[001 - 제목]', '[002 - 제목]'],
    ['bracket_dot_episode', '[001. 제목]', '[002. 제목]'],
    ['brace_dash_episode', '{001 - 제목}', '{002 - 제목}'],
    ['paren_dash_episode', '(001 - 제목)', '(002 - 제목)'],
    ['bullet_dash_episode', '- 001 - 제목', '- 002 - 제목'],
    ['bullet_revision_episode', '- (수정판) 001 - 제목', '- (수정판) 002 - 제목'],
    ['colon_episode', '001:제목', '002：제목'],
    ['cjk_numbered', '第十章 起', '第十一章 承'],
    ['cjk_bracket_numbered', '[第十話] 帰還', '[第十一話] 決着'],
    ['chap_alias', 'Chap. 1 - Return', 'Chap. 2 - End'],
  ])('splits %s style headings when the document has a real sequence', async (_, first, second) => {
    const bodyA = '첫 번째 본문입니다. 인물은 방 안의 소리를 듣고 천천히 움직였다. 장면은 충분한 길이로 이어진다.';
    const bodyB = '두 번째 본문입니다. 선택의 결과가 드러나고 다음 사건으로 자연스럽게 넘어간다. 문단 길이도 충분하다.';
    const parsed = await parseNovelFile(
      '연속 표식.txt',
      toBuffer(`${first}\n\n${bodyA}\n\n${second}\n\n${bodyB}`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].title).toBe(expectedTitle(first));
    expect(parsed.chapters[1].title).toBe(expectedTitle(second));
  });

  it('auto-splits low-risk weak heading styles when exporter format changes mid-file', async () => {
    const parsed = await parseNovelFile(
      '자동 혼합 표식.txt',
      toBuffer(`00001 <-- 작품명 -->

첫 번째 본문입니다. 앞부분은 5자리 숫자 export 표식으로 시작했다. 장면 설명은 충분히 길게 이어진다.

002 - 두 번째 장

두 번째 본문입니다. 중간부터 숫자 대시 제목으로 바뀌었지만 번호가 이어지고 본문도 충분하다.

003_Title

세 번째 본문입니다. 다시 언더스코어 표식으로 바뀌어도 저위험 회차 표식이면 자동 분리에서 이어진다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      '00001 <-- 작품명 -->',
      '002 - 두 번째 장',
      '003_Title',
    ]);
  });

  it('splits title-bearing weak headings when the body starts on the next line', async () => {
    const parsed = await parseNovelFile(
      '붙은 본문 표식.txt',
      toBuffer(`001 - 첫 번째 장
첫 번째 본문입니다. export 파일에 따라 회차 제목 바로 다음 줄부터 본문이 시작할 수 있다. 본문 길이는 충분하다.

002 - 두 번째 장
두 번째 본문입니다. blank line이 제목 뒤에 없어도 번호가 이어지고 제목 신호가 있으면 회차로 나눈다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['001 - 첫 번째 장', '002 - 두 번째 장']);
  });

  it('keeps numbered arc subtitles inside explicit serialized episodes', async () => {
    const parsed = await parseNovelFile(
      '작품.txt',
      toBuffer(`<작품 1화>

0. 프롤로그

첫 번째 프롤로그 본문은 충분히 길게 이어진다. 시스템의 안내를 받은 주인공이 상황을 확인하고 움직이기 시작한다.

1. 첫 번째 장

같은 연재 화 안에서 장 소제목만 바뀐다. 이 번호는 다음 연재 화가 아니라 작품 내부 장 번호다.

<작품 2화>

2. 두 번째 장

두 번째 연재 화의 본문도 충분히 길다. 앞 화에서 시작된 사건이 끊기지 않고 다음 장면으로 이어진다.

<작품 3화>

세 번째 연재 화의 본문이다. 명시적인 화 표지가 약한 번호 소제목보다 우선해야 한다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['작품 1화', '작품 2화', '작품 3화']);
    expect(parsed.chapters[0]?.normalizedText).toContain('0. 프롤로그');
    expect(parsed.chapters[0]?.normalizedText).toContain('1. 첫 번째 장');
    expect(parsed.chapters[1]?.normalizedText).toContain('2. 두 번째 장');
  });

  it('does not create extra chapters from a repeated hash subtitle inside exporter-numbered chapters', async () => {
    const body = (marker: string) => `${marker} ${'본문이 충분히 이어진다. '.repeat(8)}`;
    const parsed = await parseNovelFile(
      '중복 표식.txt',
      toBuffer(`00001 #1 하늘산맥

#1 하늘산맥

${body('첫 번째 본문')}

00002 #1 하늘산맥

${body('두 번째 본문')}

00003 #1 하늘산맥

${body('세 번째 본문')}

00004 #2 내 이름은 유릭

#2 내 이름은 유릭.

${body('네 번째 본문')}

00005 #2 내 이름은 유릭

${body('다섯 번째 본문')}`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      '00001 #1 하늘산맥',
      '00002 #1 하늘산맥',
      '00003 #1 하늘산맥',
      '00004 #2 내 이름은 유릭',
      '00005 #2 내 이름은 유릭',
    ]);
    expect(parsed.chapters.every((chapter) => chapter.characterCount > 0)).toBe(true);
    expect(parsed.chapters[0]?.normalizedText).toContain('#1 하늘산맥');
    expect(parsed.chapters[3]?.normalizedText).toContain('#2 내 이름은 유릭.');
  });

  it('folds an empty repeated base heading into the first episode part without merging later parts', async () => {
    const body = (marker: string) => `${marker} ${'장면과 대화가 충분히 이어진다. '.repeat(8)}`;
    const parsed = await parseNovelFile(
      '파트 중복 표식.txt',
      toBuffer(`Episode 2. 주인공 (4)

${body('네 번째 파트')}

Episode 2. 주인공 (5)

${body('다섯 번째 파트')}

Episode 3. 계약 (1)

Episode 3. 계약

${body('첫 번째 파트')}

Episode 3. 계약 (2)

${body('두 번째 파트')}

Episode 3. 계약 (3)

${body('세 번째 파트')}`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      'Episode 2. 주인공 (4)',
      'Episode 2. 주인공 (5)',
      'Episode 3. 계약 (1)',
      'Episode 3. 계약 (2)',
      'Episode 3. 계약 (3)',
    ]);
    expect(parsed.chapters.every((chapter) => chapter.characterCount > 0)).toBe(true);
    expect(parsed.chapters[2]?.normalizedText).toContain('Episode 3. 계약');
  });

  it('removes zero-length duplicate boundaries after long chapters and folds a short author note', async () => {
    const body = (marker: string) => `${marker} ${'정상 본문이 충분히 이어진다. '.repeat(40)}`;
    const parsed = await parseNovelFile(
      '짧은 중복 경계.txt',
      toBuffer(`Episode 9. 전지적 개복치 (1)

${body('첫 번째 파트')}

Episode 9. 전지적 개복치 (1)

Episode 9. 전지적 개복치 (2)

${body('두 번째 파트')}

Episode 9. 전지적 개복치 (2)

Episode 9. 전지적 개복치 (3)

${body('세 번째 파트')}

Episode 9. 전지적 개복치 (3)

작가 후기

짧은 공지입니다.

Episode 10. 다음 이야기 (1)

${body('다음 화 본문')}`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      'Episode 9. 전지적 개복치 (1)',
      'Episode 9. 전지적 개복치 (2)',
      'Episode 9. 전지적 개복치 (3)',
      'Episode 10. 다음 이야기 (1)',
    ]);
    expect(parsed.chapters.every((chapter) => chapter.characterCount > 0)).toBe(true);
    expect(parsed.chapters[2]?.normalizedText).toContain('작가 후기');
    expect(parsed.chapters[2]?.normalizedText).toContain('짧은 공지입니다.');
  });

  it('keeps title-only documents as one chapter named after the file', async () => {
    const parsed = await parseNovelFile(
      '푸른 밤.txt',
      toBuffer(`푸른 밤

이 줄은 제목처럼 보일 수 있지만 명시적인 화 표식은 아니다.

검은 새벽

다른 소제목처럼 보이는 줄도 억지로 화로 나누지 않는다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('푸른 밤');
    expect(parsed.chapters[0].normalizedText).toContain('검은 새벽');
  });

  it('does not split short numbered choice lists', async () => {
    const parsed = await parseNovelFile(
      '선택지.txt',
      toBuffer(`본문이 시작된다.

[1] 문을 연다.
[2] 기다린다.
[3] 돌아간다.

선택지는 번호가 있어도 본문 길이가 짧고 장면 표식이 아니므로 그대로 둔다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('선택지');
  });

  it('does not split long bracketed choice lists with explanations', async () => {
    const parsed = await parseNovelFile(
      '긴 선택지.txt',
      toBuffer(`본문이 시작된다.

[1] 문을 열고 복도로 나간다.

이 선택지는 길게 설명되지만 회차 제목이 아니라 본문 안의 선택지다. 설명이 충분히 길어도 분리되면 안 된다.

[2] 방 안에서 더 기다린다.

두 번째 선택지도 길게 설명된다. 번호가 증가하고 본문이 있어 보여도 장면 선택지일 뿐이다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('긴 선택지');
  });

  it('keeps a valid weak heading run even when later candidates reset numbering', async () => {
    const parsed = await parseNovelFile(
      '리셋 후보.txt',
      toBuffer(`1. 첫 번째 장

첫 번째 장면은 충분히 긴 본문을 가진다. 인물이 상황을 확인하고 다음 사건으로 이어지는 문장이 계속된다.

2. 두 번째 장

두 번째 장면도 충분히 긴 본문을 가진다. 뒤쪽에 번호가 다시 시작되는 목록이 있어도 이 장은 유지되어야 한다.

1. 부록 항목

이 줄은 뒤쪽에서 번호가 다시 시작되는 후보일 뿐이고 앞의 정상적인 1, 2 회차 분리를 깨면 안 된다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].title).toBe('1. 첫 번째 장');
    expect(parsed.chapters[1].title).toBe('2. 두 번째 장');
  });

  it('can use mixed split mode when a document changes weak heading styles mid-file', async () => {
    const parsed = await parseNovelFile(
      '혼합 표식.txt',
      toBuffer(`00001 <-- 작품명 -->

첫 번째 본문입니다. 같은 제작자가 앞부분을 5자리 번호 표식으로 정리했다. 장면은 충분한 길이로 이어진다.

002 - 두 번째 장

두 번째 본문입니다. 중간부터 표식 방식이 바뀌어도 사용자가 혼합 표식 강화를 선택하면 이어진 회차로 본다.`),
      'utf-8',
      { chapterSplitMode: 'mixed' },
    );

    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['00001 <-- 작품명 -->', '002 - 두 번째 장']);
  });

  it('mixed mode accepts a final high-risk style switch after a strong chapter', async () => {
    const parsed = await parseNovelFile(
      '마지막 형식 변경.txt',
      toBuffer(`제 1화 시작

첫 번째 본문입니다. 앞부분은 명시적인 한국어 회차 표식을 사용한다. 본문 길이는 충분해서 실제 회차로 인정된다.

2. 두 번째 장

두 번째 본문입니다. 파일 끝부분에서 숫자 점 제목 형식으로 바뀐 마지막 회차도 사용자가 혼합 표식을 선택하면 분리한다.`),
      'utf-8',
      { chapterSplitMode: 'mixed' },
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작', '2. 두 번째 장']);
  });

  it('mixed mode accepts a final compact bracket-number switch after a strong chapter', async () => {
    const parsed = await parseNovelFile(
      '마지막 괄호 번호 변경.txt',
      toBuffer(`Chapter 1 - Start

The first body is long enough to prove the file started with an explicit chapter heading before the export format changed.

[002]

The second body is also long enough. In mixed mode the compact bracket marker can be treated as a trailing producer switch.`),
      'utf-8',
      { chapterSplitMode: 'mixed' },
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1 - Start', '[002]']);
  });

  it('auto-continues splitting from a strong heading into a later low-risk weak heading style', async () => {
    const parsed = await parseNovelFile(
      '중간 변경.txt',
      toBuffer(`제 1화 시작

첫 번째 본문입니다. 앞부분은 명시적인 한국어 회차 표식을 사용한다. 본문 길이는 충분해서 실제 회차로 인정된다.

002 - 두 번째 장

두 번째 본문입니다. 중간부터 export 방식이 숫자 대시 제목으로 바뀌어도 자동 분리에서 이어진 번호로 인정한다.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['제 1화 시작', '002 - 두 번째 장']);
  });

  it('auto-accepts a high-risk producer switch after an accepted chapter sequence', async () => {
    const parsed = await parseNovelFile(
      'producer-switch.txt',
      toBuffer(`Chapter 1 - Start

The first body is long enough to prove this is a real chapter. It gives the parser a strong accepted anchor before the export style changes.

[002]

The second body keeps enough text after a bracket-only marker. A later producer may have emitted this compact marker while keeping episode numbering continuous.

3. Third Title

The third body adds a title-bearing high-risk marker, proving the middle of the file moved to another export style instead of a short body list.`),
      'utf-8',
    );

    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1 - Start', '[002]', '3. Third Title']);
  });

  it('previews chapter split results without building full parsed paragraphs', async () => {
    const preview = await previewNovelChapterSplit(
      '미리보기.txt',
      toBuffer(`00001 <-- 작품명 -->

첫 번째 본문입니다. 같은 제작자가 앞부분을 5자리 번호 표식으로 정리했다. 장면은 충분한 길이로 이어진다.

002 - 두 번째 장

두 번째 본문입니다. 사용자가 가져오기 전에 혼합 분리 결과를 확인할 수 있어야 한다.`),
      'utf-8',
      { chapterSplitMode: 'mixed' },
    );

    expect(preview).toMatchObject({
      title: '미리보기',
      sourceEncoding: 'utf-8',
      totalChapters: 2,
    });
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual(['00001 <-- 작품명 -->', '002 - 두 번째 장']);
    expect(preview.totalParagraphs).toBe(2);
  });

  it('keeps high-risk weak heading style changes conservative in auto mode', async () => {
    const parsed = await parseNovelFile(
      '보수적 자동.txt',
      toBuffer(`001

첫 번째 본문입니다. 숫자만 있는 줄은 회차일 수도 있지만 본문 목록일 수도 있어서 자동 전환에서는 보수적으로 본다.

[002]

두 번째 본문입니다. 대괄호 숫자도 오탐 위험이 높으므로 서로 다른 고위험 표식 전환만으로는 자동 분리하지 않는다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('보수적 자동');
  });

  it('can force title-only or noisy files into one chapter', async () => {
    const parsed = await parseNovelFile(
      '단일 화.txt',
      toBuffer(`제 1화처럼 보이는 줄

본문입니다. 사용자가 분리하지 않음을 고르면 회차 표식처럼 보여도 한 권 본문으로 보존한다.

제 2화처럼 보이는 줄

뒤쪽 본문입니다.`),
      'utf-8',
      { chapterSplitMode: 'single' },
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('단일 화');
  });

  it('does not split prose lines that merely contain Korean counters', async () => {
    const parsed = await parseNovelFile(
      '오탐 방지.txt',
      toBuffer(`첫 문단은 평범하게 이어진다.

나는 3회 연속 실패했다.

그래도 그는 다시 시도했고, 이 문장은 실제 회차 제목이 아니라 본문이다.`),
      'utf-8',
    );

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('오탐 방지');
  });

  it('falls back to one source-preserving chapter when every heading candidate has an empty body', async () => {
    const parsed = await parseNovelFile('빈 목차.txt', toBuffer('1화\n2화\n3화'), 'utf-8');

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]).toMatchObject({
      title: '빈 목차',
      normalizedText: '1화\n2화\n3화',
      rawStartOffset: 0,
      rawEndOffset: '1화\n2화\n3화'.length,
    });
    expect(parsed.paragraphs.map((paragraph) => paragraph.text)).toEqual(['1화', '2화', '3화']);
  });

  it('splits TXT into chapters and paragraph offsets', async () => {
    const parsed = await parseNovelFile(
      '회귀한 독자.txt',
      toBuffer(`제 1화 시작

강현우는 눈을 떴다.

"여긴 어디지?"

제 2화 선택

[시스템 알림: 선택지가 열렸습니다.]

그는 다시 걸음을 옮겼다.`),
      'utf-8',
    );

    expect(parsed.novel.title).toBe('회귀한 독자');
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.paragraphs.length).toBeGreaterThanOrEqual(4);
    for (const paragraph of parsed.paragraphs) {
      expect(paragraph.startOffsetInChapter).toBeGreaterThanOrEqual(0);
      expect(paragraph.endOffsetInChapter).toBeGreaterThan(paragraph.startOffsetInChapter);
    }
  });

  it('emits import-ready metadata and paragraphs equivalent to the compatibility parser', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'));
    try {
      const buffer = toBuffer(`제 1화 시작

강현우는 눈을 떴다.

"여긴 어디지?"

제 2화 선택

[시스템 알림: 선택지가 열렸습니다.]

그는 다시 걸음을 옮겼다.`);
      const parsed = await parseNovelFile('회귀한 독자.txt', buffer, 'utf-8');
      const importReady = await parseNovelFileForImport('회귀한 독자.txt', buffer, 'utf-8');
      const paragraphs = await collectImportParagraphs(importReady.consumeChapterParagraphs());
      const { rawText: _parsedRaw, normalizedText: _parsedNormalized, ...parsedNovelMeta } = parsed.novel;
      const { rawText, normalizedText, ...importNovelMeta } = importReady.novel;
      const parsedChapters = parsed.chapters.map(({ normalizedText: _text, ...chapter }) => chapter);
      const importChapters = importReady.chapters.map(({ normalizedText: _text, ...chapter }) => chapter);

      expect({ rawText, normalizedText }).toEqual({ rawText: '', normalizedText: '' });
      expect(importNovelMeta).toEqual(parsedNovelMeta);
      expect(importChapters).toEqual(parsedChapters);
      expect(importReady.chapters.every((chapter) => chapter.normalizedText === '')).toBe(true);
      expect(paragraphs).toEqual(parsed.paragraphs);
      expect(await collectImportParagraphs(importReady.consumeChapterParagraphs())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
