import type pg from 'pg';
import { hashSync, stableId } from '@noveldesk/text-core/legacy-hash';
import { integrityHash, persistentId128 } from '@noveldesk/text-core/hash';
import { parseNovelFile } from '@noveldesk/text-core/parser';
import type { BookSourceLoader, SourceBookObject } from './contracts.js';
import { idV2IdentityFactory } from './identity-factory-adapter.js';

const FIXED_TIME = '2026-01-01T00:00:00.000Z';

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function legacyId(namespace: string, seed: string): string {
  return stableId(namespace, seed);
}

export class MemoryBookSourceLoader implements BookSourceLoader {
  private readonly bodies = new Map<string, Buffer>();

  add(objectId: string, body: Buffer): void {
    this.bodies.set(objectId, body);
  }

  async load(object: SourceBookObject): Promise<Buffer> {
    const body = this.bodies.get(object.id);
    if (!body) throw new Error('fixture_source_missing');
    return body;
  }
}

export interface LegacyBookIds {
  readonly book: string;
  readonly object: string;
  readonly chapter: string;
  readonly page: string;
  readonly paragraphs: readonly string[];
  readonly paragraphSearch: readonly string[];
  readonly bookmark?: string;
  readonly highlight?: string;
  readonly note?: string;
  readonly character?: string;
  readonly characterAlias?: string;
  readonly characterRelation?: string;
  readonly analysisRun?: string;
  readonly chapterContext?: string;
  readonly voiceProfile?: string;
  readonly segment?: string;
  readonly correction?: string;
  readonly workflow?: string;
  readonly providerJob?: string;
  readonly workflowJob?: string;
  readonly workflowBundle?: string;
  readonly workflowWindow?: string;
  readonly syncEvent?: string;
  readonly ttsCache?: string;
  readonly upload?: string;
  readonly importJob?: string;
  readonly attempt?: string;
  readonly outbox?: string;
}

export interface LegacyBookFixture {
  readonly userId: string;
  readonly fileName: string;
  readonly body: Buffer;
  readonly normalizedTextHash: string;
  readonly canonicalNormalizedTextHash: string;
  readonly canonicalBookId: string;
  readonly canonicalObjectId: string;
  readonly ids: LegacyBookIds;
  readonly paragraphText: string;
  readonly paragraphTextHash: string;
}

export interface SeedLegacyBookOptions {
  readonly includeDependents?: boolean;
  readonly activeProviderJob?: boolean;
}

