import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import type { ProviderJobAdmissionLimits } from '../config.js';
import { ProviderJobAdmissionError, prepareAdmittedProviderAttempt } from '../services/provider-job-admission/index.js';
import { MIGRATION_ADVISORY_LOCK_KEY, MIGRATION_LEDGER_TABLE, loadMigrations, migrateDatabase } from './migrate.js';

const { Pool } = pg;
const productionMigrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
const baselinePath = path.join(productionMigrationsDirectory, '0001_baseline.sql');
const schemaSnapshotPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

interface PostgresHarness {
  source: string;
  url: string;
  stop(): Promise<void>;
}

const temporaryDirectories: string[] = [];

function runProcess(
  command: string,
  args: string[],
  timeout = 60_000,
  ignoreOutput = false,
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ignoreOutput ? 'ignore' : 'pipe',
    timeout,
    windowsHide: true,
  });
}

function requireSuccessfulProcess(
  label: string,
  command: string,
  args: string[],
  timeout?: number,
  ignoreOutput = false,
): ReturnType<typeof spawnSync> {
  const result = runProcess(command, args, timeout, ignoreOutput);
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a PostgreSQL test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function hasExecutables(directory: string): Promise<boolean> {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  try {
    await Promise.all(['initdb', 'pg_ctl', 'postgres'].map((name) => access(path.join(directory, `${name}${suffix}`))));
    return true;
  } catch {
    return false;
  }
}

function executableDirectoryFromPath(name: string): string | undefined {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runProcess(locator, [name], 5_000);
  const firstMatch = result.status === 0 ? String(result.stdout).split(/\r?\n/).find(Boolean) : undefined;
  return firstMatch ? path.dirname(firstMatch.trim()) : undefined;
}

async function findLocalPostgresDirectory(): Promise<string | undefined> {
  const candidates = [process.env.POSTGRES_BIN_DIR, executableDirectoryFromPath('initdb')].filter(
    (entry): entry is string => Boolean(entry),
  );

  if (process.platform === 'win32' && process.env.ProgramFiles) {
    const installationsRoot = path.join(process.env.ProgramFiles, 'PostgreSQL');
    try {
      const versions = (await readdir(installationsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      candidates.push(...versions.map((version) => path.join(installationsRoot, version, 'bin')));
    } catch {
      // PostgreSQL is not installed in the standard Windows location.
    }
  }

  for (const candidate of candidates) {
    if (await hasExecutables(candidate)) return candidate;
  }
  return undefined;
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1_000, max: 1 });
    try {
      await pool.query('select 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error('Temporary PostgreSQL did not become ready.');
}

async function startLocalPostgres(binDirectory: string): Promise<PostgresHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'noveldesk-migrations-pg-'));
  temporaryDirectories.push(root);
  const dataDirectory = path.join(root, 'data');
  const logPath = path.join(root, 'postgres.log');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const executable = (name: string) => path.join(binDirectory, `${name}${suffix}`);
  const port = await unusedPort();

  try {
    requireSuccessfulProcess('initdb', executable('initdb'), [
      '-D',
      dataDirectory,
      '-A',
      'trust',
      '-U',
      'postgres',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    requireSuccessfulProcess(
      'pg_ctl start',
      executable('pg_ctl'),
      ['-D', dataDirectory, '-l', logPath, '-o', `-F -p ${port} -h 127.0.0.1`, '-w', 'start'],
      45_000,
      true,
    );

    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url);
    return {
      source: `local:${binDirectory}`,
      url,
      async stop() {
        runProcess(executable('pg_ctl'), ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'], 30_000, true);
        await rm(root, { force: true, recursive: true });
      },
    };
  } catch (error) {
    runProcess(executable('pg_ctl'), ['-D', dataDirectory, '-m', 'immediate', 'stop'], 10_000, true);
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

async function startDockerPostgres(): Promise<PostgresHarness | undefined> {
  if (runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], 10_000).status !== 0) return undefined;

  const port = await unusedPort();
  const containerName = `noveldesk-migrations-${randomUUID().slice(0, 8)}`;
  requireSuccessfulProcess(
    'docker postgres start',
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      containerName,
      '--env',
      'POSTGRES_USER=noveldesk_test',
      '--env',
      'POSTGRES_PASSWORD=noveldesk_test',
      '--env',
      'POSTGRES_DB=noveldesk_test',
      '--publish',
      `127.0.0.1:${port}:5432`,
      'postgres:16-alpine',
    ],
    120_000,
  );

  const url = `postgres://noveldesk_test:noveldesk_test@127.0.0.1:${port}/noveldesk_test`;
  try {
    await waitForPostgres(url);
  } catch (error) {
    runProcess('docker', ['rm', '--force', containerName], 30_000);
    throw error;
  }

  return {
    source: `docker:${containerName}`,
    url,
    async stop() {
      runProcess('docker', ['rm', '--force', containerName], 30_000);
    },
  };
}

async function startPostgresHarness(): Promise<PostgresHarness | undefined> {
  const externalUrl = process.env.NOVELDESK_TEST_DATABASE_URL ?? process.env.POSTGRES_TEST_URL;
  if (externalUrl) {
    await waitForPostgres(externalUrl);
    return { source: 'environment', url: externalUrl, async stop() {} };
  }

  const localDirectory = await findLocalPostgresDirectory();
  let localFailure: unknown;
  if (localDirectory) {
    try {
      return await startLocalPostgres(localDirectory);
    } catch (error) {
      localFailure = error;
      // Fall through to Docker when a discovered installation cannot start a temporary cluster.
    }
  }
  const dockerHarness = await startDockerPostgres();
  if (!dockerHarness && localFailure) throw localFailure;
  return dockerHarness;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function withIsolatedSchema<T>(
  harness: PostgresHarness,
  label: string,
  callback: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const schema = `${label}_${randomUUID().replaceAll('-', '')}`.toLowerCase();
  const admin = new Pool({ connectionString: harness.url, max: 2 });
  await admin.query(`create schema ${quoteIdentifier(schema)}`);

  const connectionUrl = new URL(harness.url);
  connectionUrl.searchParams.set('options', `-csearch_path=${schema},public`);
  const pool = new Pool({ connectionString: connectionUrl.toString(), max: 4 });

  try {
    return await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
    await admin.end();
  }
}

async function temporaryMigrations(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'noveldesk-migrations-'));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(path.join(directory, name), sql, 'utf8')));
  return directory;
}

