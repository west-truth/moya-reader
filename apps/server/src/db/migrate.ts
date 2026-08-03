import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig, type ServerConfig } from '../config.js';
import { createPool, seedDefaultUser } from './pool.js';

export const MIGRATION_LEDGER_TABLE = 'schema_migrations';
export const MIGRATION_ADVISORY_LOCK_KEY = '5649776841394095174';

const migrationFilePattern = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const checksumPattern = /^[a-f0-9]{64}$/;

export interface Migration {
  version: number;
  name: string;
  fileName: string;
  checksum: string;
  sql: string;
}

interface AppliedMigrationRow extends pg.QueryResultRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface MigrationRunResult {
  applied: readonly Migration[];
  currentVersion: number;
}

export interface MigrationLogger {
  info(message: string): void;
}

export interface MigrateDatabaseOptions {
  migrationsDirectory?: string;
  logger?: MigrationLogger;
}

export interface RunMigrationsOptions extends MigrateDatabaseOptions {
  config?: ServerConfig;
  pool?: pg.Pool;
  seedDefaultUser?: boolean;
}

export class MigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrations(directory = defaultMigrationsDirectory()): Promise<Migration[]> {
  let fileNames: string[];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new MigrationError('migration_assets_unavailable', 'Database migration assets are unavailable.');
  }

  if (fileNames.length === 0) {
    throw new MigrationError('migration_assets_empty', 'No database migrations were found.');
  }

  const migrations: Migration[] = [];
  for (const fileName of fileNames) {
    const match = migrationFilePattern.exec(fileName);
    if (!match) {
      throw new MigrationError('migration_filename_invalid', `Database migration filename is invalid: ${fileName}`);
    }

    const version = Number.parseInt(match[1], 10);
    const expectedVersion = migrations.length + 1;
    if (version !== expectedVersion) {
      throw new MigrationError(
        'migration_sequence_invalid',
        `Database migrations must be contiguous; expected version ${expectedVersion}.`,
      );
    }

    let sql: string;
    try {
      sql = await readFile(path.join(directory, fileName), 'utf8');
    } catch {
      throw new MigrationError('migration_asset_unreadable', `Database migration ${fileName} could not be read.`);
    }

    migrations.push({
      version,
      name: match[2],
      fileName,
      checksum: checksum(sql),
      sql,
    });
  }

  return migrations;
}

async function createLedger(client: pg.PoolClient): Promise<void> {
  try {
    await client.query(`
      create table if not exists ${MIGRATION_LEDGER_TABLE} (
        version integer primary key check (version > 0),
        name text not null,
        checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);
  } catch {
    throw new MigrationError('migration_ledger_unavailable', 'Database migration ledger could not be initialized.');
  }
}

async function readAppliedMigrations(client: pg.PoolClient): Promise<AppliedMigrationRow[]> {
  try {
    const result = await client.query<AppliedMigrationRow>(
      `select version, name, checksum, applied_at from ${MIGRATION_LEDGER_TABLE} order by version`,
    );
    return result.rows;
  } catch {
    throw new MigrationError('migration_ledger_invalid', 'Database migration ledger could not be read.');
  }
}

function verifyAppliedHistory(migrations: readonly Migration[], applied: readonly AppliedMigrationRow[]): void {
  if (applied.length > migrations.length) {
    throw new MigrationError('migration_history_ahead', 'Database migration history is newer than this server build.');
  }

  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index];
    const migration = migrations[index];
    if (row.version !== migration.version) {
      throw new MigrationError('migration_history_gap', 'Database migration history is not a contiguous prefix.');
    }
    if (row.name !== migration.name) {
      throw new MigrationError(
        'migration_name_mismatch',
        `Database migration ${migration.version} has an unexpected recorded name.`,
      );
    }
    if (!checksumPattern.test(row.checksum) || row.checksum !== migration.checksum) {
      throw new MigrationError(
        'migration_checksum_mismatch',
        `Database migration ${migration.fileName} differs from the applied migration.`,
      );
    }
  }
}

async function applyMigration(client: pg.PoolClient, migration: Migration): Promise<void> {
  let transactionStarted = false;
  try {
    await client.query('begin');
    transactionStarted = true;
    await client.query(migration.sql);
    await client.query(`insert into ${MIGRATION_LEDGER_TABLE} (version, name, checksum) values ($1, $2, $3)`, [
      migration.version,
      migration.name,
      migration.checksum,
    ]);
    await client.query('commit');
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('rollback');
      } catch {
        // A broken connection releases its session advisory lock when PostgreSQL closes it.
      }
    }
    throw new MigrationError(
      'migration_apply_failed',
      `Database migration ${migration.fileName} could not be applied.`,
      { cause: error },
    );
  }
}

async function migrateWithLock(
  client: pg.PoolClient,
  migrations: readonly Migration[],
  logger?: MigrationLogger,
): Promise<MigrationRunResult> {
  await createLedger(client);
  const appliedRows = await readAppliedMigrations(client);
  verifyAppliedHistory(migrations, appliedRows);

  const appliedNow: Migration[] = [];
  for (const migration of migrations.slice(appliedRows.length)) {
    await applyMigration(client, migration);
    appliedNow.push(migration);
    logger?.info(`Applied database migration ${migration.fileName}.`);
  }

  return {
    applied: appliedNow,
    currentVersion: migrations.at(-1)?.version ?? 0,
  };
}

export async function migrateDatabase(
  pool: pg.Pool,
  options: MigrateDatabaseOptions = {},
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations(options.migrationsDirectory);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new MigrationError('migration_connection_failed', 'Database migration connection could not be established.');
  }

  let lockAcquired = false;
  let result: MigrationRunResult | undefined;
  let failure: MigrationError | undefined;

  try {
    await client.query('select pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
    lockAcquired = true;
  } catch {
    failure = new MigrationError('migration_lock_failed', 'Database migration lock could not be acquired.');
  }

  if (lockAcquired) {
    try {
      result = await migrateWithLock(client, migrations, options.logger);
    } catch (error) {
      failure =
        error instanceof MigrationError
          ? error
          : new MigrationError('migration_failed', 'Database migration did not complete.');
    }
  }

  if (lockAcquired) {
    try {
      const unlock = await client.query<{ unlocked: boolean }>('select pg_advisory_unlock($1::bigint) as unlocked', [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);
      if (!unlock.rows[0]?.unlocked && !failure) {
        failure = new MigrationError('migration_unlock_failed', 'Database migration lock could not be released.');
      }
    } catch {
      if (!failure) {
        failure = new MigrationError('migration_unlock_failed', 'Database migration lock could not be released.');
      }
    }
  }
  client.release();

  if (failure) throw failure;
  if (!result) {
    throw new MigrationError('migration_failed', 'Database migration did not complete.');
  }
  return result;
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrationRunResult> {
  const config = options.config ?? loadConfig();
  const ownsPool = !options.pool;
  const pool = options.pool ?? createPool(config);

  try {
    const result = await migrateDatabase(pool, options);
    if (options.seedDefaultUser ?? true) {
      try {
        await seedDefaultUser(pool, config.defaultUserId);
      } catch {
        throw new MigrationError('default_user_seed_failed', 'Default database user could not be initialized.');
      }
    }
    return result;
  } finally {
    if (ownsPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMigrations({ logger: console }).catch((error: unknown) => {
    const message = error instanceof MigrationError ? error.message : 'Database migration failed.';
    console.error(message);
    process.exit(1);
  });
}
