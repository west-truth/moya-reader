import pg from 'pg';
import { resolveSyncContract, SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from '../../../../../src/sync/contract.js';
import {
  syncEventSourceBookId,
  syncHashForContract,
  syncPageHashForContract,
  translateSyncEventIdentity,
  type ContentHashTranslationInput,
  type SegmentHashTranslationInput,
  type SyncEventIdentityTranslationAdapter,
  type SyncIdentityEntityType,
} from '../../../../../src/sync/event-contract-translation.js';
import type { ResolvedSyncContract, SyncEvent } from '@noveldesk/contracts/sync';
import { validateV2SyncEvent } from '../../../../../src/sync/event-contract-validation.js';

export type SyncQueryRunner = Pick<pg.Pool, 'query'>;

interface BookAliasRow extends pg.QueryResultRow {
  source_book_id: string;
  canonical_book_id: string;
}

interface EntityAliasRow extends pg.QueryResultRow {
  source_id: string;
  canonical_id: string;
}

const preservedSentinels = new Set(['narrator', 'system', 'unknown']);

export class SyncIdentityTranslationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncIdentityTranslationError';
  }
}

class PgSyncAliasContext {
  private readonly entityCache = new Map<string, Promise<EntityAliasRow>>();

  private constructor(
    private readonly runner: SyncQueryRunner,
    private readonly userId: string,
    readonly bookAlias: BookAliasRow,
    readonly targetContract: ResolvedSyncContract,
  ) {}

  static async load(
    runner: SyncQueryRunner,
    userId: string,
    sourceOrCanonicalBookId: string,
    targetContract: ResolvedSyncContract,
  ): Promise<PgSyncAliasContext> {
    const result = await runner.query<BookAliasRow>(
      `
        select source_book_id, canonical_book_id
        from id_v2_book_aliases
        where user_id = $1
          and status = 'active'
          and alias_complete
          and (source_book_id = $2 or canonical_book_id = $2)
        limit 1
      `,
      [userId, sourceOrCanonicalBookId],
    );
    const alias = result.rows[0];
    if (!alias) {
      throw new SyncIdentityTranslationError(
        'book_alias_missing',
        `Book ${sourceOrCanonicalBookId} has no complete v1/v2 PostgreSQL alias.`,
      );
    }
    return new PgSyncAliasContext(runner, userId, alias, targetContract);
  }

  private entityAlias(entityType: SyncIdentityEntityType, value: string): Promise<EntityAliasRow> {
    const key = `${entityType}:${value}`;
    const existing = this.entityCache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const result = await this.runner.query<EntityAliasRow>(
        `
          select source_id, canonical_id
          from id_v2_entity_aliases
          where user_id = $1
            and source_book_id = $2
            and entity_type = $3
            and status = 'active'
            and alias_complete
            and (source_id = $4 or canonical_id = $4)
          limit 1
        `,
        [this.userId, this.bookAlias.source_book_id, entityType, value],
      );
      const alias = result.rows[0];
      if (!alias) {
        throw new SyncIdentityTranslationError(
          'child_alias_missing',
          `${entityType} ${value} has no complete v1/v2 PostgreSQL alias.`,
        );
      }
      return alias;
    })();
    this.entityCache.set(key, pending);
    return pending;
  }

  async map(entityType: SyncIdentityEntityType, value: string): Promise<string> {
    if (preservedSentinels.has(value)) return value;
    if (entityType === 'book') {
      return this.targetContract.contractVersion === 2
        ? this.bookAlias.canonical_book_id
        : this.bookAlias.source_book_id;
    }
    const alias = await this.entityAlias(entityType, value);
    return this.targetContract.contractVersion === 2 ? alias.canonical_id : alias.source_id;
  }

  async canonical(entityType: SyncIdentityEntityType, value: string): Promise<string> {
    if (preservedSentinels.has(value)) return value;
    if (entityType === 'book') return this.bookAlias.canonical_book_id;
    return (await this.entityAlias(entityType, value)).canonical_id;
  }
}

class PgEventTranslationAdapter implements SyncEventIdentityTranslationAdapter {
  constructor(
    readonly targetContract: ResolvedSyncContract,
    private readonly runner: SyncQueryRunner,
    private readonly userId: string,
    private readonly context: PgSyncAliasContext | undefined,
    private readonly sourceEventId?: string,
  ) {}

  mapId(entityType: SyncIdentityEntityType, value: string): Promise<string> {
    if (!this.context) {
      throw new SyncIdentityTranslationError(
        'book_alias_missing',
        `${entityType} ${value} cannot be translated without a complete book alias.`,
      );
    }
    return this.context.map(entityType, value);
  }

  async mapEventId(sourceEvent: SyncEvent, translatedEvent: SyncEvent): Promise<string> {
    if (this.targetContract.contractVersion === 1) {
      if (this.sourceEventId) return this.sourceEventId;
    }
    void translatedEvent;
    if (this.context) return this.context.map('sync_event', sourceEvent.id);
    const result = await this.runner.query<EntityAliasRow>(
      `
        select source_id, canonical_id
        from id_v2_entity_aliases
        where user_id = $1
          and entity_type = 'sync_event'
          and status = 'active'
          and alias_complete
          and (source_id = $2 or canonical_id = $2)
        limit 2
      `,
      [this.userId, sourceEvent.id],
    );
    if (result.rows.length !== 1) {
      throw new SyncIdentityTranslationError(
        'sync_upgrade_required',
        `Sync event ${sourceEvent.id} has no unique complete PostgreSQL event alias.`,
      );
    }
    return this.targetContract.contractVersion === 2 ? result.rows[0].canonical_id : result.rows[0].source_id;
  }

