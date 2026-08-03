import { integrityHashVersion, tagLegacySha256Hash } from '../../domain/id-hash-contract';
import { parsedNovelId } from '../../domain/parser/entity-identities';
import type { Novel } from '../../domain/types';
import { openReaderDb } from '../reader-database';
import type { IdV2MappingRecord } from './contracts';
import { ID_V2_MIGRATION_STORES } from './contracts';
import { migrationIdentityKey } from './content-plan';
import { readOne, requestToPromise, transactionDone } from './indexeddb';

function canonicalIdentityHash(value: string): string | undefined {
  const version = integrityHashVersion(value);
  if (version === 'v2-sha256-tagged') return value;
  if (version === 'v1-sha256') return tagLegacySha256Hash(value);
  return undefined;
}

export async function resolveCanonicalNovelIdentityInDatabase(
  db: IDBDatabase,
  sourceFileName: string,
  normalizedTextHash: string,
): Promise<string | undefined> {
  const canonicalHash = canonicalIdentityHash(normalizedTextHash);
  if (!canonicalHash) return undefined;
  const identityKey = migrationIdentityKey(sourceFileName, canonicalHash);
  const tx = db.transaction(ID_V2_MIGRATION_STORES.mappings, 'readonly');
  const done = transactionDone(tx);
  const mapping = await requestToPromise<IdV2MappingRecord | undefined>(
    tx.objectStore(ID_V2_MIGRATION_STORES.mappings).index('identityKey').get(identityKey),
  );
  await done;
  if (mapping) return mapping.newId;

  const derivedId = parsedNovelId(sourceFileName, canonicalHash);
  const existing = await readOne<Novel>(db, 'novels', derivedId);
  return existing?.id;
}

export async function resolveCanonicalNovelIdentity(
  sourceFileName: string,
  normalizedTextHash: string,
): Promise<string | undefined> {
  return resolveCanonicalNovelIdentityInDatabase(await openReaderDb(), sourceFileName, normalizedTextHash);
}