async function insertLegacyProviderJob(pool: pg.Pool): Promise<void> {
  await pool.query(`
    insert into users (id, email, display_name) values ('legacy-user', 'legacy@example.test', 'Legacy Reader');
    insert into library_books (
      id, user_id, title, source_file_name, normalized_text_hash,
      total_chapters, total_characters, total_paragraphs
    ) values ('legacy-book', 'legacy-user', 'Legacy Book', 'legacy.txt', 'legacy-hash', 1, 10, 1);
    insert into provider_jobs (
      id, user_id, book_id, job_type, provider_id, input_hash, status
    ) values ('legacy-job', 'legacy-user', 'legacy-book', 'label_chapter', 'mock', 'input-hash', 'queued');
  `);
}

async function seedAdmissionJobs(pool: pg.Pool, jobIds: readonly string[]): Promise<void> {
  await pool.query(`
    insert into users (id, email, display_name)
    values ('admission-user', 'admission@example.test', 'Admission Reader');
    insert into library_books (
      id, user_id, title, source_file_name, normalized_text_hash,
      total_chapters, total_characters, total_paragraphs
    ) values ('admission-book', 'admission-user', 'Admission Book', 'admission.txt', 'admission-hash', 1, 10, 1);
  `);
  for (const jobId of jobIds) {
    await pool.query(
      `
        insert into provider_jobs (
          id, user_id, book_id, job_type, provider_id, input_hash, status, stage
        ) values ($1, 'admission-user', 'admission-book', 'chapter_segment_labeling', 'mock', $2, 'queued', 'queued')
      `,
      [jobId, `input-${jobId}`],
    );
  }
}

function admissionLimits(overrides: Partial<ProviderJobAdmissionLimits> = {}): ProviderJobAdmissionLimits {
  return {
    maxActiveAttempts: 0,
    maxAttemptsPerMinute: 0,
    maxAttemptsPerUtcDay: 0,
    ...overrides,
  };
}

