export function isCurrentParagraphPageLoad(input: {
  activeChapterId?: string;
  requestedChapterId: string;
  activeGeneration: number;
  requestedGeneration: number;
}): boolean {
  return input.activeChapterId === input.requestedChapterId &&
    input.activeGeneration === input.requestedGeneration;
}