  async mapSegmentTextHash(input: SegmentHashTranslationInput): Promise<string> {
    if (!this.context) {
      throw new SyncIdentityTranslationError(
        'segment_alias_missing',
        'A segment hash cannot be translated without complete book aliases.',
      );
    }
    const sourceParagraphId = String(input.source.paragraphId ?? input.translated.paragraphId ?? '');
    const canonicalParagraphId = await this.context.canonical('paragraph', sourceParagraphId);
    const canonicalBookId = this.context.bookAlias.canonical_book_id;
    const result = await this.runner.query<{ text: string }>(
      `
        select text
        from paragraph_search
        where book_id = $1 and paragraph_id = $2
        limit 1
      `,
      [canonicalBookId, canonicalParagraphId],
    );
    const text = result.rows[0]?.text;
    const startOffset = Number(input.source.startOffset);
    const endOffset = Number(input.source.endOffset);
    if (!text || !Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset > text.length) {
      throw new SyncIdentityTranslationError(
        'segment_text_missing',
        `Segment paragraph ${canonicalParagraphId} is unavailable for hash translation.`,
      );
    }
    const segmentText = text.slice(startOffset, endOffset);
    return syncHashForContract(this.targetContract, segmentText);
  }

  async mapContentHash(input: ContentHashTranslationInput): Promise<string> {
    if (!this.context || !input.entityType) {
      throw new SyncIdentityTranslationError(
        'content_hash_unverifiable',
        `${input.field} cannot be translated without canonical content.`,
      );
    }
    const sourceId = String(input.source.id ?? input.translated.id ?? '');
    if (input.entityType === 'paragraph' && input.field === 'textHash') {
      const paragraphId = await this.context.canonical('paragraph', sourceId);
      const result = await this.runner.query<{ text: string }>(
        'select text from paragraph_search where book_id = $1 and paragraph_id = $2 limit 1',
        [this.context.bookAlias.canonical_book_id, paragraphId],
      );
      if (result.rows[0]) return syncHashForContract(this.targetContract, result.rows[0].text);
    }
    if (input.entityType === 'page' && input.field === 'textHash') {
      const pageId = await this.context.canonical('page', sourceId);
      const result = await this.runner.query<{ paragraphs: unknown }>(
        'select paragraphs from paragraph_pages where book_id = $1 and id = $2 limit 1',
        [this.context.bookAlias.canonical_book_id, pageId],
      );
      const paragraphs = Array.isArray(result.rows[0]?.paragraphs) ? result.rows[0].paragraphs : [];
      const paragraphHashes = paragraphs
        .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
        .map((paragraph) =>
          typeof paragraph.text === 'string' ? syncHashForContract(this.targetContract, paragraph.text) : undefined,
        )
        .filter((hash): hash is string => Boolean(hash));
      if (paragraphHashes.length === paragraphs.length) {
        return syncPageHashForContract(this.targetContract, paragraphHashes);
      }
    }
    throw new SyncIdentityTranslationError(
      'content_hash_unverifiable',
      `${input.field} cannot be recomputed from canonical server content.`,
    );
  }
}

async function adapterForEvent(
  runner: SyncQueryRunner,
  userId: string,
  event: SyncEvent,
  targetContract: ResolvedSyncContract,
  sourceEventId?: string,
): Promise<PgEventTranslationAdapter> {
  const bookId = syncEventSourceBookId(event);
  const context = bookId ? await PgSyncAliasContext.load(runner, userId, bookId, targetContract) : undefined;
  return new PgEventTranslationAdapter(targetContract, runner, userId, context, sourceEventId);
}

export interface CanonicalIncomingSyncEvent {
  event: SyncEvent;
  sourceEventId: string;
  sourceContract: ResolvedSyncContract;
}

export async function canonicalizeIncomingSyncEvent(
  runner: SyncQueryRunner,
  userId: string,
  sourceEvent: SyncEvent,
): Promise<CanonicalIncomingSyncEvent> {
  const sourceContract = resolveSyncContract(sourceEvent);
  if (sourceContract.contractVersion === 2) {
    const event = { ...sourceEvent, ...SYNC_CONTRACT_V2 };
    validateV2SyncEvent(event);
    return { event, sourceEventId: sourceEvent.id, sourceContract };
  }
  const adapter = await adapterForEvent(runner, userId, sourceEvent, SYNC_CONTRACT_V2);
  const event = await translateSyncEventIdentity(sourceEvent, adapter);
  validateV2SyncEvent(event);
  return {
    event,
    sourceEventId: sourceEvent.id,
    sourceContract,
  };
}

export async function translateCanonicalSyncEventToV1(
  runner: SyncQueryRunner,
  userId: string,
  event: SyncEvent,
  sourceEventId?: string,
): Promise<SyncEvent> {
  const adapter = await adapterForEvent(runner, userId, event, SYNC_CONTRACT_V1, sourceEventId);
  return translateSyncEventIdentity(event, adapter);
}