async function failAndRequeueProviderJob(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(
    `
      update provider_job_attempts attempt
      set status = 'running', stage = 'running', started_at = now(), updated_at = now()
      from provider_jobs job
      where job.id = $1 and attempt.id = job.current_attempt_id and attempt.status = 'queued'
    `,
    [jobId],
  );
  await pool.query(
    `
      update provider_jobs
      set status = 'running', stage = 'running', started_at = now(), updated_at = now()
      where id = $1 and status = 'queued'
    `,
    [jobId],
  );
  await pool.query(
    `
      update provider_job_attempts attempt
      set status = 'failed', stage = 'failed', finished_at = now(), updated_at = now()
      from provider_jobs job
      where job.id = $1 and attempt.id = job.current_attempt_id and attempt.status = 'running'
    `,
    [jobId],
  );
  await pool.query(
    `
      update provider_jobs
      set status = 'failed', stage = 'failed', error_code = 'test_failure', finished_at = now(), updated_at = now()
      where id = $1 and status = 'running'
    `,
    [jobId],
  );
  await pool.query(
    `
      update provider_jobs
      set status = 'queued', stage = 'queued', error_code = null, error_message = null,
          started_at = null, finished_at = null, updated_at = now()
      where id = $1 and status = 'failed'
    `,
    [jobId],
  );
}

const harness = await startPostgresHarness();
const describeWithPostgres = harness ? describe : describe.skip;

