import { persistentId128 } from '@noveldesk/text-core/hash';
import type { Paragraph } from '@noveldesk/contracts';
import type {
  ChapterLabelingInterlocutorEdge,
  ChapterLabelingPreviousContext,
  ChapterLabelingRecentTurn,
  ChapterLabelingResult,
} from '../../../../../src/providers/ai';
import { episodeContextFromResult as sharedEpisodeContextFromResult } from '../../../../../src/providers/episode-context';
import type pg from 'pg';
import type { RevisionQueryable } from './analysis-input-repository.js';

interface EpisodeContextRow extends pg.QueryResultRow {
  id: string;
  context: unknown;
  artifact_id: string;
}

function contextFromValue(value: unknown): ChapterLabelingPreviousContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Episode Context is invalid');
  const body = value as Record<string, unknown>;
  const activeCharacterIds = Array.isArray(body.activeCharacterIds)
    ? body.activeCharacterIds.filter((item): item is string => typeof item === 'string')
    : [];
  const unresolved = Array.isArray(body.unresolved)
    ? body.unresolved.filter((item): item is string => typeof item === 'string')
    : [];
  if (typeof body.chapterId !== 'string' || typeof body.summary !== 'string') {
    throw new Error('Episode Context identity is invalid');
  }
  const interlocutorEdges = Array.isArray(body.interlocutorEdges)
    ? body.interlocutorEdges.flatMap((item): ChapterLabelingInterlocutorEdge[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const edge = item as Record<string, unknown>;
        return typeof edge.sourceCharacterId === 'string' && typeof edge.targetCharacterId === 'string'
          ? [
              {
                sourceCharacterId: edge.sourceCharacterId,
                targetCharacterId: edge.targetCharacterId,
                confidence: typeof edge.confidence === 'number' ? edge.confidence : undefined,
              },
            ]
          : [];
      })
    : undefined;
  const recentTurns = Array.isArray(body.recentTurns)
    ? body.recentTurns.flatMap((item): ChapterLabelingRecentTurn[] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const turn = item as Record<string, unknown>;
        if (
          typeof turn.paragraphId !== 'string' ||
          typeof turn.speakerId !== 'string' ||
          typeof turn.emotion !== 'string' ||
          typeof turn.text !== 'string'
        ) {
          return [];
        }
        return [
          {
            paragraphId: turn.paragraphId,
            speakerId: turn.speakerId,
            listenerIds: Array.isArray(turn.listenerIds)
              ? turn.listenerIds.filter((listener): listener is string => typeof listener === 'string')
              : [],
            emotion: turn.emotion,
            text: turn.text,
          },
        ];
      })
    : undefined;
  const unresolvedReferences = Array.isArray(body.unresolvedReferences)
    ? body.unresolvedReferences.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    chapterId: body.chapterId,
    summary: body.summary,
    activeCharacterIds,
    unresolved,
    version: body.version === 'episode-context-v2' ? body.version : undefined,
    scene: typeof body.scene === 'string' ? body.scene : undefined,
    interlocutorEdges,
    recentTurns,
    unresolvedReferences,
    correctionMemoryCursor: typeof body.correctionMemoryCursor === 'string' ? body.correctionMemoryCursor : undefined,
    sourceWindowId: typeof body.sourceWindowId === 'string' ? body.sourceWindowId : undefined,
    sourceArtifactId: typeof body.sourceArtifactId === 'string' ? body.sourceArtifactId : undefined,
  };
}

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
  return sharedEpisodeContextFromResult(chapterId, result, options);
}

export async function loadPreviousWorkflowEpisodeContext(
  db: RevisionQueryable,
  input: {
    readonly workflowId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly chapterIndex: number;
    readonly windowSequence: number;
  },
): Promise<ChapterLabelingPreviousContext | undefined> {
  const sameChapter = await db.query<EpisodeContextRow>(
    `
      select id, context, artifact_id
      from analysis_episode_contexts
      where workflow_id = $1
        and book_id = $2
        and chapter_id = $3
        and window_sequence < $4
        and status = 'active'
      order by window_sequence desc
      limit 1
    `,
    [input.workflowId, input.bookId, input.chapterId, input.windowSequence],
  );
  if (sameChapter.rows[0]) return contextFromValue(sameChapter.rows[0].context);

  const previousChapter = await db.query<EpisodeContextRow>(
    `
      select context.id, context.context, context.artifact_id
      from analysis_episode_contexts context
      join chapters chapter on chapter.id = context.chapter_id and chapter.book_id = context.book_id
      where context.workflow_id = $1
        and context.book_id = $2
        and chapter.chapter_index < $3
        and context.is_chapter_aggregate = true
        and context.status = 'active'
      order by chapter.chapter_index desc, context.window_sequence desc
      limit 1
    `,
    [input.workflowId, input.bookId, input.chapterIndex],
  );
  return previousChapter.rows[0] ? contextFromValue(previousChapter.rows[0].context) : undefined;
}

export async function insertWorkflowEpisodeContext(
  db: RevisionQueryable,
  input: {
    readonly workflowId: string;
    readonly bookId: string;
    readonly chapterId: string;
    readonly windowId: string;
    readonly windowSequence: number;
    readonly inputRevisionId: string;
    readonly artifactId: string;
    readonly context: ChapterLabelingPreviousContext;
    readonly isChapterAggregate: boolean;
  },
): Promise<void> {
  const id = persistentId128('analysis_episode_context', [
    input.workflowId,
    input.chapterId,
    String(input.windowSequence),
    input.artifactId,
  ]);
  const inserted = await db.query<{ id: string }>(
    `
      insert into analysis_episode_contexts (
        id, workflow_id, book_id, chapter_id, window_id, window_sequence,
        input_revision_id, artifact_id, context, is_chapter_aggregate,
        status, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', now(), now())
      on conflict (workflow_id, chapter_id, window_sequence) do nothing
      returning id
    `,
    [
      id,
      input.workflowId,
      input.bookId,
      input.chapterId,
      input.windowId,
      input.windowSequence,
      input.inputRevisionId,
      input.artifactId,
      JSON.stringify(input.context),
      input.isChapterAggregate,
    ],
  );
  if (inserted.rows[0]) return;
  const existing = await db.query<{ artifact_id: string }>(
    `
      select artifact_id
      from analysis_episode_contexts
      where workflow_id = $1 and chapter_id = $2 and window_sequence = $3
    `,
    [input.workflowId, input.chapterId, input.windowSequence],
  );
  if (existing.rows[0]?.artifact_id !== input.artifactId) {
    throw new Error(
      `Episode Context promotion conflict: ${input.workflowId}/${input.chapterId}/${input.windowSequence}`,
    );
  }
}
