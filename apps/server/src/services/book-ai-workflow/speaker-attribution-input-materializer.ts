import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type { SpeakerSpanType } from '@noveldesk/text-core/speaker-attribution';
import type { Chapter, LabeledSegment, Paragraph, UserCorrection } from '@noveldesk/contracts';
import type { CharacterGraph, ChapterLabelingPreviousContext } from '../../../../../src/providers/ai';
import type { CharacterGraphKnowledgeV2 } from '../../../../../src/providers/character-graph-v2';
import {
  materializeSpeakerAttributionInput,
  prepareSpeakerAttributionInputMaterialization,
  type MaterializedSpeakerAttributionPinnedPayloadV3,
} from '../../../../../src/providers/speaker-attribution/input-materializer';
import type { BookAIWorkflowLabelingWindow } from '../../../../../src/providers/book-ai-workflow-plan';
import {
  getHostedSpeakerSourceManifest,
  replaceHostedSpeakerAttributionChapterInventoryInTransaction,
} from '../speaker-attribution-store.js';
import {
  appendHostedTemporalAddressUseEvents,
  listHostedTemporalAddressUseEvents,
  listHostedTemporalRelationEdges,
  replaceHostedCharacterTemporalSnapshotsInTransaction,
} from '../temporal-character-memory-service.js';
import type { RevisionQueryable } from './analysis-input-repository.js';

interface CorrectedSegmentRow {
  id: string;
  paragraph_id: string;
  start_offset: number | string;
  end_offset: number | string;
  segment_type: LabeledSegment['type'];
  speaker_id: string;
}

const speakerSpanType: Readonly<Record<LabeledSegment['type'], SpeakerSpanType>> = {
  narration: 'narration',
  quoted_dialogue: 'dialogue',
  plain_dialogue: 'message',
  inner_monologue: 'inner_monologue',
  system_message: 'system',
  sfx: 'sfx',
  author_note: 'metadata',
  unknown: 'unknown',
};

async function loadLockedSpans(
  db: RevisionQueryable,
  input: {
    readonly bookId: string;
    readonly chapterId: string;
    readonly paragraphs: readonly Paragraph[];
  },
) {
  const paragraphIds = input.paragraphs.map((paragraph) => paragraph.id);
  if (paragraphIds.length === 0) return [];
  const result = await db.query<CorrectedSegmentRow>(
    `
      select id, paragraph_id, start_offset, end_offset, segment_type, speaker_id
      from labeled_segments
      where book_id = $1 and chapter_id = $2 and paragraph_id = any($3::text[])
        and is_user_corrected = true
      order by segment_index, id
    `,
    [input.bookId, input.chapterId, paragraphIds],
  );
  const paragraphById = new Map(input.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  return result.rows.flatMap((row) => {
    const text = paragraphById.get(row.paragraph_id);
    const startOffset = Number(row.start_offset);
    const endOffset = Number(row.end_offset);
    if (text === undefined || startOffset < 0 || endOffset <= startOffset || endOffset > text.length) return [];
    return [
      {
        paragraphId: row.paragraph_id,
        startOffset,
        endOffset,
        textHash: textIntegrityHash(text.slice(startOffset, endOffset)),
        type: speakerSpanType[row.segment_type] ?? 'unknown',
        speakerId: row.speaker_id,
        correctionId: row.id,
      },
    ];
  });
}

export async function materializeHostedSpeakerAttributionInput(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly normalizedTextHash: string;
    readonly graphRevision: string;
    readonly correctionCursor: string;
    readonly chapter: Chapter;
    readonly paragraphs: readonly Paragraph[];
    readonly allChapterParagraphs: readonly Paragraph[];
    readonly graph: CharacterGraph;
    readonly graphKnowledge: CharacterGraphKnowledgeV2;
    readonly previousEpisodeContext?: ChapterLabelingPreviousContext;
    readonly userCorrections: readonly UserCorrection[];
    readonly window: BookAIWorkflowLabelingWindow;
    readonly providerId: string;
    readonly modelId: string;
    readonly providerOptions: Readonly<Record<string, unknown>>;
    readonly coversFullChapter: boolean;
    readonly finalWindowForChapter: boolean;
  },
): Promise<MaterializedSpeakerAttributionPinnedPayloadV3> {
  const lockedSpans = await loadLockedSpans(db, {
    bookId: input.bookId,
    chapterId: input.chapter.id,
    paragraphs: input.allChapterParagraphs,
  });
  const prepared = prepareSpeakerAttributionInputMaterialization(
    {
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      normalizedTextHash: input.normalizedTextHash,
      graphRevision: input.graphRevision,
      correctionCursor: input.correctionCursor,
      chapter: input.chapter,
      paragraphs: input.paragraphs,
      allChapterParagraphs: input.allChapterParagraphs,
      characters: input.graph.characters,
      graphKnowledge: input.graphKnowledge,
      previousEpisodeContext: input.previousEpisodeContext,
      userCorrections: input.userCorrections,
      providerId: input.providerId,
      modelId: input.modelId,
      providerOptions: input.providerOptions,
      coversFullChapter: input.coversFullChapter,
      finalWindowForChapter: input.finalWindowForChapter,
    },
    lockedSpans,
  );
  await replaceHostedSpeakerAttributionChapterInventoryInTransaction(db, input.userId, prepared.chapterBuild.inventory);
  await appendHostedTemporalAddressUseEvents(db, input.userId, prepared.chapterBuild.inventory.addressEvents);
  const [storedAddressEvents, temporalRelationEdges, sourceManifest] = await Promise.all([
    listHostedTemporalAddressUseEvents(db, input.userId, input.contentRevisionId, { activeOnly: true }),
    listHostedTemporalRelationEdges(db, input.userId, input.contentRevisionId, { activeOnly: true }),
    getHostedSpeakerSourceManifest(db, input.userId, input.contentRevisionId),
  ]);
  const materialized = materializeSpeakerAttributionInput(prepared, {
    addressEvents: storedAddressEvents,
    temporalRelationEdges,
    sourceManifestFingerprint: sourceManifest?.fingerprint,
  });
  await replaceHostedCharacterTemporalSnapshotsInTransaction(db, input.userId, {
    chapterId: input.chapter.id,
    bookId: input.bookId,
    contentRevisionId: input.contentRevisionId,
    snapshots: materialized.snapshots,
  });
  return materialized.payload;
}