async function paragraphSearchIndexNames(pool: pg.Pool) {
  const result = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes
     where schemaname = current_schema() and tablename = 'paragraph_search'
     order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

function expectParagraphSearchScopeIndexes(indexNames: string[]) {
  expect(indexNames).toEqual(
    expect.arrayContaining([
      'idx_paragraph_search_book_order',
      'idx_paragraph_search_chapter_order',
      'idx_paragraph_search_paragraph_id',
    ]),
  );
  expect(indexNames).not.toContain('idx_paragraph_search_text_trgm');
}

describeWithPostgres('versioned PostgreSQL migrations', () => {
  const postgres = harness as PostgresHarness;

  afterAll(async () => {
    await postgres.stop();
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })));
  });

  test('applies a clean install in numbered order', async () => {
    await withIsolatedSchema(postgres, 'clean', async (pool) => {
      const messages: string[] = [];
      const result = await migrateDatabase(pool, {
        logger: { info: (message) => messages.push(message) },
      });
      const expected = await loadMigrations();
      const ledger = await pool.query(
        `select version, name, checksum, applied_at from ${MIGRATION_LEDGER_TABLE} order by version`,
      );
      const tables = await pool.query<{ tablename: string }>(
        'select tablename from pg_tables where schemaname = current_schema()',
      );
      const paragraphSearchIndexes = await paragraphSearchIndexNames(pool);

      expect(result.applied.map((migration) => migration.fileName)).toEqual(
        expected.map((migration) => migration.fileName),
      );
      expect(result.currentVersion).toBe(expected.length);
      expect(ledger.rows.map(({ version, name, checksum }) => ({ version, name, checksum }))).toEqual(
        expected.map(({ version, name, checksum }) => ({ version, name, checksum })),
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual(
        expect.arrayContaining(['users', 'provider_jobs', 'provider_job_attempts', 'provider_job_outbox']),
      );
      expectParagraphSearchScopeIndexes(paragraphSearchIndexes);
      expect(messages).toHaveLength(expected.length);
    });
  }, 30_000);

  test.each([
    ['committed baseline', baselinePath],
    ['latest monolithic snapshot', schemaSnapshotPath],
  ])(
    'adopts a legacy database created from the %s',
    async (_label, legacySchemaPath) => {
      await withIsolatedSchema(postgres, 'legacy', async (pool) => {
        await pool.query(await readFile(legacySchemaPath, 'utf8'));
        await insertLegacyProviderJob(pool);

        const result = await migrateDatabase(pool);
        const expected = await loadMigrations();
        const legacyJob = await pool.query(
          `select id, attempt_count, current_attempt_id from provider_jobs where id = 'legacy-job'`,
        );
        const ledger = await pool.query(`select version from ${MIGRATION_LEDGER_TABLE} order by version`);

        const metadata = await pool.query(
          `select status, activated_at from identity_contract_metadata where contract_name = 'persistent_identity'`,
        );
        const paragraphSearchIndexes = await paragraphSearchIndexNames(pool);
        expect(result.applied.map((migration) => migration.version)).toEqual(
          expected.map((migration) => migration.version),
        );
        expect(legacyJob.rows).toEqual([{ id: 'legacy-job', attempt_count: 0, current_attempt_id: null }]);
        expect(ledger.rows).toEqual(expected.map((migration) => ({ version: migration.version })));
        expect(metadata.rows).toEqual([{ status: 'expanded', activated_at: null }]);
        expectParagraphSearchScopeIndexes(paragraphSearchIndexes);
      });
    },
    30_000,
  );

  test('is a no-op on the second run without changing ledger timestamps', async () => {
    await withIsolatedSchema(postgres, 'noop', async (pool) => {
      await migrateDatabase(pool);
      const before = await pool.query(`select version, applied_at from ${MIGRATION_LEDGER_TABLE} order by version`);
      const second = await migrateDatabase(pool);
      const after = await pool.query(`select version, applied_at from ${MIGRATION_LEDGER_TABLE} order by version`);

      expect(second.applied).toEqual([]);
      expect(after.rows).toEqual(before.rows);
    });
  }, 30_000);

  test('fails closed when an applied migration checksum changes', async () => {
    await withIsolatedSchema(postgres, 'checksum', async (pool) => {
      const directory = await temporaryMigrations({ '0001_probe.sql': 'create table checksum_probe (id integer);\n' });
      await migrateDatabase(pool, { migrationsDirectory: directory });
      await writeFile(path.join(directory, '0001_probe.sql'), 'create table checksum_probe (id bigint);\n', 'utf8');

      await expect(migrateDatabase(pool, { migrationsDirectory: directory })).rejects.toMatchObject({
        code: 'migration_checksum_mismatch',
      });
    });
  });

  test('preserves the PostgreSQL cause for an incompatible expand migration', async () => {
    await withIsolatedSchema(postgres, 'expand_cause', async (pool) => {
      const directory = await temporaryMigrations({
        '0001_old_metadata.sql': `
          create table identity_contract_metadata (
            contract_name text primary key,
            activated_at timestamptz not null default now()
          );
        `,
        '0002_expand.sql': `
          insert into identity_contract_metadata (contract_name, status)
          values ('persistent_identity', 'expanded');
        `,
      });

      const failure = await migrateDatabase(pool, { migrationsDirectory: directory }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'migration_apply_failed',
        message: 'Database migration 0002_expand.sql could not be applied.',
        cause: {
          code: '42703',
          message: expect.stringContaining('status'),
        },
      });
      expect((failure as Error).message).not.toContain('column');
    });
  });

  test('rolls back a failed migration and releases the advisory lock', async () => {
    await withIsolatedSchema(postgres, 'failure', async (pool) => {
      const directory = await temporaryMigrations({
        '0001_probe.sql': 'create table migration_probe (id integer primary key);\n',
        '0002_failure.sql': 'create table rolled_back_probe (id integer); select missing_migration_function();\n',
      });

      const failure = await migrateDatabase(pool, { migrationsDirectory: directory }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'migration_apply_failed' });
      expect((failure as Error).message).not.toContain('missing_migration_function');
      expect((failure as Error & { cause?: { code?: string; message?: string } }).cause).toMatchObject({
        code: '42883',
        message: expect.stringContaining('missing_migration_function'),
      });
      const ledger = await pool.query(`select version from ${MIGRATION_LEDGER_TABLE} order by version`);
      const rolledBackTable = await pool.query(`select to_regclass('rolled_back_probe') as table_name`);
      const lockClient = await pool.connect();
      const lock = await lockClient.query<{ acquired: boolean }>(
        'select pg_try_advisory_lock($1::bigint) as acquired',
        [MIGRATION_ADVISORY_LOCK_KEY],
      );
      await lockClient.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      lockClient.release();

      expect(ledger.rows).toEqual([{ version: 1 }]);
      expect(rolledBackTable.rows).toEqual([{ table_name: null }]);
      expect(lock.rows).toEqual([{ acquired: true }]);

      await writeFile(path.join(directory, '0002_failure.sql'), 'create table recovered_probe (id integer);\n', 'utf8');
      const recovered = await migrateDatabase(pool, { migrationsDirectory: directory });
      expect(recovered.applied.map((migration) => migration.version)).toEqual([2]);
    });
  });

  test('serializes concurrent runners on one database', async () => {
    await withIsolatedSchema(postgres, 'concurrent', async (pool) => {
      const directory = await temporaryMigrations({
        '0001_concurrent.sql': `
          create table concurrent_probe (id integer primary key);
          select pg_sleep(0.25);
          insert into concurrent_probe (id) values (1);
        `,
      });

      const results = await Promise.all([
        migrateDatabase(pool, { migrationsDirectory: directory }),
        migrateDatabase(pool, { migrationsDirectory: directory }),
      ]);
      const ledger = await pool.query(`select version from ${MIGRATION_LEDGER_TABLE}`);
      const probe = await pool.query('select id from concurrent_probe');

      expect(results.map((result) => result.applied.length).sort()).toEqual([0, 1]);
      expect(ledger.rows).toEqual([{ version: 1 }]);
      expect(probe.rows).toEqual([{ id: 1 }]);
    });
  });

  test('serializes concurrent per-user admission and enforces the active-attempt limit', async () => {
    await withIsolatedSchema(postgres, 'admission_concurrent', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-a', 'job-b']);

      const settled = await Promise.allSettled([
        prepareAdmittedProviderAttempt(pool, 'job-a', admissionLimits({ maxActiveAttempts: 1 })),
        prepareAdmittedProviderAttempt(pool, 'job-b', admissionLimits({ maxActiveAttempts: 1 })),
      ]);
      const attempts = await pool.query('select provider_job_id from provider_job_attempts order by provider_job_id');
      const jobs = await pool.query('select id, status, error_code from provider_jobs order by id');

      expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
      expect(settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')?.reason).toMatchObject({
        code: 'provider_job_admission_rejected',
        limit: 'active_attempts',
      });
      expect(attempts.rows).toHaveLength(1);
      expect(jobs.rows.filter((row) => row.status === 'failed')).toHaveLength(1);
    });
  }, 30_000);

  test('moves a limited book workflow to a structured retryable review target', async () => {
    await withIsolatedSchema(postgres, 'admission_workflow', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-blocker', 'job-workflow']);
      await pool.query(`
        insert into book_ai_workflows (
          id, user_id, book_id, provider_id, model_id, plan_hash, plan, status, stage, progress, started_at
        ) values (
          'workflow-admission', 'admission-user', 'admission-book', 'mock', 'mock-model',
          'plan-hash', '{}'::jsonb, 'running', 'building_graph', '{}'::jsonb, now()
        );
        insert into book_ai_workflow_jobs (
          id, workflow_id, provider_job_id, stage, plan_item_id, sequence
        ) values (
          'workflow-link-admission', 'workflow-admission', 'job-workflow',
          'character_graph_bootstrap', 'bundle-1', 0
        );
      `);
      const limits = admissionLimits({ maxActiveAttempts: 1 });
      await prepareAdmittedProviderAttempt(pool, 'job-blocker', limits);

      await expect(prepareAdmittedProviderAttempt(pool, 'job-workflow', limits)).rejects.toMatchObject({
        code: 'provider_job_admission_rejected',
        limit: 'active_attempts',
      });
      const workflow = await pool.query(
        'select status, stage, progress, error_code, error_message from book_ai_workflows where id = $1',
        ['workflow-admission'],
      );
      const book = await pool.query('select analysis_status from library_books where id = $1', ['admission-book']);

      expect(workflow.rows[0]).toMatchObject({
        status: 'needs_review',
        stage: 'needs_review',
        error_code: 'provider_job_admission_rejected',
        error_message: 'Provider job admission limit was reached.',
        progress: {
          failedProviderJobId: 'job-workflow',
          failedStage: 'character_graph_bootstrap',
          failedPlanItemId: 'bundle-1',
          workflowReviewTargets: [
            {
              id: 'provider_admission:job-workflow',
              kind: 'provider_admission_rejected',
              stage: 'character_graph_bootstrap',
              planItemId: 'bundle-1',
              providerJobId: 'job-workflow',
              providerJobStatus: 'failed',
              errorCode: 'provider_job_admission_rejected',
              recommendedAction: 'retry_workflow',
              limit: 'active_attempts',
            },
          ],
        },
      });
      expect(book.rows).toEqual([{ analysis_status: 'needs_review' }]);
    });
  }, 30_000);

  test('does not charge duplicate enqueue of one current attempt twice', async () => {
    await withIsolatedSchema(postgres, 'admission_duplicate', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-duplicate']);

      const [first, duplicate] = await Promise.all([
        prepareAdmittedProviderAttempt(pool, 'job-duplicate', admissionLimits({ maxAttemptsPerUtcDay: 1 })),
        prepareAdmittedProviderAttempt(pool, 'job-duplicate', admissionLimits({ maxAttemptsPerUtcDay: 1 })),
      ]);
      const attempts = await pool.query('select id from provider_job_attempts');
      const job = await pool.query('select attempt_count from provider_jobs where id = $1', ['job-duplicate']);

      expect(first).toEqual(duplicate);
      expect(attempts.rows).toHaveLength(1);
      expect(job.rows).toEqual([{ attempt_count: 1 }]);
    });
  }, 30_000);

  test('uses a rolling minute window and admits again after its oldest attempt expires', async () => {
    await withIsolatedSchema(postgres, 'admission_minute', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-minute-a', 'job-minute-b', 'job-minute-c']);
      const limits = admissionLimits({ maxAttemptsPerMinute: 1 });

      await prepareAdmittedProviderAttempt(pool, 'job-minute-a', limits);
      await expect(prepareAdmittedProviderAttempt(pool, 'job-minute-b', limits)).rejects.toMatchObject({
        code: 'provider_job_admission_rejected',
        limit: 'attempts_per_minute',
        retryAfterSeconds: expect.any(Number),
      });
      await pool.query(
        `update provider_job_attempts set created_at = now() - interval '61 seconds' where provider_job_id = $1`,
        ['job-minute-a'],
      );

      await expect(prepareAdmittedProviderAttempt(pool, 'job-minute-c', limits)).resolves.toBeDefined();
    });
  }, 30_000);

  test('resets the coarse attempt budget at the UTC day boundary', async () => {
    await withIsolatedSchema(postgres, 'admission_day', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-day-a', 'job-day-b', 'job-day-c']);
      const limits = admissionLimits({ maxAttemptsPerUtcDay: 1 });

      await prepareAdmittedProviderAttempt(pool, 'job-day-a', limits);
      await pool.query(
        `
          update provider_job_attempts
          set created_at = (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') - interval '1 second'
          where provider_job_id = $1
        `,
        ['job-day-a'],
      );
      await expect(prepareAdmittedProviderAttempt(pool, 'job-day-b', limits)).resolves.toBeDefined();
      await expect(prepareAdmittedProviderAttempt(pool, 'job-day-c', limits)).rejects.toMatchObject({
        code: 'provider_job_admission_rejected',
        limit: 'attempts_per_utc_day',
        retryAfterSeconds: expect.any(Number),
      });
    });
  }, 30_000);

  test('charges each admitted retry while rejected retries create no attempt', async () => {
    await withIsolatedSchema(postgres, 'admission_retry', async (pool) => {
      await migrateDatabase(pool);
      await seedAdmissionJobs(pool, ['job-retry']);
      const limits = admissionLimits({ maxAttemptsPerUtcDay: 2 });

      await prepareAdmittedProviderAttempt(pool, 'job-retry', limits);
      await failAndRequeueProviderJob(pool, 'job-retry');
      await prepareAdmittedProviderAttempt(pool, 'job-retry', limits);
      await failAndRequeueProviderJob(pool, 'job-retry');
      await expect(prepareAdmittedProviderAttempt(pool, 'job-retry', limits)).rejects.toBeInstanceOf(
        ProviderJobAdmissionError,
      );
      const attempts = await pool.query('select attempt_number from provider_job_attempts order by attempt_number');
      const job = await pool.query('select attempt_count, status, error_code from provider_jobs where id = $1', [
        'job-retry',
      ]);

      expect(attempts.rows).toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
      expect(job.rows).toEqual([
        {
          attempt_count: 2,
          status: 'failed',
          error_code: 'provider_job_admission_rejected',
        },
      ]);
    });
  }, 30_000);
});

if (!harness) {
  describe.skip('versioned PostgreSQL migrations require PostgreSQL', () => {
    test('set NOVELDESK_TEST_DATABASE_URL or install PostgreSQL/Docker', () => undefined);
  });
}
