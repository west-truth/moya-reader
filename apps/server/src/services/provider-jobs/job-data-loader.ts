import pg from 'pg';
import type { Chapter, Character, LabeledSegment, Paragraph, UserCorrection, VoiceProfile } from '@noveldesk/contracts';
import { textIntegrityHash } from '@noveldesk/text-core/hash';
import type {
  CharacterBundleChapterInput,
  CharacterGraph,
  CharacterRelation,
  ChapterLabelingPreviousContext,
} from '../../../../../src/providers/ai';
import type { ProviderJobRow, TTSSegmentTextRow } from './contracts.js';
import { recordValue, stringArrayValue } from './job-progress.js';
import type { TTSRenderSpec } from '../../../../../src/providers/tts-render-spec';

export interface ProviderJobQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

interface ChapterRow {
  id: string;
  book_id: string;
  chapter_index: number;
  title: string;
  text_hash: string;
  raw_start_offset: number;
  raw_end_offset: number;
  character_count: number;
  paragraph_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ParagraphSearchRow {
  paragraph_id: string;
  book_id: string;
  chapter_id: string;
  paragraph_index: number;
  text: string;
  paragraph: Partial<Paragraph> | null;
}

interface CharacterRow {
  id: string;
  book_id: string;
  canonical_name: string;
  aliases: unknown;
  color: string;
  description: string | null;
  confidence: number | string;
  is_user_confirmed: boolean;
}

interface CharacterRelationRow {
  id: string;
  book_id: string;
  source_character_id: string;
  target_character_id: string;
  relation_label: string;
  terms_used_by_source: unknown;
  terms_used_by_target: unknown;
  confidence: number | string;
  evidence: unknown;
}

interface ChapterContextRow {
  chapter_id: string;
  summary: string;
  active_character_ids: unknown;
  unresolved: unknown;
}

interface UserCorrectionRow {
  id: string;
  book_id: string;
  chapter_id: string | null;
  paragraph_id: string | null;
  segment_id: string | null;
  correction_type: string;
  before_json: unknown;
  after_json: unknown;
  apply_scope: string;
  created_at: Date | string;
}

interface LabeledSegmentRow {
  id: string;
  book_id: string;
  chapter_id: string;
  paragraph_id: string;
  segment_index: number | string;
  start_offset: number | string;
  end_offset: number | string;
  segment_text_hash: string;
  segment_type: string;
  speaker_id: string;
  candidate_speakers: unknown;
  listener_ids: unknown;
  emotion: string;
  prosody_intent: unknown;
  confidence: number | string;
  evidence: string | null;
  voice_profile_id: string | null;
  is_user_corrected: boolean;
}

interface VoiceProfileRow {
  id: string;
  book_id: string;
  character_id: string | null;
  role: string;
  provider_id: string;
  provider_voice_id: string;
  provider_model: string | null;
  label: string;
  language: string | null;
  tone: string | null;
  speed: number | string;
  pitch: number | string | null;
  emotion_policy: string | null;
  provider_options: unknown;
  is_user_selected: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function paragraphFromRow(row: ParagraphSearchRow): Paragraph {
  const paragraph = row.paragraph && typeof row.paragraph === 'object' ? row.paragraph : {};
  return {
    id: String(paragraph.id ?? row.paragraph_id),
    novelId: String(paragraph.novelId ?? row.book_id),
    chapterId: String(paragraph.chapterId ?? row.chapter_id),
    index: numberValue(paragraph.index, numberValue(row.paragraph_index)),
    text: String(paragraph.text ?? row.text),
    startOffsetInChapter: numberValue(paragraph.startOffsetInChapter),
    endOffsetInChapter: numberValue(paragraph.endOffsetInChapter, String(paragraph.text ?? row.text).length),
    textHash: String(paragraph.textHash ?? textIntegrityHash(String(paragraph.text ?? row.text))),
  };
}

function jsonString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function characterFromRow(row: CharacterRow): Character {
  return {
    id: row.id,
    novelId: row.book_id,
    canonicalName: row.canonical_name,
    aliases: stringArrayValue(row.aliases),
    color: row.color,
    description: row.description ?? undefined,
    confidence: numberValue(row.confidence),
    isUserConfirmed: Boolean(row.is_user_confirmed),
  };
}

function relationFromRow(row: CharacterRelationRow): CharacterRelation {
  return {
    id: row.id,
    novelId: row.book_id,
    sourceCharacterId: row.source_character_id,
    targetCharacterId: row.target_character_id,
    relationLabel: row.relation_label,
    termsUsedBySource: stringArrayValue(row.terms_used_by_source),
    termsUsedByTarget: stringArrayValue(row.terms_used_by_target),
    confidence: numberValue(row.confidence),
    evidence: stringArrayValue(row.evidence),
  };
}

function correctionFromRow(row: UserCorrectionRow, fallbackChapterId: string | undefined): UserCorrection {
  return {
    id: row.id,
    novelId: row.book_id,
    chapterId: row.chapter_id ?? fallbackChapterId ?? '',
    paragraphId: row.paragraph_id ?? undefined,
    segmentId: row.segment_id ?? undefined,
    correctionType: row.correction_type as UserCorrection['correctionType'],
    beforeJson: jsonString(row.before_json),
    afterJson: jsonString(row.after_json) ?? '{}',
    applyScope: row.apply_scope as UserCorrection['applyScope'],
    createdAt: iso(row.created_at),
  };
}

function segmentFromRow(row: LabeledSegmentRow): LabeledSegment {
  return {
    id: row.id,
    novelId: row.book_id,
    chapterId: row.chapter_id,
    paragraphId: row.paragraph_id,
    segmentIndex: numberValue(row.segment_index),
    startOffset: numberValue(row.start_offset),
    endOffset: numberValue(row.end_offset),
    segmentTextHash: row.segment_text_hash,
    type: row.segment_type as LabeledSegment['type'],
    speakerId: row.speaker_id,
    candidateSpeakers: stringArrayValue(row.candidate_speakers),
    listenerIds: stringArrayValue(row.listener_ids),
    emotion: row.emotion,
    prosodyIntent:
      row.prosody_intent && typeof row.prosody_intent === 'object' && !Array.isArray(row.prosody_intent)
        ? {
            pace:
              typeof (row.prosody_intent as Record<string, unknown>).pace === 'string'
                ? String((row.prosody_intent as Record<string, unknown>).pace)
                : undefined,
            intensity:
              typeof (row.prosody_intent as Record<string, unknown>).intensity === 'string'
                ? String((row.prosody_intent as Record<string, unknown>).intensity)
                : undefined,
            delivery:
              typeof (row.prosody_intent as Record<string, unknown>).delivery === 'string'
                ? String((row.prosody_intent as Record<string, unknown>).delivery)
                : undefined,
          }
        : undefined,
    confidence: numberValue(row.confidence),
    evidence: row.evidence ?? undefined,
    voiceProfileId: row.voice_profile_id ?? undefined,
    isUserCorrected: Boolean(row.is_user_corrected),
  };
}

function voiceProfileFromRow(row: VoiceProfileRow): VoiceProfile {
  const providerOptions =
    row.provider_options && typeof row.provider_options === 'object' && !Array.isArray(row.provider_options)
      ? (row.provider_options as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    novelId: row.book_id,
    characterId: row.character_id ?? undefined,
    role: row.role as VoiceProfile['role'],
    providerId: row.provider_id,
    providerVoiceId: row.provider_voice_id,
    providerModel: row.provider_model ?? undefined,
    label: row.label,
    language: row.language ?? undefined,
    tone: row.tone ?? undefined,
    speed: numberValue(row.speed, 1),
    pitch: row.pitch === null || row.pitch === undefined ? undefined : numberValue(row.pitch),
    emotionPolicy: row.emotion_policy ?? undefined,
    providerOptions,
    isUserSelected: Boolean(row.is_user_selected),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function chapterFromRow(row: ChapterRow): Chapter {
  return {
    id: row.id,
    novelId: row.book_id,
    index: Number(row.chapter_index),
    title: row.title,
    normalizedText: '',
    textHash: row.text_hash,
    rawStartOffset: Number(row.raw_start_offset),
    rawEndOffset: Number(row.raw_end_offset),
    characterCount: Number(row.character_count),
    paragraphCount: Number(row.paragraph_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function loadChapter(pool: ProviderJobQueryable, job: ProviderJobRow): Promise<Chapter> {
  if (!job.chapter_id) throw new Error(`Provider job ${job.id} does not target a chapter`);
  const result = await pool.query<ChapterRow>(
    `
      select c.id, c.book_id, c.chapter_index, c.title, c.text_hash, c.raw_start_offset,
             c.raw_end_offset, c.character_count, c.paragraph_count, c.created_at, c.updated_at
      from chapters c
      join library_books b on b.id = c.book_id
      where c.id = $1 and c.book_id = $2 and b.user_id = $3
    `,
    [job.chapter_id, job.book_id, job.user_id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Chapter not found for provider job: ${job.chapter_id}`);
  return chapterFromRow(row);
}

export function labelingWindowParagraphIdsFromJob(job: ProviderJobRow): string[] {
  const sourceContext = recordValue(recordValue(job.progress)?.sourceContext);
  return stringArrayValue(sourceContext?.paragraphIds);
}

export function labelingWindowCoversFullChapter(job: ProviderJobRow): boolean {
  const sourceContext = recordValue(recordValue(job.progress)?.sourceContext);
  return sourceContext?.coversFullChapter === true;
}

export async function loadParagraphs(
  pool: ProviderJobQueryable,
  chapterId: string,
  paragraphIds: readonly string[] = [],
): Promise<Paragraph[]> {
  if (paragraphIds.length > 0) {
    const result = await pool.query<ParagraphSearchRow>(
      `
        select paragraph_id, book_id, chapter_id, paragraph_index, text, paragraph
        from paragraph_search
        where chapter_id = $1
          and paragraph_id = any($2::text[])
        order by paragraph_index asc
      `,
      [chapterId, paragraphIds],
    );
    if (result.rows.length !== paragraphIds.length) {
      const found = new Set(result.rows.map((row) => row.paragraph_id));
      const missing = paragraphIds.filter((id) => !found.has(id));
      throw new Error(`Labeling window references missing paragraphs: ${missing.join(', ')}`);
    }
    return result.rows.map(paragraphFromRow);
  }
  const result = await pool.query<ParagraphSearchRow>(
    `
      select paragraph_id, book_id, chapter_id, paragraph_index, text, paragraph
      from paragraph_search
      where chapter_id = $1
      order by paragraph_index asc
    `,
    [chapterId],
  );
  return result.rows.map(paragraphFromRow);
}

export async function loadParagraphContextHalo(
  pool: ProviderJobQueryable,
  chapterId: string,
  startParagraphIndex: number,
  endParagraphIndex: number,
  radius: number,
): Promise<Paragraph[]> {
  if (!Number.isSafeInteger(radius) || radius <= 0) return [];
  const result = await pool.query<ParagraphSearchRow>(
    `
      select paragraph_id, book_id, chapter_id, paragraph_index, text, paragraph
      from paragraph_search
      where chapter_id = $1
        and paragraph_index between $2 and $3
        and (paragraph_index < $4 or paragraph_index > $5)
      order by paragraph_index asc
    `,
    [
      chapterId,
      Math.max(0, startParagraphIndex - radius),
      endParagraphIndex + radius,
      startParagraphIndex,
      endParagraphIndex,
    ],
  );
  return result.rows.map(paragraphFromRow);
}

export async function loadBundleChapters(
  pool: ProviderJobQueryable,
  job: ProviderJobRow,
  chapterIds: string[],
): Promise<CharacterBundleChapterInput[]> {
  if (chapterIds.length === 0) throw new Error('character_bundle_analysis requires source chapter ids');
  const result = await pool.query<ChapterRow>(
    `
      select c.id, c.book_id, c.chapter_index, c.title, c.text_hash, c.raw_start_offset,
             c.raw_end_offset, c.character_count, c.paragraph_count, c.created_at, c.updated_at
      from chapters c
      join library_books b on b.id = c.book_id
      where c.book_id = $1
        and b.user_id = $2
        and c.id = any($3::text[])
      order by c.chapter_index asc
    `,
    [job.book_id, job.user_id, chapterIds],
  );
  const foundIds = new Set(result.rows.map((row) => row.id));
  const missing = chapterIds.filter((chapterId) => !foundIds.has(chapterId));
  if (missing.length) throw new Error(`Bundle chapters not found: ${missing.join(', ')}`);
  const chapters = result.rows.map(chapterFromRow);
  return await Promise.all(
    chapters.map(async (chapter) => ({
      chapter,
      paragraphs: await loadParagraphs(pool, chapter.id),
    })),
  );
}

async function loadGraphCharacters(pool: ProviderJobQueryable, job: ProviderJobRow): Promise<Character[]> {
  const result = await pool.query<CharacterRow>(
    `
      select id, book_id, canonical_name, aliases, color, description, confidence, is_user_confirmed
      from characters
      where book_id = $1 and user_id = $2
      order by is_user_confirmed desc, confidence desc, canonical_name asc
    `,
    [job.book_id, job.user_id],
  );
  return result.rows.map(characterFromRow);
}

export async function loadCharacterGraph(pool: ProviderJobQueryable, job: ProviderJobRow): Promise<CharacterGraph> {
  const [characters, relations] = await Promise.all([
    loadGraphCharacters(pool, job),
    pool.query<CharacterRelationRow>(
      `
        select id, book_id, source_character_id, target_character_id, relation_label,
               terms_used_by_source, terms_used_by_target, confidence, evidence
        from character_relations
        where book_id = $1
        order by id asc
      `,
      [job.book_id],
    ),
  ]);
  return {
    novelId: job.book_id,
    characters,
    relations: relations.rows.map(relationFromRow),
  };
}

export async function loadPreviousEpisodeContext(
  pool: ProviderJobQueryable,
  job: ProviderJobRow,
  chapter: Chapter,
): Promise<ChapterLabelingPreviousContext | undefined> {
  const result = await pool.query<ChapterContextRow>(
    `
      select cc.chapter_id, cc.summary, cc.active_character_ids, cc.unresolved
      from chapter_contexts cc
      join chapters c on c.id = cc.chapter_id and c.book_id = cc.book_id
      where cc.book_id = $1 and c.chapter_index < $2
      order by c.chapter_index desc
      limit 1
    `,
    [job.book_id, chapter.index],
  );
  const row = result.rows[0];
  return row
    ? {
        chapterId: row.chapter_id,
        summary: row.summary,
        activeCharacterIds: stringArrayValue(row.active_character_ids),
        unresolved: stringArrayValue(row.unresolved),
      }
    : undefined;
}

export async function loadRecentCorrections(
  pool: ProviderJobQueryable,
  job: ProviderJobRow,
): Promise<UserCorrection[]> {
  const result = await pool.query<UserCorrectionRow>(
    `
      select id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
             before_json, after_json, apply_scope, created_at
      from user_corrections
      where book_id = $1
        and (
          chapter_id is null
          or chapter_id = $2
          or apply_scope in ('future_pattern', 'global')
        )
      order by created_at desc
      limit 30
    `,
    [job.book_id, job.chapter_id],
  );
  return result.rows.map((row) => correctionFromRow(row, job.chapter_id ?? undefined));
}

export async function loadStoredSegments(pool: ProviderJobQueryable, job: ProviderJobRow): Promise<LabeledSegment[]> {
  if (!job.chapter_id) throw new Error(`Provider job ${job.id} does not target a chapter`);
  const result = await pool.query<LabeledSegmentRow>(
    `
      select id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
             segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
             emotion, prosody_intent, confidence, evidence, voice_profile_id, is_user_corrected
      from labeled_segments
      where book_id = $1 and chapter_id = $2
      order by segment_index asc, id asc
    `,
    [job.book_id, job.chapter_id],
  );
  return result.rows.map(segmentFromRow);
}

export async function loadVoiceProfile(
  pool: ProviderJobQueryable,
  job: ProviderJobRow,
  voiceProfileId: string,
): Promise<VoiceProfile> {
  const result = await pool.query<VoiceProfileRow>(
    `
      select id, book_id, character_id, role, provider_id, provider_voice_id, provider_model,
             label, language, tone, speed, pitch, emotion_policy, provider_options,
             is_user_selected, created_at, updated_at
      from voice_profiles
      where id = $1 and book_id = $2
    `,
    [voiceProfileId, job.book_id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Voice profile not found for TTS job: ${voiceProfileId}`);
  return voiceProfileFromRow(row);
}

export async function loadTTSSegmentTextRows(
  pool: ProviderJobQueryable,
  job: ProviderJobRow,
  segmentIds: string[],
  renderSpec?: TTSRenderSpec,
): Promise<TTSSegmentTextRow[]> {
  if (!job.chapter_id) throw new Error(`Provider job ${job.id} does not target a chapter`);
  const result = await pool.query<TTSSegmentTextRow>(
    `
      select s.id, s.paragraph_id, s.segment_index, s.start_offset, s.end_offset,
             s.segment_text_hash, s.speaker_id, s.emotion, ps.text
      from labeled_segments s
      join paragraph_search ps
        on ps.book_id = s.book_id
       and ps.chapter_id = s.chapter_id
       and ps.paragraph_id = s.paragraph_id
      where s.book_id = $1
        and s.chapter_id = $2
        and s.id = any($3::text[])
    `,
    [job.book_id, job.chapter_id, segmentIds],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const missing = segmentIds.filter((segmentId) => !byId.has(segmentId));
  if (missing.length && renderSpec) {
    const anchorById = new Map(renderSpec.segmentAnchors.map((anchor) => [anchor.segmentId, anchor]));
    const documentBlocks = await pool.query<{
      id: string;
      block_order: number;
      text: string;
    }>(
      `select b.id, b.block_order, b.text
       from document_text_blocks b
       join document_text_revisions r on r.id = b.revision_id and r.status = 'ready'
       join chapters c on c.id = $2 and c.book_id = b.book_id and c.chapter_index = b.page_index + 1
       where b.book_id = $1 and b.id = any($3::text[])`,
      [job.book_id, job.chapter_id, missing],
    );
    for (const block of documentBlocks.rows) {
      const anchor = anchorById.get(block.id);
      const startOffset = anchor?.startOffset;
      const endOffset = anchor?.endOffset;
      if (
        !anchor ||
        anchor.paragraphId !== block.id ||
        !Number.isInteger(startOffset) ||
        !Number.isInteger(endOffset) ||
        Number(startOffset) < 0 ||
        Number(endOffset) <= Number(startOffset) ||
        Number(endOffset) > block.text.length
      ) {
        continue;
      }
      const text = block.text.slice(Number(startOffset), Number(endOffset));
      byId.set(block.id, {
        id: block.id,
        paragraph_id: block.id,
        segment_index: block.block_order,
        start_offset: Number(startOffset),
        end_offset: Number(endOffset),
        segment_text_hash: anchor.segmentTextHash ?? textIntegrityHash(text),
        speaker_id: renderSpec.speakerId,
        emotion: renderSpec.emotion ?? 'neutral',
        text: block.text,
      });
    }
  }
  const ordered = segmentIds.map((segmentId) => byId.get(segmentId));
  const unresolved = segmentIds.filter((segmentId, index) => !ordered[index]);
  if (unresolved.length) throw new Error(`TTS segments not found: ${unresolved.join(', ')}`);
  return ordered as TTSSegmentTextRow[];
}