export async function seedLegacyBook(
  pool: pg.Pool,
  loader: MemoryBookSourceLoader,
  userId: string,
  suffix: string,
  options: SeedLegacyBookOptions = {},
): Promise<LegacyBookFixture> {
  const fileName = `legacy-${suffix}.txt`;
  const body = Buffer.from(`Opening ${suffix}\n\nFirst paragraph ${suffix}.\n\nSecond paragraph ${suffix}.`, 'utf8');
  const parsed = await parseNovelFile(fileName, arrayBuffer(body), 'utf-8', { chapterSplitMode: 'single' });
  const chapter = parsed.chapters[0];
  const paragraphs = parsed.paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id);
  const rawTextHash = integrityHash(body).slice('sha256:'.length);
  const normalizedTextHash = hashSync(parsed.novel.normalizedText);
  const canonicalNormalizedTextHash = integrityHash(parsed.novel.normalizedText);
  const sourceBookId = legacyId('novel', `${fileName}:${normalizedTextHash}`);
  const sourceObjectId = legacyId('object', rawTextHash);
  const sourceChapterId = legacyId('chapter', `${sourceBookId}:1:${chapter.title}`);
  const sourceParagraphIds = paragraphs.map((paragraph, index) =>
    legacyId('paragraph', `${sourceBookId}:${sourceChapterId}:${index}:${paragraph.text}`),
  );
  const sourcePageId = legacyId('page', `${sourceBookId}:${sourceChapterId}:0`);
  const sourceSearchIds = sourceParagraphIds.map((paragraphId) =>
    legacyId('paragraph_search', `${sourceBookId}:${sourceChapterId}:${paragraphId}`),
  );
  const canonicalBookId = idV2IdentityFactory.book(fileName, canonicalNormalizedTextHash);
  const canonicalObjectId = idV2IdentityFactory.object(integrityHash(body));
  const legacyParagraphs = paragraphs.map((paragraph, index) => ({
    ...paragraph,
    id: sourceParagraphIds[index],
    novelId: sourceBookId,
    chapterId: sourceChapterId,
    textHash: hashSync(paragraph.text),
  }));
  const pageHashInput = JSON.stringify(legacyParagraphs.map((paragraph) => paragraph.textHash));
  const ids: LegacyBookIds = {
    book: sourceBookId,
    object: sourceObjectId,
    chapter: sourceChapterId,
    page: sourcePageId,
    paragraphs: sourceParagraphIds,
    paragraphSearch: sourceSearchIds,
  };

  loader.add(sourceObjectId, body);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into users (id, email, display_name)
       values ($1, $2, $3) on conflict (id) do nothing`,
      [userId, `${userId}@example.test`, `Reader ${suffix}`],
    );
    await client.query(
      `insert into book_objects (
         id, raw_text_hash, storage_key, file_name, content_type, size_bytes, id_contract, hash_contract
       ) values ($1, $2, $3, $4, 'text/plain', $5, 'v1-legacy', 'v1-legacy')`,
      [sourceObjectId, rawTextHash, `books/${suffix}`, fileName, body.byteLength],
    );
    await client.query(
      `insert into library_books (
         id, user_id, object_id, title, source_file_name, source_encoding,
         normalized_text_hash, total_chapters, total_characters, total_paragraphs,
         created_at, updated_at, id_contract, hash_contract
       ) values ($1, $2, $3, $4, $5, 'utf-8', $6, 1, $7, $8, $9, $9, 'v1-legacy', 'v1-legacy')`,
      [
        sourceBookId,
        userId,
        sourceObjectId,
        parsed.novel.title,
        fileName,
        normalizedTextHash,
        parsed.novel.totalCharacters,
        paragraphs.length,
        FIXED_TIME,
      ],
    );
    await client.query(
      `insert into chapters (
         id, book_id, chapter_index, title, text_hash, raw_start_offset, raw_end_offset,
         character_count, paragraph_count, created_at, updated_at
       ) values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        sourceChapterId,
        sourceBookId,
        chapter.title,
        hashSync(chapter.normalizedText),
        chapter.rawStartOffset,
        chapter.rawEndOffset,
        chapter.characterCount,
        chapter.paragraphCount,
        FIXED_TIME,
      ],
    );
    await client.query(
      `insert into paragraph_pages (
         id, book_id, chapter_id, page_index, start_paragraph_index,
         end_paragraph_index, paragraphs, text_hash, created_at
       ) values ($1, $2, $3, 0, $4, $5, $6::jsonb, $7, $8)`,
      [
        sourcePageId,
        sourceBookId,
        sourceChapterId,
        legacyParagraphs[0].index,
        legacyParagraphs.at(-1)?.index ?? 0,
        JSON.stringify(legacyParagraphs),
        hashSync(pageHashInput),
        FIXED_TIME,
      ],
    );
    for (const [index, paragraph] of legacyParagraphs.entries()) {
      await client.query(
        `insert into paragraph_search (
           id, paragraph_id, book_id, chapter_id, page_index, paragraph_index,
           text, text_lower, paragraph, updated_at
         ) values ($1, $2, $3, $4, 0, $5, $6, $7, $8::jsonb, $9)`,
        [
          sourceSearchIds[index],
          paragraph.id,
          sourceBookId,
          sourceChapterId,
          paragraph.index,
          paragraph.text,
          paragraph.text.toLowerCase(),
          JSON.stringify(paragraph),
          FIXED_TIME,
        ],
      );
    }

    if (options.includeDependents) {
      Object.assign(ids, await seedLegacyDependents(client, userId, suffix, ids, legacyParagraphs));
    } else if (options.activeProviderJob) {
      const providerJob = legacyId('provider_job', `${sourceBookId}:active`);
      await client.query(
        `insert into provider_jobs (
           id, user_id, book_id, chapter_id, job_type, provider_id, input_hash, status, stage
         ) values ($1, $2, $3, $4, 'chapter_segment_labeling', 'mock', $5, 'queued', 'queued')`,
        [providerJob, userId, sourceBookId, sourceChapterId, hashSync('active-job')],
      );
      Object.assign(ids, { providerJob });
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return {
    userId,
    fileName,
    body,
    normalizedTextHash,
    canonicalNormalizedTextHash,
    canonicalBookId,
    canonicalObjectId,
    ids,
    paragraphText: legacyParagraphs[0].text,
    paragraphTextHash: legacyParagraphs[0].textHash,
  };
}

