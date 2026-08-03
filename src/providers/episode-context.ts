import type { Paragraph } from '../domain/types';
import type {
  ChapterLabelingInterlocutorEdge,
  ChapterLabelingPreviousContext,
  ChapterLabelingRecentTurn,
  ChapterLabelingResult,
} from './ai';

export function episodeContextFromResult(
  chapterId: string,
  result: ChapterLabelingResult,
  options: {
    readonly paragraphs?: readonly Paragraph[];
    readonly correctionMemoryCursor?: string;
    readonly sourceWindowId?: string;
    readonly sourceArtifactId?: string;
    readonly speakerOnly?: boolean;
    readonly previousContext?: ChapterLabelingPreviousContext;
  } = {},
): ChapterLabelingPreviousContext | undefined {
  const context = result.episodeContextSummary;
  if (!context && !options.speakerOnly) return undefined;
  const paragraphById = new Map((options.paragraphs ?? []).map((paragraph) => [paragraph.id, paragraph]));
  const currentRecentTurns = result.segments
    .filter((segment) => ['quoted_dialogue', 'plain_dialogue', 'inner_monologue'].includes(segment.type))
    .flatMap((segment): ChapterLabelingRecentTurn[] => {
      const paragraph = paragraphById.get(segment.paragraphId);
      if (!paragraph || segment.startOffset < 0 || segment.endOffset > paragraph.text.length) return [];
      const text = paragraph.text.slice(segment.startOffset, segment.endOffset).trim();
      return text
        ? [
            {
              paragraphId: segment.paragraphId,
              speakerId: segment.speakerId,
              listenerIds: [...segment.listenerIds],
              emotion: segment.emotion,
              text: text.slice(0, 400),
            },
          ]
        : [];
    })
    .slice(-8);
  const recentTurns = [...(options.previousContext?.recentTurns ?? []), ...currentRecentTurns].slice(-8);
  const edgeKeys = new Set<string>();
  const interlocutorEdges: ChapterLabelingInterlocutorEdge[] = [
    ...(options.previousContext?.interlocutorEdges ?? []),
    ...(context?.interlocutorEdges ?? []),
  ].map((edge) => ({ ...edge }));
  for (const edge of interlocutorEdges) edgeKeys.add(`${edge.sourceCharacterId}:${edge.targetCharacterId}`);
  for (const turn of recentTurns) {
    for (const listenerId of turn.listenerIds) {
      const key = `${turn.speakerId}:${listenerId}`;
      if (turn.speakerId === listenerId || edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      interlocutorEdges.push({ sourceCharacterId: turn.speakerId, targetCharacterId: listenerId });
    }
  }
  const activeCharacterIds = [
    ...new Set([
      ...(options.previousContext?.activeCharacterIds ?? []),
      ...(context?.activeCharacterIds ?? []),
      ...recentTurns
        .map((turn) => turn.speakerId)
        .filter((speakerId) => !['narrator', 'system', 'unknown'].includes(speakerId)),
    ]),
  ];
  const unresolved = [
    ...new Set([
      ...(options.previousContext?.unresolved ?? []),
      ...(context?.unresolved ?? []),
      ...(result.uncertainties ?? []).map((uncertainty) => uncertainty.reasonCode),
    ]),
  ];
  return {
    chapterId,
    summary: context?.summaryForNextChapter || context?.scene || options.previousContext?.summary || '',
    activeCharacterIds,
    unresolved,
    version: 'episode-context-v2',
    scene: context?.scene ?? options.previousContext?.scene,
    interlocutorEdges,
    recentTurns,
    unresolvedReferences: unresolved,
    correctionMemoryCursor: options.correctionMemoryCursor,
    sourceWindowId: options.sourceWindowId,
    sourceArtifactId: options.sourceArtifactId,
  };
}
