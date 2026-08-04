import type pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import { migrateDatabase } from '../../db/migrate.js';
import {
  MemoryBookSourceLoader,
  seedLegacyBook,
  seedLegacyProviderState,
  type LegacyBookFixture,
} from './id-v2-migration.integration-fixture.js';
import { idV2IdentityFactory } from './identity-factory-adapter.js';
import { IdV2MigrationService } from './migration-service.js';
import { refreshIdentityContractStatus } from './migration-orchestrator.js';
import { migrateProviderIdentities, rollbackProviderIdentities } from './provider-migration.js';
import { startPostgresIntegrationHarness, withPostgresSchema } from './postgres-integration-harness.js';

const harness = await startPostgresIntegrationHarness();
const describeWithPostgres = harness ? describe : describe.skip;

interface AliasRow extends pg.QueryResultRow {
  entity_type: string;
  source_id: string;
  canonical_id: string;
  alias_complete: boolean;
  status: string;
}

async function bookAliases(pool: pg.Pool, fixture: LegacyBookFixture): Promise<Map<string, string>> {
  const result = await pool.query<AliasRow>(
    `select entity_type, source_id, canonical_id, alias_complete, status
     from id_v2_entity_aliases
     where user_id = $1 and source_book_id = $2`,
    [fixture.userId, fixture.ids.book],
  );
  expect(result.rows.every((row) => row.alias_complete && row.status === 'active')).toBe(true);
  return new Map(result.rows.map((row) => [`${row.entity_type}:${row.source_id}`, row.canonical_id]));
}

function mapped(aliases: ReadonlyMap<string, string>, type: string, sourceId: string | undefined): string {
  if (!sourceId) throw new Error(`Missing fixture source ID for ${type}.`);
  const value = aliases.get(`${type}:${sourceId}`);
  if (!value) throw new Error(`Missing ${type} alias for ${sourceId}.`);
  return value;
}

