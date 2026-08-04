import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createSpeakerArtifactDependency } from '../../../../src/providers/speaker-attribution/artifact-dependency';
import { createAcceptedSpeakerProvenance } from '../../../../src/providers/speaker-attribution/accepted-speaker-provenance';
import {
  createSpeakerIdentityEdge,
  createSpeakerVoiceIdentity,
} from '../../../../src/providers/speaker-attribution/speaker-identity';
import { createSpeakerSequenceDecisionRecord } from '../../../../src/providers/speaker-attribution/workflow-state';
import {
  appendHostedSpeakerIdentityEdges,
  appendHostedSpeakerVoiceIdentities,
  markHostedSpeakerArtifactDependenciesStale,
  listHostedAcceptedSpeakerProvenance,
  putHostedSpeakerArtifactDependencies,
  rebaseHostedSpeakerArtifactDependencies,
  replaceHostedSpeakerSequenceDecisions,
  replaceHostedAcceptedSpeakerProvenanceForParagraphs,
  type SpeakerWorkflowStateQueryable,
} from './speaker-workflow-state-service.js';

function result<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

class MemorySpeakerWorkflowDb implements SpeakerWorkflowStateQueryable {
  readonly queries: string[] = [];
  readonly sequences = new Map<string, ReturnType<typeof sequenceRecord>>();
  readonly dependencies = new Map<string, ReturnType<typeof dependency>>();
  readonly speakerIdentities = new Map<string, ReturnType<typeof speakerEdge>>();
  readonly voiceIdentities = new Map<string, ReturnType<typeof voiceIdentity>>();
  readonly acceptedProvenance = new Map<string, ReturnType<typeof acceptedProvenance>>();

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    this.queries.push(text);
    if (text.includes('speaker-workflow:ownership')) return result([{ allowed: true }] as unknown as T[]);
    if (text.includes('speaker-workflow:merge-sequences')) {
      return this.upsertImmutable(this.sequences, JSON.parse(String(values[1]))) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:load-active-provenance')) {
      const [, bookId, revisionId, requestedChapterId, paragraphIds] = values as [
        string,
        string,
        string,
        string,
        string[],
      ];
      return result(
        [...this.acceptedProvenance.values()]
          .filter(
            (row) =>
              row.bookId === bookId &&
              row.contentRevisionId === revisionId &&
              row.chapterId === requestedChapterId &&
              paragraphIds.includes(row.paragraphId) &&
              row.status === 'active',
          )
          .map((payload) => ({ payload })),
      ) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:supersede-provenance')) {
      const replacements = JSON.parse(String(values[5])) as Array<{
        id: string;
        payload: ReturnType<typeof acceptedProvenance>;
      }>;
      const returned: { id: string }[] = [];
      for (const replacement of replacements) {
        const previous = this.acceptedProvenance.get(replacement.id);
        if (!previous || previous.status !== 'active') continue;
        this.acceptedProvenance.set(replacement.id, replacement.payload);
        returned.push({ id: replacement.id });
      }
      return result(returned) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:insert-provenance')) {
      return this.upsertActiveProvenance(JSON.parse(String(values[1]))) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:list-provenance')) {
      const [, bookId, revisionId, requestedChapterId, activeOnly] = values as [
        string,
        string,
        string,
        string | null,
        boolean,
      ];
      return result(
        [...this.acceptedProvenance.values()]
          .filter(
            (row) =>
              row.bookId === bookId &&
              row.contentRevisionId === revisionId &&
              (requestedChapterId === null || row.chapterId === requestedChapterId) &&
              (!activeOnly || row.status === 'active'),
          )
          .sort((left, right) => left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id))
          .map((payload) => ({ payload })),
      ) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:upsert-dependencies')) {
      const returned: { id: string }[] = [];
      for (const row of JSON.parse(String(values[1])) as ReturnType<typeof dependency>[]) {
        const previous = this.dependencies.get(row.id);
        if (previous && previous.fingerprint !== row.fingerprint) continue;
        if (!previous) this.dependencies.set(row.id, row);
        else if (previous.status === 'active' && row.status === 'stale') {
          this.dependencies.set(row.id, { ...previous, status: 'stale', staleReason: row.staleReason });
        }
        returned.push({ id: row.id });
      }
      return result(returned) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:mark-dependencies-stale')) {
      const [userId, bookId, contentRevisionId, rowIds, staleReason] = values as [
        string,
        string,
        string,
        string[],
        string,
      ];
      void userId;
      const returned: { id: string }[] = [];
      for (const id of rowIds) {
        const previous = this.dependencies.get(id);
        if (!previous || previous.bookId !== bookId || previous.contentRevisionId !== contentRevisionId) continue;
        this.dependencies.set(id, {
          ...previous,
          status: 'stale',
          staleReason: previous.staleReason ?? staleReason,
        });
        returned.push({ id });
      }
      return result(returned) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:load-artifact-dependencies')) {
      const [, bookId, contentRevisionId, artifactId] = values as [string, string, string, string];
      return result(
        [...this.dependencies.values()]
          .filter(
            (row) =>
              row.bookId === bookId &&
              row.contentRevisionId === contentRevisionId &&
              row.artifactId === artifactId &&
              row.status === 'active',
          )
          .map((payload) => ({ payload })),
      ) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:load-identity-overlaps:speaker_identity_edges')) {
      return this.identityRows(this.speakerIdentities, values[1]) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:load-identity-overlaps:speaker_voice_identities')) {
      return this.identityRows(this.voiceIdentities, values[1]) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:append-identities:speaker_identity_edges')) {
      return this.upsertImmutable(
        this.speakerIdentities,
        JSON.parse(String(values[1])),
      ) as unknown as pg.QueryResult<T>;
    }
    if (text.includes('speaker-workflow:append-identities:speaker_voice_identities')) {
      return this.upsertImmutable(this.voiceIdentities, JSON.parse(String(values[1]))) as unknown as pg.QueryResult<T>;
    }
    throw new Error(`Unexpected speaker workflow query: ${text}`);
  }

  private upsertImmutable<T extends { id: string; fingerprint: string }>(
    target: Map<string, T>,
    rows: T[],
  ): pg.QueryResult<{ id: string }> {
    const returned: { id: string }[] = [];
    for (const row of rows) {
      const previous = target.get(row.id);
      if (previous && previous.fingerprint !== row.fingerprint) continue;
      if (!previous) target.set(row.id, row);
      returned.push({ id: row.id });
    }
    return result(returned);
  }

  private identityRows<T extends { bookId: string; contentRevisionId: string; speakerEntityId: string }>(
    target: Map<string, T>,
    serializedScopes: unknown,
  ): pg.QueryResult<{ payload: T }> {
    const scopes = JSON.parse(String(serializedScopes)) as T[];
    return result(
      [...target.values()]
        .filter((row) =>
          scopes.some(
            (scope) =>
              scope.bookId === row.bookId &&
              scope.contentRevisionId === row.contentRevisionId &&
              scope.speakerEntityId === row.speakerEntityId,
          ),
        )
        .map((payload) => ({ payload })),
    );
  }

  private upsertActiveProvenance(rows: ReturnType<typeof acceptedProvenance>[]): pg.QueryResult<{ id: string }> {
    const returned: { id: string }[] = [];
    for (const row of rows) {
      const previous = this.acceptedProvenance.get(row.id);
      if (previous && (previous.fingerprint !== row.fingerprint || previous.status !== row.status)) continue;
      const duplicate = [...this.acceptedProvenance.values()].find(
        (candidate) =>
          candidate.status === 'active' &&
          candidate.contentRevisionId === row.contentRevisionId &&
          candidate.segmentId === row.segmentId &&
          candidate.id !== row.id,
      );
      if (duplicate) continue;
      if (!previous) this.acceptedProvenance.set(row.id, row);
      returned.push({ id: row.id });
    }
    return result(returned);
  }
}

