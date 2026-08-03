import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { hasSecretLikeKey } from '../../providers/server-provider-settings.js';
import {
  loadHostedVoiceCastingState,
  saveHostedVoiceCastingState,
  VoiceCastingRevisionConflictError,
  type VoiceCastingStateProjections,
} from '../../services/voice-casting-state-service.js';
import {
  VOICE_CASTING_VERSION,
  type VoiceCastingStateV1,
  type VoiceCastingWorkspaceUserArtifactsV1,
} from '../../../../../src/providers/voice-casting/contracts';
import { projectAcceptedSpeakerUtterance } from '../../../../../src/providers/voice-casting/importance';
import { assertVoiceCastingState } from '../../../../../src/providers/voice-casting/state';
import type { AcceptedSpeakerProvenanceV1 } from '../../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import { recordBody } from './request-contracts.js';
import { bookExists } from './workflow-query-service.js';

const MAX_VOICE_CASTING_BODY_BYTES = 512 * 1024;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_TOTAL_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 12;
const MAX_OBJECT_KEYS = 100;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 4_096;

const artifactArrayFields = ['assignments', 'reviews'] as const;

interface VoiceCastingDerivedArtifactsInput {
  readonly importanceProfiles: readonly unknown[];
  readonly traitEvidence: readonly unknown[];
  readonly traitProfiles: readonly unknown[];
  readonly pools: readonly unknown[];
}

interface SourceRow extends pg.QueryResultRow {
  provenance: AcceptedSpeakerProvenanceV1;
  start_offset: number | string;
  end_offset: number | string;
}

function validateJsonLimits(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_TOTAL_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (typeof item === 'string') return item.length <= MAX_STRING_LENGTH;
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return true;
    if (Array.isArray(item)) return item.length <= MAX_ARRAY_ITEMS && item.every((child) => visit(child, depth + 1));
    if (typeof item !== 'object') return false;
    const entries = Object.entries(item as Record<string, unknown>);
    return (
      entries.length <= MAX_OBJECT_KEYS &&
      entries.every(([key, child]) => key.length <= MAX_KEY_LENGTH && visit(child, depth + 1))
    );
  };
  return visit(value, 0);
}

function nonEmptyBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_STRING_LENGTH;
}

function artifactArray(
  state: Record<string, unknown>,
  field: (typeof artifactArrayFields)[number],
): unknown[] | undefined {
  const value = state[field];
  return Array.isArray(value) ? value : undefined;
}

function hasValidArtifactScope(item: unknown, bookId: string, contentRevisionId: string): boolean {
  const artifact = recordBody(item);
  return Boolean(
    artifact &&
    artifact.version === VOICE_CASTING_VERSION &&
    artifact.bookId === bookId &&
    artifact.contentRevisionId === contentRevisionId &&
    nonEmptyBoundedString(artifact.id) &&
    nonEmptyBoundedString(artifact.revision) &&
    nonEmptyBoundedString(artifact.fingerprint) &&
    typeof artifact.userPinned === 'boolean',
  );
}

function validateState(value: unknown, bookId: string): VoiceCastingStateV1 | undefined {
  const state = recordBody(value);
  if (!state || state.version !== VOICE_CASTING_VERSION || state.bookId !== bookId) return undefined;
  if (!validateJsonLimits(value) || hasSecretLikeKey(value)) return undefined;
  if (
    !nonEmptyBoundedString(state.id) ||
    !nonEmptyBoundedString(state.contentRevisionId) ||
    !nonEmptyBoundedString(state.revision) ||
    !nonEmptyBoundedString(state.fingerprint) ||
    typeof state.userPinned !== 'boolean' ||
    !['staging', 'active', 'stale'].includes(String(state.status))
  ) {
    return undefined;
  }
  for (const field of [
    'importanceRevision',
    'traitRevision',
    'poolRevision',
    'voiceProfileRevision',
    'assignmentRevision',
  ]) {
    if (!nonEmptyBoundedString(state[field])) return undefined;
  }
  if (!Array.isArray(state.assignments) || !Array.isArray(state.reviews)) return undefined;

  for (const field of artifactArrayFields) {
    const rows = artifactArray(state, field);
    if ((field === 'assignments' || field === 'reviews') && !rows) return undefined;
    if (
      rows &&
      (rows.length > MAX_ARRAY_ITEMS ||
        rows.some((item) => !hasValidArtifactScope(item, bookId, state.contentRevisionId as string)))
    ) {
      return undefined;
    }
  }
  try {
    assertVoiceCastingState(value);
  } catch {
    return undefined;
  }
  return value as VoiceCastingStateV1;
}

function validateUserArtifacts(
  value: unknown,
  bookId: string,
  contentRevisionId: string,
): VoiceCastingWorkspaceUserArtifactsV1 | undefined {
  const artifacts = recordBody(value);
  if (!artifacts) return undefined;
  const { voiceProfileIds, pools, overrides, traitEvidence } = artifacts;
  if (
    !Array.isArray(voiceProfileIds) ||
    voiceProfileIds.length > MAX_ARRAY_ITEMS ||
    voiceProfileIds.some((item) => !nonEmptyBoundedString(item)) ||
    !Array.isArray(pools) ||
    !Array.isArray(overrides) ||
    !Array.isArray(traitEvidence)
  ) {
    return undefined;
  }
  for (const rows of [pools, overrides, traitEvidence]) {
    if (rows.length > MAX_ARRAY_ITEMS || rows.some((item) => !hasValidArtifactScope(item, bookId, contentRevisionId))) {
      return undefined;
    }
  }
  if (
    pools.some((item) => recordBody(item)?.userPinned !== true) ||
    overrides.some((item) => recordBody(item)?.userPinned !== true) ||
    traitEvidence.some((item) => recordBody(item)?.userPinned !== true)
  ) {
    return undefined;
  }
  if (traitEvidence.some((item) => recordBody(item)?.evidenceKind !== 'user')) return undefined;
  return value as unknown as VoiceCastingWorkspaceUserArtifactsV1;
}

