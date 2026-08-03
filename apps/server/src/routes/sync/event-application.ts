import pg from 'pg';
import type { SyncEvent } from '@noveldesk/contracts/sync';
import { persistAiTtsSyncEvent } from './ai-tts-sync-persistence.js';
import { persistReaderSyncEvent } from './reader-entity-persistence.js';

export async function applySyncEvent(client: pg.PoolClient, userId: string, event: SyncEvent): Promise<void> {
  if (await persistReaderSyncEvent(client, userId, event)) return;
  await persistAiTtsSyncEvent(client, userId, event);
}