const bookId = 'book_1';
const contentRevisionId = 'revision_1';
const chapterId = 'chapter_1';
const userId = 'user_1';

function sequenceRecord(id: string, sceneId: string, selectedSpeakerOrdinal = 0) {
  return createSpeakerSequenceDecisionRecord({
    bookId,
    contentRevisionId,
    chapterId,
    sceneId,
    packetFingerprint: `packet_${sceneId}`,
    decision: {
      version: 'dialogue-sequence-decision-v1',
      id,
      burstOrdinal: 0,
      spanIndexes: [0],
      candidateOrdinals: [[0, 1]],
      selectedSpeakerOrdinals: [selectedSpeakerOrdinal],
      ruleConstraintBits: [0],
      decoderMethod: 'min_cost_path',
      disagreementIndexes: [],
      reviewCodes: [],
      fingerprint: `decision_${id}_${selectedSpeakerOrdinal}`,
    },
  });
}

function dependency(status: 'active' | 'stale' = 'active') {
  return createSpeakerArtifactDependency({
    bookId,
    contentRevisionId,
    chapterId,
    artifactId: 'artifact_1',
    artifactKind: 'speaker_labels',
    level: 'L3_speaker',
    dependencyIds: ['inventory_1'],
    status,
    staleReason: status === 'stale' ? 'inventory changed' : undefined,
    createdAt: status === 'stale' ? '2026-07-13T01:00:00.000Z' : '2026-07-13T00:00:00.000Z',
  });
}

