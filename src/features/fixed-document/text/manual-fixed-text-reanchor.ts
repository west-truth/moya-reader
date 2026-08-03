import type { DocumentAnchor, DocumentAnnotation } from '../../../domain/types';

type FixedTextAnchor = Extract<DocumentAnchor, { kind: 'fixed_text' }>;

export function manuallyReanchorFixedTextAnnotation(input: {
  readonly annotation: DocumentAnnotation;
  readonly anchor: FixedTextAnchor;
  readonly quote: string;
  readonly updatedAt: string;
}): DocumentAnnotation {
  const currentAnchor = input.annotation.anchor;
  if (currentAnchor.kind !== 'fixed_text') throw new Error('텍스트 주석만 다시 연결할 수 있습니다.');
  if (input.annotation.bookId !== input.anchor.bookId || input.annotation.pageIndex !== input.anchor.pageIndex) {
    throw new Error('같은 책의 같은 페이지 텍스트를 선택해야 합니다.');
  }

  return {
    ...input.annotation,
    anchor: input.anchor,
    quote: input.quote,
    textAnchorRemap: {
      status: 'remapped',
      fromTextRevisionId: currentAnchor.textRevisionId,
      targetTextRevisionId: input.anchor.textRevisionId,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}
