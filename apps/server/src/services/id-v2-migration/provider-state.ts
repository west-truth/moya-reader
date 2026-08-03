import type pg from 'pg';
import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import { syncPayloadIntegrityHash } from '@noveldesk/text-core/identity/sync';
import {
  HASH_V2_CONTRACT,
  ID_V2_CONTRACT,
  IdV2MigrationError,
  type GlobalEntityType,
  type IdV2IdentityFactory,
} from './contracts.js';
import { isoValue, optionalText, record, textValue, type JsonRecord } from './safe-values.js';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}

interface JsonRow extends pg.QueryResultRow {
  row_data: unknown;
}

export const PROVIDER_BACKUP_TABLES = ['provider_settings', 'provider_secrets', 'sync_events'] as const;
export type ProviderBackupTable = (typeof PROVIDER_BACKUP_TABLES)[number];
export type ProviderSourceRows = Record<ProviderBackupTable, JsonRecord[]>;

export interface GlobalAliasPlan {
  readonly entityType: GlobalEntityType;
  readonly sourceId: string;
  readonly canonicalId: string;
}

export interface ProviderMigrationPlan {
  readonly sourceRows: ProviderSourceRows;
  readonly targetRows: ProviderSourceRows;
  readonly aliases: readonly GlobalAliasPlan[];
  readonly sourceStateHash: string;
  readonly report: Record<string, unknown>;
}

async function jsonRows(queryable: Queryable, sql: string, userId: string): Promise<JsonRecord[]> {
  const result = await queryable.query<JsonRow>(sql, [userId]);
  return result.rows.map((row, index) => record(row.row_data, `provider snapshot row ${index}`));
}

export async function loadProviderSourceRows(
  queryable: Queryable,
  userId: string,
  lockRows = false,
): Promise<ProviderSourceRows> {
  const suffix = lockRows ? 'for update' : '';
  const providerSettings = await jsonRows(
    queryable,
    `select to_jsonb(row_data) as row_data from provider_settings row_data
     where row_data.user_id = $1 order by row_data.id ${suffix}`,
    userId,
  );
  const providerSecrets = await jsonRows(
    queryable,
    `select to_jsonb(row_data) as row_data from provider_secrets row_data
     where row_data.user_id = $1 order by row_data.id ${suffix}`,
    userId,
  );
  const syncEvents = await jsonRows(
    queryable,
    `select to_jsonb(row_data) as row_data from sync_events row_data
     where row_data.user_id = $1 and row_data.book_id is null order by row_data.sequence ${suffix}`,
    userId,
  );
  return {
    provider_settings: providerSettings,
    provider_secrets: providerSecrets,
    sync_events: syncEvents,
  };
}

export function providerStateHash(rows: ProviderSourceRows): string {
  return structuredIntegrityHash(rows);
}

function registerAlias(
  aliases: GlobalAliasPlan[],
  reverse: Map<string, string>,
  entityType: GlobalEntityType,
  sourceId: string,
  canonicalId: string,
): void {
  const previous = reverse.get(canonicalId);
  if (previous && previous !== sourceId) {
    throw new IdV2MigrationError('provider_identity_collision', 'Provider rows share one canonical identity.', {
      entityType,
      sourceId,
    });
  }
  reverse.set(canonicalId, sourceId);
  aliases.push({ entityType, sourceId, canonicalId });
}

function remapGlobalJson(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapGlobalJson(item, aliases));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      aliases.get(key) ?? key,
      remapGlobalJson(child, aliases),
    ]),
  );
}

function remapRevision(revision: unknown, payload: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return null;
  return {
    ...(remapGlobalJson(revision, aliases) as Record<string, unknown>),
    payloadHash: syncPayloadIntegrityHash(payload),
  };
}

export function buildProviderMigrationPlan(
  rows: ProviderSourceRows,
  identities: IdV2IdentityFactory,
): ProviderMigrationPlan {
  const aliases: GlobalAliasPlan[] = [];
  const reverse = new Map<string, string>();
  const directAliases = new Map<string, string>();

  const settings = rows.provider_settings.map((row) => {
    const sourceId = textValue(row.id, 'provider_settings.id');
    const canonicalId = identities.providerSettings(
      textValue(row.user_id, 'provider_settings.user_id'),
      textValue(row.scope, 'provider_settings.scope'),
    );
    registerAlias(aliases, reverse, 'provider_settings', sourceId, canonicalId);
    directAliases.set(sourceId, canonicalId);
    return { ...row, id: canonicalId, id_contract: ID_V2_CONTRACT };
  });

  const secrets = rows.provider_secrets.map((row) => {
    const sourceId = textValue(row.id, 'provider_secrets.id');
    const canonicalId = identities.providerSecret(
      textValue(row.user_id, 'provider_secrets.user_id'),
      textValue(row.scope, 'provider_secrets.scope'),
      textValue(row.provider_id, 'provider_secrets.provider_id'),
      textValue(row.secret_name, 'provider_secrets.secret_name'),
    );
    registerAlias(aliases, reverse, 'provider_secret', sourceId, canonicalId);
    directAliases.set(sourceId, canonicalId);
    return { ...row, id: canonicalId, id_contract: ID_V2_CONTRACT };
  });

  const syncEvents = rows.sync_events.map((row) => {
    const sourceId = textValue(row.id, 'sync_events.id');
    const payload = remapGlobalJson(row.payload, directAliases);
    const payloadHash = syncPayloadIntegrityHash(payload);
    const entityId = optionalText(row.entity_id);
    const canonicalId = identities.syncEvent({
      userId: textValue(row.user_id, 'sync_events.user_id'),
      deviceId: optionalText(row.device_id),
      type: textValue(row.type, 'sync_events.type'),
      entityId: entityId ? (directAliases.get(entityId) ?? entityId) : undefined,
      createdAt: isoValue(row.created_at, 'sync_events.created_at'),
      payloadHash,
      sourceId,
    });
    registerAlias(aliases, reverse, 'sync_event', sourceId, canonicalId);
    return {
      ...row,
      id: canonicalId,
      entity_id: entityId ? (directAliases.get(entityId) ?? entityId) : null,
      payload,
      revision: remapRevision(row.revision, payload, directAliases),
      id_contract: ID_V2_CONTRACT,
      hash_contract: HASH_V2_CONTRACT,
    };
  });

  const targetRows = {
    provider_settings: settings,
    provider_secrets: secrets,
    sync_events: syncEvents,
  };
  return {
    sourceRows: rows,
    targetRows,
    aliases,
    sourceStateHash: providerStateHash(rows),
    report: {
      settingsMigrated: settings.length,
      secretsMigrated: secrets.length,
      syncEventsMigrated: syncEvents.length,
      aliasCount: aliases.length,
      idContract: ID_V2_CONTRACT,
      hashContract: HASH_V2_CONTRACT,
    },
  };
}

export function providerRowsNeedMigration(rows: ProviderSourceRows): boolean {
  return (
    rows.provider_settings.some((row) => row.id_contract !== ID_V2_CONTRACT) ||
    rows.provider_secrets.some((row) => row.id_contract !== ID_V2_CONTRACT) ||
    rows.sync_events.some((row) => row.id_contract !== ID_V2_CONTRACT || row.hash_contract !== HASH_V2_CONTRACT)
  );
}

export async function activeProviderJobCount(queryable: Queryable, userId: string): Promise<number> {
  const result = await queryable.query<{ count: string | number }>(
    `select count(*) as count from provider_jobs
     where user_id = $1 and status in ('queued', 'running')`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