function speakerEdge(characterId = 'character_1', sourceRevealAnchorId = 'correction_1') {
  return createSpeakerIdentityEdge({
    bookId,
    contentRevisionId,
    sourceRevealAnchorId,
    speakerEntityId: 'speaker_1',
    characterId,
    visibleFromNarrativeOrder: 10,
    visibleToNarrativeOrder: 20,
    confidenceKind: 'human_verified',
    status: 'active',
    provenance: 'user_correction',
  });
}

function voiceIdentity(voiceIdentityId = 'voice_1', sourceRevealAnchorId = 'voice_assignment_1', userPinned = false) {
  return createSpeakerVoiceIdentity({
    bookId,
    contentRevisionId,
    sourceRevealAnchorId,
    speakerEntityId: 'speaker_1',
    voiceIdentityId,
    visibleFromNarrativeOrder: 10,
    visibleToNarrativeOrder: 20,
    assignmentKind: 'character_profile',
    userPinned,
  });
}

function acceptedProvenance(
  paragraphId = 'paragraph_1',
  segmentId = 'segment_1',
  speakerEntityId = 'speaker_entity_1',
  artifactId = 'artifact_1',
) {
  return createAcceptedSpeakerProvenance(
    {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphId,
      segmentId,
      sourceSpanId: `span_${segmentId}`,
      sceneId: 'scene_1',
      narrativeOrder: Number(segmentId.replace(/\D/gu, '')) || 0,
      speakerEntityId,
      canonicalSpeakerId: speakerEntityId.startsWith('speaker_entity') ? 'unknown' : speakerEntityId,
      resolutionKind: 'provider_candidate',
      sourceManifestFingerprint: 'manifest_1',
      confidence: 0.8,
    },
    artifactId,
    '2026-07-13T00:00:00.000Z',
  );
}

