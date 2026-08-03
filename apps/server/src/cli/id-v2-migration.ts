import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig, type ServerConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { IdV2MigrationError, type BookMigrationResult } from '../services/id-v2-migration/contracts.js';
import { idV2IdentityFactory } from '../services/id-v2-migration/identity-factory-adapter.js';
import { IdV2MigrationService } from '../services/id-v2-migration/migration-service.js';
import {
  assertIdV2SchemaReady,
  listBookMigrationCandidates,
  listMigrationUserIds,
  markIdentityContractExpanded,
  readIdentityMigrationStatus,
  refreshIdentityContractStatus,
} from '../services/id-v2-migration/migration-orchestrator.js';
import {
  migrateProviderIdentities,
  rollbackProviderIdentities,
  type ProviderIdentityMigrationResult,
} from '../services/id-v2-migration/provider-migration.js';
import { S3BookSourceLoader } from '../services/id-v2-migration/source-loader.js';

type Action = 'migrate' | 'status' | 'rollback-book' | 'rollback-provider' | 'recover-book';

interface CliOptions {
  readonly action: Action;
  readonly userId?: string;
  readonly allUsers: boolean;
  readonly bookId?: string;
  readonly limit?: number;
  readonly confirmBackup: boolean;
  readonly stageOnly: boolean;
  readonly retryQuarantined: boolean;
  readonly skipProvider: boolean;
  readonly skipBooks: boolean;
  readonly json: boolean;
}

interface RecentRun extends pg.QueryResultRow {
  id: string;
  migration_kind: string;
  user_id: string;
  source_book_id: string | null;
  canonical_book_id: string | null;
  status: string;
  error_code: string | null;
  updated_at: Date | string;
}

export interface IdV2CliDependencies {
  readonly config?: ServerConfig;
  readonly pool?: pg.Pool;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

const actions = new Set<Action>(['migrate', 'status', 'rollback-book', 'rollback-provider', 'recover-book']);
const mutatingActions = new Set<Action>(['migrate', 'rollback-book', 'rollback-provider', 'recover-book']);

function argumentValue(args: readonly string[], index: number, name: string): { value: string; next: number } {
  const argument = args[index];
  const inline = argument.indexOf('=');
  if (inline >= 0) return { value: argument.slice(inline + 1), next: index };
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new IdV2MigrationError('cli_argument_missing', `${name} requires a value.`);
  return { value, next: index + 1 };
}

export function parseIdV2CliOptions(args: readonly string[]): CliOptions {
  const action = args[0] as Action | undefined;
  if (!action || !actions.has(action)) {
    throw new IdV2MigrationError(
      'cli_action_invalid',
      'Use migrate, status, rollback-book, rollback-provider, or recover-book.',
    );
  }

  let userId: string | undefined;
  let allUsers = false;
  let bookId: string | undefined;
  let limit: number | undefined;
  let confirmBackup = false;
  let stageOnly = false;
  let retryQuarantined = false;
  let skipProvider = false;
  let skipBooks = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--all-users') allUsers = true;
    else if (argument === '--confirm-backup') confirmBackup = true;
    else if (argument === '--stage-only') stageOnly = true;
    else if (argument === '--retry-quarantined') retryQuarantined = true;
    else if (argument === '--skip-provider') skipProvider = true;
    else if (argument === '--skip-books') skipBooks = true;
    else if (argument === '--json') json = true;
    else if (argument === '--user' || argument.startsWith('--user=')) {
      const parsed = argumentValue(args, index, '--user');
      userId = parsed.value;
      index = parsed.next;
    } else if (argument === '--book' || argument.startsWith('--book=')) {
      const parsed = argumentValue(args, index, '--book');
      bookId = parsed.value;
      index = parsed.next;
    } else if (argument === '--limit' || argument.startsWith('--limit=')) {
      const parsed = argumentValue(args, index, '--limit');
      limit = Number(parsed.value);
      index = parsed.next;
    } else {
      throw new IdV2MigrationError('cli_argument_invalid', `Unknown argument: ${argument}`);
    }
  }

  if (userId && allUsers) throw new IdV2MigrationError('cli_scope_invalid', 'Choose --user or --all-users, not both.');
  if (action !== 'status' && !userId && !allUsers) {
    throw new IdV2MigrationError('cli_scope_required', 'A mutating command requires --user or --all-users.');
  }
  if (bookId && !userId) throw new IdV2MigrationError('cli_scope_invalid', '--book requires --user.');
  if ((action === 'rollback-book' || action === 'recover-book') && (!userId || !bookId)) {
    throw new IdV2MigrationError('cli_scope_required', `${action} requires --user and --book.`);
  }
  if (action === 'rollback-provider' && !userId) {
    throw new IdV2MigrationError('cli_scope_required', 'rollback-provider requires --user.');
  }
  if (mutatingActions.has(action) && !confirmBackup) {
    throw new IdV2MigrationError(
      'cli_backup_confirmation_required',
      'Confirm a tested database/object-storage backup with --confirm-backup.',
    );
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new IdV2MigrationError('migration_limit_invalid', '--limit must be a positive integer.');
  }
  if (skipBooks && skipProvider) {
    throw new IdV2MigrationError('cli_scope_invalid', '--skip-books and --skip-provider cannot be combined.');
  }
  return {
    action,
    userId,
    allUsers,
    bookId,
    limit,
    confirmBackup,
    stageOnly,
    retryQuarantined,
    skipProvider,
    skipBooks,
    json,
  };
}