describeWithPostgres('PostgreSQL ID/hash v2 backfill', () => {
  const postgres = harness!;

  afterAll(async () => {
    await postgres.stop();
  });

  test('backfills provider/global-sync and every book reference while quarantining TTS cache', async () => {
    await withPostgresSchema(postgres, 'id_v2_full', async (pool) => {
      await migrateDatabase(pool);
      const provider = await seedLegacyProviderState(pool, 'provider-user', 'full');
      const providerResult = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
      });
      expect(providerResult).toMatchObject({
        status: 'activated',
        settingsMigrated: 1,
        secretsMigrated: 1,
        syncEventsMigrated: 1,
      });
      const providerAliases = await pool.query<AliasRow>(
        `select entity_type, source_id, canonical_id, alias_complete, status
         from id_v2_global_aliases where user_id = $1 order by entity_type`,
        [provider.userId],
      );
      expect(providerAliases.rows).toHaveLength(3);
      expect(providerAliases.rows.every((row) => row.alias_complete && row.status === 'active')).toBe(true);
      const canonicalSettings = idV2IdentityFactory.providerSettings(provider.userId, 'llm_labeling');
      const globalEvent = await pool.query<{
        id: string;
        entity_id: string;
        payload: Record<string, unknown>;
        revision: Record<string, unknown>;
        id_contract: string;
        hash_contract: string;
        source_event_id: string;
      }>(`select * from sync_events where user_id = $1 and book_id is null`, [provider.userId]);
      expect(globalEvent.rows[0]).toMatchObject({
        entity_id: canonicalSettings,
        id_contract: 'v2-sha256-128',
        hash_contract: 'v2-sha256-tagged',
        source_event_id: provider.syncEventId,
        payload: { providerSettingsId: canonicalSettings },
      });
      expect(globalEvent.rows[0].revision.payloadHash).toBe(syncPayloadIntegrityHash(globalEvent.rows[0].payload));

      const loader = new MemoryBookSourceLoader();
      const fixture = await seedLegacyBook(pool, loader, 'book-user', 'full', { includeDependents: true });
      const service = new IdV2MigrationService({ pool, identities: idV2IdentityFactory, sourceLoader: loader });
      const result = await service.migrateBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(result).toMatchObject({
        status: 'activated',
        sourceBookId: fixture.ids.book,
        canonicalBookId: fixture.canonicalBookId,
        report: { ttsCacheQuarantined: 1 },
      });

      const aliases = await bookAliases(pool, fixture);
      const chapterId = mapped(aliases, 'chapter', fixture.ids.chapter);
      const paragraphId = mapped(aliases, 'paragraph', fixture.ids.paragraphs[0]);
      const characterId = mapped(aliases, 'character', fixture.ids.character);
      const voiceProfileId = mapped(aliases, 'voice_profile', fixture.ids.voiceProfile);
      const segmentId = mapped(aliases, 'labeled_segment', fixture.ids.segment);
      const workflowId = mapped(aliases, 'book_ai_workflow', fixture.ids.workflow);
      const providerJobId = mapped(aliases, 'provider_job', fixture.ids.providerJob);
      const workflowWindowId = mapped(aliases, 'workflow_plan_item', fixture.ids.workflowWindow);

      const sourceBook = await pool.query('select 1 from library_books where id = $1', [fixture.ids.book]);
      const canonicalBook = await pool.query(
        `select object_id, normalized_text_hash, id_contract, hash_contract
         from library_books where id = $1`,
        [fixture.canonicalBookId],
      );
      expect(sourceBook.rowCount).toBe(0);
      expect(canonicalBook.rows).toEqual([
        {
          object_id: fixture.canonicalObjectId,
          normalized_text_hash: fixture.canonicalNormalizedTextHash,
          id_contract: 'v2-sha256-128',
          hash_contract: 'v2-sha256-tagged',
        },
      ]);

      const page = await pool.query<{ paragraphs: Array<Record<string, unknown>>; text_hash: string }>(
        `select paragraphs, text_hash from paragraph_pages where book_id = $1`,
        [fixture.canonicalBookId],
      );
      expect(page.rows[0].paragraphs[0]).toMatchObject({
        id: paragraphId,
        novelId: fixture.canonicalBookId,
        chapterId,
        textHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(page.rows[0].text_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const readerReferences = await pool.query(
        `select
           (select chapter_id from reading_positions where book_id = $1) as position_chapter,
           (select paragraph_id from bookmarks where book_id = $1) as bookmark_paragraph,
           (select paragraph_id from highlights where book_id = $1) as highlight_paragraph,
           (select paragraph_id from notes where book_id = $1) as note_paragraph`,
        [fixture.canonicalBookId],
      );
      expect(readerReferences.rows[0]).toEqual({
        position_chapter: chapterId,
        bookmark_paragraph: paragraphId,
        highlight_paragraph: paragraphId,
        note_paragraph: paragraphId,
      });

      const graph = await pool.query<{
        character_id: string;
        source_character_id: string;
        target_character_id: string;
        evidence: Record<string, unknown>;
      }>(
        `select alias_row.character_id, relation.source_character_id,
                relation.target_character_id, relation.evidence
         from character_aliases alias_row
         join character_relations relation on relation.book_id = alias_row.book_id
         where alias_row.book_id = $1`,
        [fixture.canonicalBookId],
      );
      expect(graph.rows[0]).toMatchObject({
        character_id: characterId,
        source_character_id: characterId,
        target_character_id: characterId,
        evidence: { sourceCharacterId: characterId, targetCharacterId: characterId },
      });

      const artifacts = await pool.query<{
        analysis_run_id: string;
        context_analysis_run_id: string;
        profile_character_id: string;
        segment_id: string;
        segment_hash: string;
        speaker_id: string;
        voice_profile_id: string;
        correction_segment_id: string;
      }>(
        `select
           run.id as analysis_run_id,
           context.analysis_run_id as context_analysis_run_id,
           profile.character_id as profile_character_id,
           segment.id as segment_id,
           segment.segment_text_hash as segment_hash,
           segment.speaker_id,
           segment.voice_profile_id,
           correction.segment_id as correction_segment_id
         from analysis_runs run
         join chapter_contexts context on context.book_id = run.book_id
         join voice_profiles profile on profile.book_id = run.book_id
         join labeled_segments segment on segment.book_id = run.book_id
         join user_corrections correction on correction.book_id = run.book_id
         where run.book_id = $1`,
        [fixture.canonicalBookId],
      );
      expect(artifacts.rows[0]).toMatchObject({
        context_analysis_run_id: artifacts.rows[0].analysis_run_id,
        profile_character_id: characterId,
        segment_id: segmentId,
        segment_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        speaker_id: characterId,
        voice_profile_id: voiceProfileId,
        correction_segment_id: segmentId,
      });

      const workflow = await pool.query<{
        id: string;
        plan: Record<string, Array<Record<string, unknown>>>;
        progress: Record<string, unknown>;
        provider_job_id: string;
        link_id: string;
        plan_item_id: string;
        job_progress: Record<string, unknown>;
        attempt_progress: Record<string, unknown>;
        outbox_provider_job_id: string;
      }>(
        `select workflow.id, workflow.plan, workflow.progress,
                link.provider_job_id, link.id as link_id, link.plan_item_id,
                job.progress as job_progress, attempt.progress as attempt_progress,
                outbox.provider_job_id as outbox_provider_job_id
         from book_ai_workflows workflow
         join book_ai_workflow_jobs link on link.workflow_id = workflow.id
         join provider_jobs job on job.id = link.provider_job_id
         join provider_job_attempts attempt on attempt.provider_job_id = job.id
         join provider_job_outbox outbox on outbox.provider_job_id = job.id
         where workflow.book_id = $1`,
        [fixture.canonicalBookId],
      );
      expect(workflow.rows[0]).toMatchObject({
        id: workflowId,
        provider_job_id: providerJobId,
        link_id: mapped(aliases, 'book_ai_workflow_job', fixture.ids.workflowJob),
        plan_item_id: workflowWindowId,
        outbox_provider_job_id: providerJobId,
        job_progress: {
          bookId: fixture.canonicalBookId,
          chapterId,
          paragraphIds: [paragraphId],
          characterId,
          workflowId,
          planItemId: workflowWindowId,
          textHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        attempt_progress: { workflowId, characterId },
      });
      expect(workflow.rows[0].plan.labelingWindows[0]).toMatchObject({
        id: workflowWindowId,
        chapterId,
        paragraphIds: [paragraphId],
        textHashFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });

      const syncEvent = await pool.query<{
        payload: Record<string, unknown>;
        revision: Record<string, unknown>;
        entity_id: string;
        source_event_id: string;
      }>(`select payload, revision, entity_id, source_event_id from sync_events where book_id = $1`, [
        fixture.canonicalBookId,
      ]);
      expect(syncEvent.rows[0]).toMatchObject({
        entity_id: chapterId,
        source_event_id: fixture.ids.syncEvent,
        payload: {
          bookId: fixture.canonicalBookId,
          chapterId,
          paragraphId,
          characterId,
          voiceProfileId,
          segmentId,
          segmentTextHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          segmentTextHashes: { [segmentId]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
          workflowId,
          providerJobId,
          planItemId: workflowWindowId,
        },
      });
      expect(syncEvent.rows[0].revision.payloadHash).toBe(syncPayloadIntegrityHash(syncEvent.rows[0].payload));

      const external = await pool.query(
        `select session.client_book_id, session.client_hash_hint, job.book_id
         from upload_sessions session join import_jobs job on job.upload_id = session.id
         where session.user_id = $1`,
        [fixture.userId],
      );
      expect(external.rows).toEqual([
        {
          client_book_id: fixture.canonicalBookId,
          client_hash_hint: fixture.canonicalNormalizedTextHash,
          book_id: fixture.canonicalBookId,
        },
      ]);

      expect(
        (await pool.query('select 1 from tts_audio_cache where book_id = $1', [fixture.canonicalBookId])).rowCount,
      ).toBe(0);
      const quarantine = await pool.query<{
        cache_id: string;
        row_data: Record<string, unknown>;
        restored_at: unknown;
      }>(`select cache_id, row_data, restored_at from id_v2_tts_cache_quarantine where source_book_id = $1`, [
        fixture.ids.book,
      ]);
      expect(quarantine.rows).toEqual([
        expect.objectContaining({
          cache_id: fixture.ids.ttsCache,
          restored_at: null,
          row_data: expect.objectContaining({ book_id: fixture.ids.book, id: fixture.ids.ttsCache }),
        }),
      ]);

      const contract = await refreshIdentityContractStatus(pool);
      expect(contract).toMatchObject({
        contractStatus: 'active',
        legacyBooks: 0,
        legacyProviderSettings: 0,
        legacyProviderSecrets: 0,
        legacySyncEvents: 0,
        incompleteRuns: 0,
      });
    });
  }, 60_000);

  test('resumes a staged book run and restores the exact v1 snapshot on rollback', async () => {
    await withPostgresSchema(postgres, 'id_v2_resume', async (pool) => {
      await migrateDatabase(pool);
      const loader = new MemoryBookSourceLoader();
      const fixture = await seedLegacyBook(pool, loader, 'resume-user', 'resume', { includeDependents: true });
      const service = new IdV2MigrationService({ pool, identities: idV2IdentityFactory, sourceLoader: loader });

      const staged = await service.migrateBook({
        userId: fixture.userId,
        sourceBookId: fixture.ids.book,
        stopAfterStage: 'planned',
      });
      expect(staged.status).toBe('staged');
      expect((await pool.query('select 1 from library_books where id = $1', [fixture.ids.book])).rowCount).toBe(1);
      expect((await pool.query('select 1 from library_books where id = $1', [fixture.canonicalBookId])).rowCount).toBe(
        0,
      );

      const resumed = await service.migrateBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(resumed).toMatchObject({ runId: staged.runId, status: 'activated' });
      const rolledBack = await service.rollbackBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(rolledBack).toMatchObject({ runId: staged.runId, status: 'rolled_back' });

      const source = await pool.query(
        'select id, object_id, id_contract, hash_contract from library_books where id = $1',
        [fixture.ids.book],
      );
      expect(source.rows).toEqual([
        { id: fixture.ids.book, object_id: fixture.ids.object, id_contract: 'v1-legacy', hash_contract: 'v1-legacy' },
      ]);
      expect((await pool.query('select 1 from library_books where id = $1', [fixture.canonicalBookId])).rowCount).toBe(
        0,
      );
      expect((await pool.query('select 1 from provider_jobs where id = $1', [fixture.ids.providerJob])).rowCount).toBe(
        1,
      );
      expect((await pool.query('select 1 from tts_audio_cache where id = $1', [fixture.ids.ttsCache])).rowCount).toBe(
        1,
      );
      const alias = await pool.query('select status, alias_complete from id_v2_book_aliases where run_id = $1', [
        staged.runId,
      ]);
      const quarantine = await pool.query('select restored_at from id_v2_tts_cache_quarantine where run_id = $1', [
        staged.runId,
      ]);
      expect(alias.rows).toEqual([{ status: 'rolled_back', alias_complete: false }]);
      expect(quarantine.rows[0].restored_at).toBeInstanceOf(Date);
    });
  }, 60_000);

  test('defers active book/provider work and resumes the same runs after work drains', async () => {
    await withPostgresSchema(postgres, 'id_v2_defer', async (pool) => {
      await migrateDatabase(pool);
      const loader = new MemoryBookSourceLoader();
      const provider = await seedLegacyProviderState(pool, 'defer-user', 'defer');
      const fixture = await seedLegacyBook(pool, loader, provider.userId, 'defer', { activeProviderJob: true });

      const providerDeferred = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
      });
      const service = new IdV2MigrationService({ pool, identities: idV2IdentityFactory, sourceLoader: loader });
      const bookDeferred = await service.migrateBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(providerDeferred).toMatchObject({ status: 'deferred', report: { activeWork: { providerJobs: 1 } } });
      expect(bookDeferred).toMatchObject({ status: 'deferred', report: { activeWork: { providerJobs: 1 } } });

      await pool.query('delete from provider_jobs where id = $1', [fixture.ids.providerJob]);
      const providerResumed = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
      });
      const bookResumed = await service.migrateBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(providerResumed).toMatchObject({ runId: providerDeferred.runId, status: 'activated' });
      expect(bookResumed).toMatchObject({ runId: bookDeferred.runId, status: 'activated' });
    });
  }, 60_000);

  test('quarantines canonical collisions without overwriting either book or provider state', async () => {
    await withPostgresSchema(postgres, 'id_v2_collision', async (pool) => {
      await migrateDatabase(pool);
      const loader = new MemoryBookSourceLoader();
      const provider = await seedLegacyProviderState(pool, 'collision-user', 'collision');
      const providerTargetId = idV2IdentityFactory.providerSettings(provider.userId, 'llm_labeling');
      await pool.query(
        `insert into users (id, email, display_name) values ('occupant-user', 'occupant@example.test', 'Occupant')`,
      );
      await pool.query(
        `insert into provider_settings (
           id, user_id, scope, enabled_provider_ids, model_overrides, provider_options, id_contract
         ) values ($1, 'occupant-user', 'occupied', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'v2-sha256-128')`,
        [providerTargetId],
      );
      const providerCollision = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
      });
      expect(providerCollision).toMatchObject({
        status: 'quarantined',
        report: { errorCode: 'provider_identity_collision' },
      });
      expect((await pool.query('select 1 from provider_settings where id = $1', [provider.settingsId])).rowCount).toBe(
        1,
      );
      expect(
        (await pool.query('select user_id from provider_settings where id = $1', [providerTargetId])).rows,
      ).toEqual([{ user_id: 'occupant-user' }]);

      const fixture = await seedLegacyBook(pool, loader, 'book-collision-user', 'collision');
      await pool.query(
        `insert into users (id, email, display_name)
         values ('book-occupant', 'book-occupant@example.test', 'Book Occupant')`,
      );
      await pool.query(
        `insert into library_books (
           id, user_id, title, source_file_name, normalized_text_hash,
           total_chapters, total_characters, total_paragraphs, id_contract, hash_contract
         ) values ($1, 'book-occupant', 'Occupied', 'occupied.txt', $2,
           0, 0, 0, 'v2-sha256-128', 'v2-sha256-tagged')`,
        [fixture.canonicalBookId, fixture.canonicalNormalizedTextHash],
      );
      const service = new IdV2MigrationService({ pool, identities: idV2IdentityFactory, sourceLoader: loader });
      const bookCollision = await service.migrateBook({ userId: fixture.userId, sourceBookId: fixture.ids.book });
      expect(bookCollision).toMatchObject({ status: 'quarantined', report: { errorCode: 'canonical_book_collision' } });
      expect((await pool.query('select 1 from library_books where id = $1', [fixture.ids.book])).rowCount).toBe(1);
      expect(
        (await pool.query('select user_id from library_books where id = $1', [fixture.canonicalBookId])).rows,
      ).toEqual([{ user_id: 'book-occupant' }]);
      const quarantined = await pool.query(
        `select migration_kind, status from id_v2_migration_runs
         where status = 'quarantined' order by migration_kind`,
      );
      expect(quarantined.rows).toEqual([
        { migration_kind: 'book', status: 'quarantined' },
        { migration_kind: 'global_provider', status: 'quarantined' },
      ]);
    });
  }, 60_000);

  test('rolls provider/global-sync state back only while its activated snapshot is unchanged', async () => {
    await withPostgresSchema(postgres, 'id_v2_provider_rollback', async (pool) => {
      await migrateDatabase(pool);
      const provider = await seedLegacyProviderState(pool, 'provider-rollback-user', 'provider-rollback');
      const migrated = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
        stopAfterStage: true,
      });
      expect(migrated.status).toBe('staged');
      const resumed = await migrateProviderIdentities({
        pool,
        identities: idV2IdentityFactory,
        userId: provider.userId,
      });
      expect(resumed).toMatchObject({ runId: migrated.runId, status: 'activated' });

      const rolledBack = await rollbackProviderIdentities({ pool, options: { userId: provider.userId } });
      expect(rolledBack).toMatchObject({ runId: migrated.runId, status: 'rolled_back' });
      expect((await pool.query('select 1 from provider_settings where id = $1', [provider.settingsId])).rowCount).toBe(
        1,
      );
      expect((await pool.query('select 1 from provider_secrets where id = $1', [provider.secretId])).rowCount).toBe(1);
      const event = await pool.query('select id, id_contract, hash_contract from sync_events where user_id = $1', [
        provider.userId,
      ]);
      expect(event.rows).toEqual([{ id: provider.syncEventId, id_contract: 'v1-legacy', hash_contract: 'v1-legacy' }]);
    });
  }, 60_000);
});

if (!harness) {
  describe.skip('PostgreSQL ID/hash v2 backfill requires PostgreSQL', () => {
    test('set NOVELDESK_TEST_DATABASE_URL or install PostgreSQL/Docker', () => undefined);
  });
}
