import { persistentId128 } from '@noveldesk/text-core/hash';
import { characterGraphIntegrityHash } from '@noveldesk/text-core/identity/ai';
import type { ProviderJobRow } from '../provider-jobs/contracts.js';
import {
  replaceCharacterAliases,
  replaceCharacterRelations,
  upsertCharacters,
} from '../provider-jobs/entity-write-repository.js';
import { loadCharacterGraph } from '../provider-jobs/job-data-loader.js';
import type pg from 'pg';
import type { BookReplacementSummary, PreparedBookReplacement } from './contracts.js';
import {
  clearQuarantinedCanonicalState,
  fenceBookWorkflowsAndJobs,
  finalizeReplacementRun,
  insertPreparingContentRevision,
  insertReplacementGraphRevision,
  lockExistingBookRevision,
  quarantineBookDerivedState,
  restoreExactAnchoredReaderState as restoreExactAnchoredReaderStateRows,
} from './repository.js';
import {
  remapConfirmedCharacterRelations,
  remapExactAnchoredCharacters,
  remapExactAnchoredCorrections,
  remapExactAnchoredVoiceProfiles,
} from './remap-repository.js';

export interface PrepareBookReplacementInput {
  readonly userId: string;
  readonly bookId: string;
  readonly sourceObjectId: string;
  readonly sourceRawTextHash: string;
  readonly normalizedTextHash: string;
  readonly sourceFileName: string;
  readonly sourceEncoding?: string;
}

export interface BookReplacementPreparation {
  readonly replacement: PreparedBookReplacement;
  readonly cancelledWorkflowCount: number;
  readonly cancelledProviderJobCount: number;
  readonly quarantinedEntityCount: number;
}

export async function prepareBookReplacement(
  client: pg.PoolClient,
  input: PrepareBookReplacementInput,
): Promise<BookReplacementPreparation | undefined> {
  const existing = await lockExistingBookRevision(client, input.userId, input.bookId);
  if (!existing) return undefined;
  const toContentRevisionNumber = existing.contentRevisionNumber + 1;
  const toContentRevisionId = persistentId128('book_content_revision', [
    input.bookId,
    existing.contentRevisionId,
    String(toContentRevisionNumber),
    input.sourceRawTextHash,
    input.normalizedTextHash,
  ]);
  const runId = persistentId128('book_replacement_run', [
    input.bookId,
    existing.contentRevisionId,
    toContentRevisionId,
    String(existing.revisionFence),
  ]);
  const replacement: PreparedBookReplacement = {
    runId,
    bookId: input.bookId,
    userId: input.userId,
    fromContentRevisionId: existing.contentRevisionId,
    toContentRevisionId,
    toContentRevisionNumber,
    fromGraphRevisionId: existing.graphRevisionId,
    expectedRevisionFence: existing.revisionFence,
    normalizedTextHash: input.normalizedTextHash,
  };
  await insertPreparingContentRevision(client, {
    ...replacement,
    sourceObjectId: input.sourceObjectId,
    sourceRawTextHash: input.sourceRawTextHash,
    sourceFileName: input.sourceFileName,
    sourceEncoding: input.sourceEncoding,
  });
  const quarantinedEntityCount = await quarantineBookDerivedState(client, replacement);
  const cancelled = await fenceBookWorkflowsAndJobs(client, replacement);
  await clearQuarantinedCanonicalState(client, replacement);
  return {
    replacement,
    cancelledWorkflowCount: cancelled.cancelledWorkflowCount,
    cancelledProviderJobCount: cancelled.cancelledProviderJobCount,
    quarantinedEntityCount,
  };
}

export async function finalizeBookReplacement(
  client: pg.PoolClient,
  preparation: BookReplacementPreparation,
): Promise<BookReplacementSummary> {
  const replacement = preparation.replacement;
  const remappedCharacterCount = await remapExactAnchoredCharacters(client, replacement);
  const remappedRelationCount = await remapConfirmedCharacterRelations(client, replacement);
  const remappedVoiceProfileCount = await remapExactAnchoredVoiceProfiles(client, replacement);
  const remappedCorrectionCount = await remapExactAnchoredCorrections(client, replacement);

  const graphJob: ProviderJobRow = {
    id: `book_replacement:${replacement.runId}`,
    user_id: replacement.userId,
    book_id: replacement.bookId,
    chapter_id: null,
    job_type: 'book_replacement_graph',
    provider_id: 'book_revision_service',
    model_id: null,
    input_hash: replacement.toContentRevisionId,
    status: 'running',
    progress: {},
  };
  const graph = await loadCharacterGraph(client, graphJob);
  const graphFingerprint = characterGraphIntegrityHash(graph);
  const graphRevisionId = await insertReplacementGraphRevision(client, replacement, graph, graphFingerprint);
  await upsertCharacters(client, replacement.bookId, replacement.userId, graph.characters, {
    graphRevisionId,
    contentRevisionId: replacement.toContentRevisionId,
  });
  await replaceCharacterAliases(client, replacement.bookId, graph.characters, graphRevisionId);
  await replaceCharacterRelations(client, replacement.bookId, graph.relations, graphRevisionId);

  const summary: BookReplacementSummary = {
    cancelledWorkflowCount: preparation.cancelledWorkflowCount,
    cancelledProviderJobCount: preparation.cancelledProviderJobCount,
    quarantinedEntityCount: preparation.quarantinedEntityCount,
    remappedCharacterCount,
    remappedRelationCount,
    remappedVoiceProfileCount,
    remappedCorrectionCount,
  };
  await finalizeReplacementRun(client, replacement, graphRevisionId, summary);
  return summary;
}

export async function restoreExactAnchoredReaderState(
  client: pg.PoolClient,
  preparation: BookReplacementPreparation,
): Promise<number> {
  return restoreExactAnchoredReaderStateRows(client, preparation.replacement);
}