function isIncompleteStatus(status: string): boolean {
  return ['deferred', 'quarantined', 'failed'].includes(status);
}

async function recentRuns(pool: pg.Pool, userId?: string): Promise<RecentRun[]> {
  const result = await pool.query<RecentRun>(
    `select id, migration_kind, user_id, source_book_id, canonical_book_id,
            status, error_code, updated_at
     from id_v2_migration_runs
     where ($1::text is null or user_id = $1)
     order by updated_at desc limit 100`,
    [userId ?? null],
  );
  return result.rows;
}

async function migrateUsers(
  pool: pg.Pool,
  config: ServerConfig,
  options: CliOptions,
  stderr: (message: string) => void,
): Promise<{ provider: ProviderIdentityMigrationResult[]; books: BookMigrationResult[] }> {
  const userIds = await listMigrationUserIds(pool, options.userId);
  const logger = { info: stderr, warn: stderr };
  const service = new IdV2MigrationService({
    pool,
    identities: idV2IdentityFactory,
    sourceLoader: new S3BookSourceLoader(config),
    logger,
  });
  const provider: ProviderIdentityMigrationResult[] = [];
  const books: BookMigrationResult[] = [];
  for (const userId of userIds) {
    if (!options.skipProvider) {
      provider.push(
        await migrateProviderIdentities({
          pool,
          identities: idV2IdentityFactory,
          userId,
          logger,
          stopAfterStage: options.stageOnly,
        }),
      );
    }
    if (options.skipBooks) continue;
    const candidates = await listBookMigrationCandidates(pool, {
      userId,
      sourceBookId: options.bookId,
      limit: options.limit,
      retryQuarantined: options.retryQuarantined,
    });
    for (const candidate of candidates) {
      books.push(
        await service.migrateBook({
          userId: candidate.userId,
          sourceBookId: candidate.sourceBookId,
          stopAfterStage: options.stageOnly ? 'planned' : undefined,
        }),
      );
    }
  }
  return { provider, books };
}

export async function runIdV2MigrationCli(
  args: readonly string[],
  dependencies: IdV2CliDependencies = {},
): Promise<number> {
  const options = parseIdV2CliOptions(args);
  const config = dependencies.config ?? loadConfig();
  const ownsPool = !dependencies.pool;
  const pool = dependencies.pool ?? createPool(config);
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    await assertIdV2SchemaReady(pool);
    if (options.action === 'status') {
      const output = {
        status: await readIdentityMigrationStatus(pool),
        recentRuns: await recentRuns(pool, options.userId),
      };
      stdout(JSON.stringify(output, null, options.json ? 0 : 2));
      return 0;
    }

    if (options.action === 'migrate') {
      const results = await migrateUsers(pool, config, options, stderr);
      const status = await refreshIdentityContractStatus(pool);
      stdout(JSON.stringify({ results, status }, null, options.json ? 0 : 2));
      return [...results.provider, ...results.books].some((result) => isIncompleteStatus(result.status)) ? 2 : 0;
    }

    if (!options.userId) throw new IdV2MigrationError('cli_scope_required', 'The command requires --user.');
    if (options.action === 'rollback-provider') {
      const result = await rollbackProviderIdentities({
        pool,
        options: { userId: options.userId },
        logger: { info: stderr, warn: stderr },
      });
      await markIdentityContractExpanded(pool);
      stdout(JSON.stringify({ result }, null, options.json ? 0 : 2));
      return 0;
    }

    if (!options.bookId) throw new IdV2MigrationError('cli_scope_required', 'The command requires --book.');
    const service = new IdV2MigrationService({
      pool,
      identities: idV2IdentityFactory,
      sourceLoader: new S3BookSourceLoader(config),
      logger: { info: stderr, warn: stderr },
    });
    const result =
      options.action === 'rollback-book'
        ? await service.rollbackBook({ userId: options.userId, sourceBookId: options.bookId })
        : await service.recoverForward({ userId: options.userId, sourceBookId: options.bookId });
    if (options.action === 'rollback-book') await markIdentityContractExpanded(pool);
    stdout(JSON.stringify({ result }, null, options.json ? 0 : 2));
    return 0;
  } finally {
    if (ownsPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runIdV2MigrationCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof IdV2MigrationError ? error.message : 'ID v2 migration command failed.';
      console.error(message);
      process.exitCode = 1;
    },
  );
}