describe('hosted speaker workflow state correctness', () => {
  it('merges multiple windows idempotently without chapter-wide deletion', async () => {
    const db = new MemorySpeakerWorkflowDb();
    const first = sequenceRecord('decision_1', 'scene_1');
    const second = sequenceRecord('decision_2', 'scene_2');
    await replaceHostedSpeakerSequenceDecisions(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      records: [first],
    });
    await replaceHostedSpeakerSequenceDecisions(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      records: [second, second],
    });

    expect([...db.sequences.keys()].sort()).toEqual(['decision_1', 'decision_2']);
    expect(db.queries.some((query) => /delete\s+from\s+speaker_sequence_decisions/iu.test(query))).toBe(false);
    await expect(
      replaceHostedSpeakerSequenceDecisions(db, userId, {
        bookId,
        contentRevisionId,
        chapterId,
        records: [sequenceRecord('decision_1', 'scene_1', 1)],
      }),
    ).rejects.toThrow(/immutable content/i);
  });

  it('keeps immutable dependency lineage while stale state changes monotonically', async () => {
    const db = new MemorySpeakerWorkflowDb();
    const active = dependency();
    await putHostedSpeakerArtifactDependencies(db, userId, [active]);
    await expect(
      putHostedSpeakerArtifactDependencies(db, userId, [{ ...active, dependencyIds: ['tampered_inventory'] }]),
    ).rejects.toThrow(/invalid immutable lineage/i);
    await putHostedSpeakerArtifactDependencies(db, userId, [dependency('stale')]);
    await putHostedSpeakerArtifactDependencies(db, userId, [active]);
    expect(db.dependencies.get(active.id)).toMatchObject({
      fingerprint: active.fingerprint,
      status: 'stale',
      staleReason: 'inventory changed',
      createdAt: active.createdAt,
    });

    const second = createSpeakerArtifactDependency({
      ...active,
      artifactId: 'artifact_2',
      status: 'active',
      staleReason: undefined,
    });
    await putHostedSpeakerArtifactDependencies(db, userId, [second]);
    expect(
      await markHostedSpeakerArtifactDependenciesStale(db, userId, {
        bookId,
        contentRevisionId,
        rowIds: [second.id, second.id],
        staleReason: 'manual correction',
      }),
    ).toBe(1);
    expect(db.dependencies.get(second.id)).toMatchObject({
      fingerprint: second.fingerprint,
      status: 'stale',
      staleReason: 'manual correction',
    });
  });

  it('keeps identity retries idempotent and rejects ambiguous hosted intervals', async () => {
    const db = new MemorySpeakerWorkflowDb();
    const first = speakerEdge();
    await appendHostedSpeakerIdentityEdges(db, userId, [first, first]);
    expect(db.speakerIdentities.size).toBe(1);
    await expect(
      appendHostedSpeakerIdentityEdges(db, userId, [speakerEdge('character_2', 'correction_2')]),
    ).rejects.toThrow(/ambiguous active interval/i);
    expect(db.speakerIdentities.size).toBe(1);

    const fallback = voiceIdentity();
    await appendHostedSpeakerVoiceIdentities(db, userId, [fallback]);
    await expect(
      appendHostedSpeakerVoiceIdentities(db, userId, [voiceIdentity('voice_2', 'voice_assignment_2')]),
    ).rejects.toThrow(/ambiguous active interval/i);
    await expect(
      appendHostedSpeakerVoiceIdentities(db, userId, [voiceIdentity('voice_pinned', 'voice_assignment_pinned', true)]),
    ).resolves.toBeUndefined();
  });

  it('rebases staging lineage onto a promoted review artifact and retires the source rows', async () => {
    const db = new MemorySpeakerWorkflowDb();
    const staging = dependency();
    await putHostedSpeakerArtifactDependencies(db, userId, [staging]);

    await expect(
      rebaseHostedSpeakerArtifactDependencies(db, userId, {
        bookId,
        contentRevisionId,
        sourceArtifactId: staging.artifactId,
        targetArtifactId: 'promoted_artifact',
        additionalDependencyIds: ['correction_operation_1'],
        staleSourceReason: 'review_promoted',
      }),
    ).resolves.toBe(1);

    const rows = [...db.dependencies.values()];
    expect(rows.find((row) => row.id === staging.id)).toMatchObject({
      status: 'stale',
      staleReason: 'review_promoted',
    });
    expect(rows.find((row) => row.artifactId === 'promoted_artifact')).toMatchObject({
      status: 'active',
      dependencyIds: ['correction_operation_1', 'inventory_1'],
      level: staging.level,
    });
  });

  it('replaces accepted speaker provenance by paragraph and preserves distinct unknown entities', async () => {
    const db = new MemorySpeakerWorkflowDb();
    const first = acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_1');
    const second = acceptedProvenance('paragraph_2', 'segment_2', 'speaker_entity_2', 'artifact_2');
    const unchanged = acceptedProvenance('paragraph_1', 'segment_3', 'speaker_entity_4', 'artifact_4');
    await replaceHostedAcceptedSpeakerProvenanceForParagraphs(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1', 'paragraph_2'],
      rows: [first, second, unchanged],
    });

    const replacement = acceptedProvenance('paragraph_1', 'segment_1', 'speaker_entity_3', 'artifact_3');
    await replaceHostedAcceptedSpeakerProvenanceForParagraphs(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1'],
      rows: [replacement, unchanged],
    });
    await replaceHostedAcceptedSpeakerProvenanceForParagraphs(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_1'],
      rows: [replacement, unchanged],
    });

    expect(await listHostedAcceptedSpeakerProvenance(db, userId, { bookId, contentRevisionId })).toEqual([
      replacement,
      second,
      unchanged,
    ]);
    expect([...db.acceptedProvenance.values()]).toEqual(
      expect.arrayContaining([{ ...first, status: 'superseded' }, second, unchanged, replacement]),
    );

    await replaceHostedAcceptedSpeakerProvenanceForParagraphs(db, userId, {
      bookId,
      contentRevisionId,
      chapterId,
      paragraphIds: ['paragraph_2'],
      rows: [],
    });
    expect(await listHostedAcceptedSpeakerProvenance(db, userId, { bookId, contentRevisionId })).toEqual([
      replacement,
      unchanged,
    ]);
    expect(
      await listHostedAcceptedSpeakerProvenance(db, userId, {
        bookId,
        contentRevisionId,
        activeOnly: false,
      }),
    ).toEqual(expect.arrayContaining([{ ...second, status: 'superseded' }, replacement, unchanged]));
  });
});