async function seedLegacyDependents(
  client: pg.PoolClient,
  userId: string,
  suffix: string,
  coreIds: LegacyBookIds,
  paragraphs: readonly Record<string, unknown>[],
): Promise<Partial<LegacyBookIds>> {
  const firstParagraphId = coreIds.paragraphs[0];
  const firstParagraph = paragraphs[0];
  const paragraphText = String(firstParagraph.text);
  const paragraphHash = String(firstParagraph.textHash);
  const createdAt = FIXED_TIME;
  const ids = {
    bookmark: legacyId('bookmark', suffix),
    highlight: legacyId('highlight', suffix),
    note: legacyId('note', suffix),
    character: legacyId('character', `hero:${suffix}`),
    characterAlias: legacyId('character_alias', `hero:${suffix}`),
    characterRelation: legacyId('character_relation', `hero:${suffix}`),
    analysisRun: legacyId('analysis_run', suffix),
    chapterContext: legacyId('chapter_context', suffix),
    voiceProfile: legacyId('voice_profile', suffix),
    segment: legacyId('segment', suffix),
    correction: legacyId('correction', suffix),
    workflow: legacyId('book_ai_workflow', suffix),
    providerJob: legacyId('provider_job', suffix),
    workflowJob: legacyId('book_ai_workflow_job', suffix),
    workflowBundle: legacyId('book_ai_bundle', suffix),
    workflowWindow: legacyId('book_ai_label_window', suffix),
    syncEvent: legacyId('sync_event', suffix),
    ttsCache: legacyId('tts_audio_cache', suffix),
    upload: `upload-${suffix}`,
    importJob: `import-${suffix}`,
    attempt: persistentId128('provider_job_attempt', [suffix, '1']),
    outbox: persistentId128('provider_job_outbox', [suffix, '1']),
  };

  await client.query(
    `insert into reading_positions (
       book_id, user_id, chapter_id, paragraph_id, paragraph_index,
       offset_in_paragraph, chapter_progress, device_id, updated_at
     ) values ($1, $2, $3, $4, 1, 2, 0.5, 'device-legacy', $5)`,
    [coreIds.book, userId, coreIds.chapter, firstParagraphId, createdAt],
  );
  await client.query(
    `insert into bookmarks (
       id, book_id, user_id, chapter_id, paragraph_id, label, progress, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, 'bookmark', 0.5, $6, $6)`,
    [ids.bookmark, coreIds.book, userId, coreIds.chapter, firstParagraphId, createdAt],
  );
  await client.query(
    `insert into highlights (
       id, book_id, user_id, chapter_id, paragraph_id, quote, color, progress, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, 'yellow', 0.5, $7, $7)`,
    [ids.highlight, coreIds.book, userId, coreIds.chapter, firstParagraphId, paragraphText, createdAt],
  );
  await client.query(
    `insert into notes (
       id, book_id, user_id, chapter_id, paragraph_id, quote, body, progress, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, 'note', 0.5, $7, $7)`,
    [ids.note, coreIds.book, userId, coreIds.chapter, firstParagraphId, paragraphText, createdAt],
  );
  await client.query(
    `insert into upload_sessions (
       id, user_id, file_name, size_bytes, content_type, encoding, chapter_split_mode,
       client_hash_hint, client_book_id, status, total_chunks, created_at, updated_at
     ) values ($1, $2, $3, 10, 'text/plain', 'utf-8', 'single', $4, $5, 'completed', 1, $6, $6)`,
    [ids.upload, userId, `legacy-${suffix}.txt`, hashSync(`normalized:${suffix}`), coreIds.book, createdAt],
  );
  await client.query(
    `insert into import_jobs (
       id, user_id, upload_id, status, stage, book_id, created_at, updated_at
     ) values ($1, $2, $3, 'succeeded', 'completed', $4, $5, $5)`,
    [ids.importJob, userId, ids.upload, coreIds.book, createdAt],
  );
  await client.query(
    `insert into characters (
       id, book_id, user_id, canonical_name, aliases, color, description,
       confidence, created_at, updated_at
     ) values ($1, $2, $3, 'Hero', $4::jsonb, '#123456', 'hero', 0.9, $5, $5)`,
    [ids.character, coreIds.book, userId, JSON.stringify([ids.character]), createdAt],
  );
  await client.query(
    `insert into character_aliases (
       id, book_id, character_id, alias, evidence, created_at, updated_at
     ) values ($1, $2, $3, 'Hero alias', $4::jsonb, $5, $5)`,
    [ids.characterAlias, coreIds.book, ids.character, JSON.stringify({ characterId: ids.character }), createdAt],
  );
  await client.query(
    `insert into character_relations (
       id, book_id, source_character_id, target_character_id, relation_label,
       terms_used_by_source, terms_used_by_target, evidence, confidence, created_at, updated_at
     ) values ($1, $2, $3, $3, 'self', $4::jsonb, $4::jsonb, $5::jsonb, 1, $6, $6)`,
    [
      ids.characterRelation,
      coreIds.book,
      ids.character,
      JSON.stringify([ids.character]),
      JSON.stringify({ sourceCharacterId: ids.character, targetCharacterId: ids.character }),
      createdAt,
    ],
  );

  const bundleFingerprint = hashSync(`bundle:${suffix}`);
  const windowFingerprint = hashSync(`window:${paragraphHash}`);
  const plan = {
    novelId: coreIds.book,
    bundleWindows: [
      {
        id: ids.workflowBundle,
        sequence: 0,
        startChapterIndex: 0,
        endChapterIndex: 0,
        chapterIds: [coreIds.chapter],
        textHashFingerprint: bundleFingerprint,
      },
    ],
    labelingWindows: [
      {
        id: ids.workflowWindow,
        sequence: 0,
        chapterId: coreIds.chapter,
        paragraphIds: [firstParagraphId],
        startParagraphIndex: 0,
        endParagraphIndex: 0,
        textHashFingerprint: windowFingerprint,
      },
    ],
  };
  await client.query(
    `insert into book_ai_workflows (
       id, user_id, book_id, workflow_type, provider_id, model_id, plan_hash,
       plan, status, stage, progress, created_at, updated_at, started_at, finished_at
     ) values ($1, $2, $3, 'book_ai_tts', 'mock', 'mock-model', $4,
       $5::jsonb, 'ready', 'ready_for_tts', $6::jsonb, $7, $7, $7, $7)`,
    [
      ids.workflow,
      userId,
      coreIds.book,
      hashSync(JSON.stringify(plan)),
      JSON.stringify(plan),
      JSON.stringify({ workflowId: ids.workflow, planItemId: ids.workflowWindow }),
      createdAt,
    ],
  );
  const providerProgress = {
    bookId: coreIds.book,
    chapterId: coreIds.chapter,
    paragraphIds: [firstParagraphId],
    characterId: ids.character,
    workflowId: ids.workflow,
    planItemId: ids.workflowWindow,
    textHash: paragraphHash,
  };
  await client.query(
    `insert into provider_jobs (
       id, user_id, book_id, chapter_id, job_type, provider_id, model_id,
       input_hash, status, stage, progress, created_at, updated_at, started_at, finished_at
     ) values ($1, $2, $3, $4, 'chapter_segment_labeling', 'mock', 'mock-model',
       $5, 'succeeded', 'completed', $6::jsonb, $7, $7, $7, $7)`,
    [
      ids.providerJob,
      userId,
      coreIds.book,
      coreIds.chapter,
      hashSync(JSON.stringify(providerProgress)),
      JSON.stringify(providerProgress),
      createdAt,
    ],
  );
  await client.query(
    `insert into provider_job_attempts (
       id, provider_job_id, attempt_number, bullmq_job_id, status, stage,
       progress, created_at, updated_at, started_at, finished_at
     ) values ($1, $2, 1, $3, 'succeeded', 'completed', $4::jsonb, $5, $5, $5, $5)`,
    [ids.attempt, ids.providerJob, `bullmq-${suffix}`, JSON.stringify(providerProgress), createdAt],
  );
  await client.query(
    `insert into provider_job_outbox (
       id, provider_job_id, attempt_id, bullmq_job_id, status,
       created_at, updated_at, published_at
     ) values ($1, $2, $3, $4, 'published', $5, $5, $5)`,
    [ids.outbox, ids.providerJob, ids.attempt, `bullmq-${suffix}`, createdAt],
  );
  await client.query('update provider_jobs set current_attempt_id = $2, attempt_count = 1 where id = $1', [
    ids.providerJob,
    ids.attempt,
  ]);
  await client.query(
    `insert into analysis_runs (
       id, book_id, chapter_id, run_type, provider_id, model_id,
       input_hash, output_hash, status, metadata, started_at, finished_at, created_at
     ) values ($1, $2, $3, 'chapter_segment_labeling', 'mock', 'mock-model',
       $4, $5, 'succeeded', $6::jsonb, $7, $7, $7)`,
    [
      ids.analysisRun,
      coreIds.book,
      coreIds.chapter,
      hashSync(`analysis-input:${suffix}`),
      hashSync(`analysis-output:${suffix}`),
      JSON.stringify({ providerJobId: ids.providerJob, chapterId: coreIds.chapter, characterId: ids.character }),
      createdAt,
    ],
  );
  await client.query(
    `insert into chapter_contexts (
       id, book_id, chapter_id, analysis_run_id, summary, active_character_ids,
       unresolved, created_at, updated_at
     ) values ($1, $2, $3, $4, 'summary', $5::jsonb, $6::jsonb, $7, $7)`,
    [
      ids.chapterContext,
      coreIds.book,
      coreIds.chapter,
      ids.analysisRun,
      JSON.stringify([ids.character]),
      JSON.stringify([{ paragraphId: firstParagraphId, characterId: ids.character }]),
      createdAt,
    ],
  );
  await client.query(
    `insert into voice_profiles (
       id, book_id, character_id, role, provider_id, provider_voice_id,
       label, provider_options, created_at, updated_at
     ) values ($1, $2, $3, 'character', 'mock-tts', 'voice-1', 'Hero', $4::jsonb, $5, $5)`,
    [ids.voiceProfile, coreIds.book, ids.character, JSON.stringify({ characterId: ids.character }), createdAt],
  );
  await client.query(
    `insert into labeled_segments (
       id, book_id, chapter_id, paragraph_id, segment_index, start_offset, end_offset,
       segment_text_hash, segment_type, speaker_id, candidate_speakers, listener_ids,
       emotion, confidence, voice_profile_id, analysis_run_id, created_at, updated_at
     ) values ($1, $2, $3, $4, 0, 0, $5, $6, 'dialogue', $7, $8::jsonb,
       $8::jsonb, 'neutral', 1, $9, $10, $11, $11)`,
    [
      ids.segment,
      coreIds.book,
      coreIds.chapter,
      firstParagraphId,
      paragraphText.length,
      paragraphHash,
      ids.character,
      JSON.stringify([ids.character]),
      ids.voiceProfile,
      ids.analysisRun,
      createdAt,
    ],
  );
  await client.query(
    `insert into user_corrections (
       id, book_id, chapter_id, paragraph_id, segment_id, correction_type,
       before_json, after_json, apply_scope, created_at
     ) values ($1, $2, $3, $4, $5, 'speaker', $6::jsonb, $7::jsonb, 'segment', $8)`,
    [
      ids.correction,
      coreIds.book,
      coreIds.chapter,
      firstParagraphId,
      ids.segment,
      JSON.stringify({ speakerId: 'unknown', segmentTextHash: paragraphHash }),
      JSON.stringify({ speakerId: ids.character, segmentId: ids.segment, segmentTextHash: paragraphHash }),
      createdAt,
    ],
  );
  await client.query(
    `insert into book_ai_workflow_jobs (
       id, workflow_id, provider_job_id, stage, plan_item_id, sequence, created_at
     ) values ($1, $2, $3, 'chapter_labeling', $4, 0, $5)`,
    [ids.workflowJob, ids.workflow, ids.providerJob, ids.workflowWindow, createdAt],
  );

  const syncPayload = {
    bookId: coreIds.book,
    chapterId: coreIds.chapter,
    paragraphId: firstParagraphId,
    characterId: ids.character,
    voiceProfileId: ids.voiceProfile,
    segmentId: ids.segment,
    segmentTextHash: paragraphHash,
    segmentTextHashes: { [ids.segment]: paragraphHash },
    workflowId: ids.workflow,
    providerJobId: ids.providerJob,
    planItemId: ids.workflowWindow,
  };
  await client.query(
    `insert into sync_events (
       id, user_id, device_id, type, book_id, entity_id, payload, revision,
       created_at, id_contract, hash_contract, source_contract_version, source_event_id
     ) values ($1, $2, 'device-legacy', 'chapter_segments_updated', $3, $4,
       $5::jsonb, $6::jsonb, $7, 'v1-legacy', 'v1-legacy', 1, $1)`,
    [
      ids.syncEvent,
      userId,
      coreIds.book,
      coreIds.chapter,
      JSON.stringify(syncPayload),
      JSON.stringify({ entityId: coreIds.chapter, payloadHash: hashSync(JSON.stringify(syncPayload)) }),
      createdAt,
    ],
  );
  await client.query(
    `insert into tts_audio_cache (
       id, book_id, chapter_id, cache_key, provider_id, voice_profile_id, speaker_id,
       segment_ids, segment_text_hashes, input_text_hash, options_hash, render_spec_hash,
       audio_object_key, audio_hash, created_at, updated_at
     ) values ($1, $2, $3, $4, 'mock-tts', $5, $6, $7::jsonb, $8::jsonb,
       $9, $10, $11, $12, $13, $14, $14)`,
    [
      ids.ttsCache,
      coreIds.book,
      coreIds.chapter,
      `cache-${suffix}`,
      ids.voiceProfile,
      ids.character,
      JSON.stringify([ids.segment]),
      JSON.stringify({ [ids.segment]: paragraphHash }),
      hashSync(paragraphText),
      hashSync(`options:${suffix}`),
      hashSync(`render:${suffix}`),
      `audio/${suffix}`,
      hashSync(`audio:${suffix}`),
      createdAt,
    ],
  );
  return ids;
}