function validateDerivedArtifacts(
  value: unknown,
  bookId: string,
  contentRevisionId: string,
): VoiceCastingDerivedArtifactsInput | undefined {
  const artifacts = recordBody(value);
  if (!artifacts) return undefined;
  const { importanceProfiles, traitEvidence, traitProfiles, pools } = artifacts;
  if (
    !Array.isArray(importanceProfiles) ||
    !Array.isArray(traitEvidence) ||
    !Array.isArray(traitProfiles) ||
    !Array.isArray(pools)
  ) {
    return undefined;
  }
  for (const rows of [importanceProfiles, traitEvidence, traitProfiles, pools]) {
    if (rows.length > MAX_ARRAY_ITEMS || rows.some((item) => !hasValidArtifactScope(item, bookId, contentRevisionId))) {
      return undefined;
    }
  }
  if (traitEvidence.some((item) => recordBody(item)?.evidenceKind === 'user')) return undefined;
  if (pools.some((item) => recordBody(item)?.userPinned !== false)) return undefined;
  return value as unknown as VoiceCastingDerivedArtifactsInput;
}

function projectionsForState(
  state: VoiceCastingStateV1,
  userArtifacts: VoiceCastingWorkspaceUserArtifactsV1,
  derivedArtifacts: VoiceCastingDerivedArtifactsInput,
): VoiceCastingStateProjections {
  const pinnedAssignments = state.assignments.filter((item) => item.userPinned);
  const automaticAssignments = state.assignments.filter((item) => !item.userPinned);
  return {
    userAuthored: { ...userArtifacts },
    derived: {
      ...derivedArtifacts,
      automaticAssignments,
      pinnedAssignments,
      reviews: state.reviews,
    },
  };
}

function expectedRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function registerVoiceCastingRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/voice-casting', async (request, reply) => {
    const { bookId } = request.params;
    if (!(await bookExists(pool, config, bookId))) return reply.code(404).send({ error: 'book not found' });
    return loadHostedVoiceCastingState(pool, config.defaultUserId, bookId);
  });

  app.put<{
    Params: { bookId: string };
    Body: { expectedRevision?: unknown; state?: unknown; userArtifacts?: unknown; derivedArtifacts?: unknown };
  }>('/api/books/:bookId/voice-casting', { bodyLimit: MAX_VOICE_CASTING_BODY_BYTES }, async (request, reply) => {
    const { bookId } = request.params;
    if (!(await bookExists(pool, config, bookId))) return reply.code(404).send({ error: 'book not found' });
    const body = recordBody(request.body);
    if (!body || !validateJsonLimits(body) || hasSecretLikeKey(body)) {
      return reply.code(400).send({ error: 'voice casting payload is invalid' });
    }
    const revision = expectedRevision(body?.expectedRevision);
    if (revision === undefined) {
      return reply.code(400).send({ error: 'expectedRevision must be a non-negative integer' });
    }
    const state = validateState(body?.state, bookId);
    if (!state) return reply.code(400).send({ error: 'voice casting state is invalid' });
    const userArtifacts = validateUserArtifacts(body?.userArtifacts, bookId, state.contentRevisionId);
    const derivedArtifacts = validateDerivedArtifacts(body?.derivedArtifacts, bookId, state.contentRevisionId);
    if (!userArtifacts || !derivedArtifacts) {
      return reply.code(400).send({ error: 'voice casting artifact payloads are invalid' });
    }
    try {
      return await saveHostedVoiceCastingState(pool, {
        userId: config.defaultUserId,
        bookId,
        expectedRevision: revision,
        state,
        projections: projectionsForState(state, userArtifacts, derivedArtifacts),
      });
    } catch (error) {
      if (error instanceof VoiceCastingRevisionConflictError) {
        return reply.code(409).send({
          error: 'voice casting revision changed',
          expectedRevision: error.expectedRevision,
          revision: error.currentRevision,
        });
      }
      throw error;
    }
  });

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/voice-casting/source', async (request, reply) => {
    const { bookId } = request.params;
    if (!(await bookExists(pool, config, bookId))) return reply.code(404).send({ error: 'book not found' });
    const result = await pool.query<SourceRow>(
      `
        select provenance.payload as provenance,
               segment.start_offset,
               segment.end_offset
        from accepted_speaker_provenance provenance
        join library_books book
          on book.id = provenance.book_id
         and book.user_id = provenance.user_id
         and book.active_content_revision_id = provenance.content_revision_id
        join labeled_segments segment
          on segment.id = provenance.segment_id
         and segment.book_id = provenance.book_id
         and segment.chapter_id = provenance.chapter_id
         and segment.paragraph_id = provenance.paragraph_id
        where provenance.user_id = $1
          and provenance.book_id = $2
          and provenance.status = 'active'
        order by provenance.narrative_order, provenance.id
      `,
      [config.defaultUserId, bookId],
    );
    return {
      utterances: result.rows.map((row) => {
        const sourceStartOffset = Number(row.start_offset);
        const sourceEndOffset = Number(row.end_offset);
        return projectAcceptedSpeakerUtterance({
          provenance: row.provenance,
          sourceStartOffset,
          sourceEndOffset,
          spokenCharacterCount: sourceEndOffset - sourceStartOffset,
        });
      }),
    };
  });
}