export interface LegacyProviderFixture {
  readonly userId: string;
  readonly settingsId: string;
  readonly secretId: string;
  readonly syncEventId: string;
}

export async function seedLegacyProviderState(
  pool: pg.Pool,
  userId: string,
  suffix: string,
): Promise<LegacyProviderFixture> {
  const settingsId = legacyId('provider_settings', suffix);
  const secretId = legacyId('provider_secret', suffix);
  const syncEventId = legacyId('sync_event', `provider:${suffix}`);
  const payload = { providerSettingsId: settingsId, providerSecretId: secretId };
  await pool.query(
    `insert into users (id, email, display_name)
     values ($1, $2, $3) on conflict (id) do nothing`,
    [userId, `${userId}@example.test`, `Provider ${suffix}`],
  );
  await pool.query(
    `insert into provider_settings (
       id, user_id, scope, default_provider_id, enabled_provider_ids,
       provider_options, created_at, updated_at, id_contract
     ) values ($1, $2, 'llm_labeling', 'mock', '["mock"]'::jsonb,
       '{}'::jsonb, $3, $3, 'v1-legacy')`,
    [settingsId, userId, FIXED_TIME],
  );
  await pool.query(
    `insert into provider_secrets (
       id, user_id, scope, provider_id, secret_name, ciphertext, iv,
       auth_tag, key_version, fingerprint, last4, created_at, updated_at, id_contract
     ) values ($1, $2, 'llm_labeling', 'mock', 'api_key', 'ciphertext', 'iv',
       'tag', 'v1', 'fingerprint', '1234', $3, $3, 'v1-legacy')`,
    [secretId, userId, FIXED_TIME],
  );
  await pool.query(
    `insert into sync_events (
       id, user_id, type, entity_id, payload, revision, created_at,
       id_contract, hash_contract, source_contract_version, source_event_id
     ) values ($1, $2, 'provider_settings_updated', $3, $4::jsonb, $5::jsonb, $6,
       'v1-legacy', 'v1-legacy', 1, $1)`,
    [
      syncEventId,
      userId,
      settingsId,
      JSON.stringify(payload),
      JSON.stringify({ entityId: settingsId, payloadHash: hashSync(JSON.stringify(payload)) }),
      FIXED_TIME,
    ],
  );
  return { userId, settingsId, secretId, syncEventId };
}
