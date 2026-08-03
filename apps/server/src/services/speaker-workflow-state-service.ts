import type pg from 'pg';
import {
  assertSpeakerArtifactDependency,
  createSpeakerArtifactDependency,
  markSpeakerArtifactDependencyStale,
  type SpeakerArtifactDependencyV1,
} from '../../../../src/providers/speaker-attribution/artifact-dependency';
import {
  assertNoAmbiguousSpeakerIdentityEdges,
  assertNoAmbiguousSpeakerVoiceIdentities,
  assertSpeakerIdentityEdge,
  assertSpeakerVoiceIdentity,
  type SpeakerIdentityEdgeV1,
  type SpeakerVoiceIdentityV1,
} from '../../../../src/providers/speaker-attribution/speaker-identity';
import type { SpeakerSequenceDecisionRecordV1 } from '../../../../src/providers/speaker-attribution/workflow-state';
import {
  assertAcceptedSpeakerProvenance,
  assertNoDuplicateActiveSpeakerProvenance,
  transitionAcceptedSpeakerProvenance,
  type AcceptedSpeakerProvenanceV1,
} from '../../../../src/providers/speaker-attribution/accepted-speaker-provenance';

export interface SpeakerWorkflowStateQueryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

type FingerprintedRow = { readonly id: string; readonly fingerprint: string };
type HostedIdentityRow = FingerprintedRow & {
  readonly bookId: string;
  readonly contentRevisionId: string;
  readonly speakerEntityId: string;
};

function uniqueImmutableRows<T extends FingerprintedRow>(rows: readonly T[], label: string): T[] {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const previous = unique.get(row.id);
    if (previous && previous.fingerprint !== row.fingerprint) {
      throw new Error(`${label} ${row.id} has conflicting immutable content in one write`);
    }
    if (!previous) unique.set(row.id, row);
  }
  return [...unique.values()];
}

function uniqueDependencyRows(rows: readonly SpeakerArtifactDependencyV1[]): SpeakerArtifactDependencyV1[] {
  const unique = new Map<string, SpeakerArtifactDependencyV1>();
  for (const row of rows) {
    assertSpeakerArtifactDependency(row);
    const previous = unique.get(row.id);
    if (previous && previous.fingerprint !== row.fingerprint) {
      throw new Error(`Speaker artifact dependency ${row.id} has conflicting immutable content in one write`);
    }
    if (!previous) unique.set(row.id, row);
    else if (previous.status === 'active' && row.status === 'stale') {
      unique.set(row.id, markSpeakerArtifactDependencyStale(previous, row.staleReason!));
    }
  }
  return [...unique.values()];
}

async function assertBookOwnership(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  bookId: string,
  contentRevisionId?: string,
): Promise<void> {
  const result = await db.query<{ allowed: boolean }>(
    `
      /* speaker-workflow:ownership */
      select true as allowed
      from library_books book
      where book.user_id = $1 and book.id = $2
        and ($3::text is null or exists (
          select 1 from book_content_revisions revision where revision.id = $3 and revision.book_id = book.id
        ))
      limit 1
    `,
    [userId, bookId, contentRevisionId ?? null],
  );
  if (!result.rows[0]?.allowed) throw new Error('Speaker workflow state source is unavailable');
}

export async function mergeHostedSpeakerSequenceDecisions(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId: string;
    readonly records: readonly SpeakerSequenceDecisionRecordV1[];
  },
): Promise<void> {
  await assertBookOwnership(db, userId, input.bookId, input.contentRevisionId);
  if (
    input.records.some(
      (record) =>
        record.bookId !== input.bookId ||
        record.contentRevisionId !== input.contentRevisionId ||
        record.chapterId !== input.chapterId,
    )
  ) {
    throw new Error('Speaker sequence decision scope does not match merge scope');
  }
  const records = uniqueImmutableRows(input.records, 'Speaker sequence decision');
  if (records.length === 0) return;
  const result = await db.query<{ id: string }>(
    `
      /* speaker-workflow:merge-sequences */
      insert into speaker_sequence_decisions (
        id, user_id, book_id, content_revision_id, chapter_id, scene_id,
        packet_fingerprint, fingerprint, payload, created_at
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId', item->>'chapterId',
        item->>'sceneId', item->>'packetFingerprint', item->>'fingerprint', item, now()
      from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set fingerprint = speaker_sequence_decisions.fingerprint
        where speaker_sequence_decisions.user_id = $1
          and speaker_sequence_decisions.fingerprint = excluded.fingerprint
      returning id
    `,
    [userId, JSON.stringify(records)],
  );
  if (result.rowCount !== records.length) {
    throw new Error('Speaker sequence decision conflicts with persisted immutable content');
  }
}

// Compatibility name: sequence decisions are now merged per window and never delete other chapter windows.
export const replaceHostedSpeakerSequenceDecisions = mergeHostedSpeakerSequenceDecisions;

export async function replaceHostedAcceptedSpeakerProvenanceForParagraphs(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId: string;
    readonly paragraphIds: readonly string[];
    readonly rows: readonly AcceptedSpeakerProvenanceV1[];
  },
): Promise<void> {
  await assertBookOwnership(db, userId, input.bookId, input.contentRevisionId);
  const paragraphIds = [...new Set(input.paragraphIds)];
  if (paragraphIds.length === 0) throw new Error('Accepted speaker provenance replacement requires paragraphs');
  const paragraphIdSet = new Set(paragraphIds);
  const rows = uniqueImmutableRows(input.rows, 'Accepted speaker provenance');
  rows.forEach(assertAcceptedSpeakerProvenance);
  if (
    rows.some(
      (row) =>
        row.status !== 'active' ||
        row.bookId !== input.bookId ||
        row.contentRevisionId !== input.contentRevisionId ||
        row.chapterId !== input.chapterId ||
        !paragraphIdSet.has(row.paragraphId),
    )
  ) {
    throw new Error('Accepted speaker provenance row is outside the replacement scope');
  }
  assertNoDuplicateActiveSpeakerProvenance(rows);
  const existingResult = await db.query<{ payload: AcceptedSpeakerProvenanceV1 }>(
    `
      /* speaker-workflow:load-active-provenance */
      select payload
      from accepted_speaker_provenance
      where user_id = $1 and book_id = $2 and content_revision_id = $3 and chapter_id = $4
        and paragraph_id = any($5::text[]) and status = 'active'
      order by id
      for update
    `,
    [userId, input.bookId, input.contentRevisionId, input.chapterId, paragraphIds],
  );
  const existing = existingResult.rows.map((row) => row.payload);
  existing.forEach(assertAcceptedSpeakerProvenance);
  const requestedById = new Map(rows.map((row) => [row.id, row] as const));
  const existingById = new Map(existing.map((row) => [row.id, row] as const));
  for (const row of rows) {
    const persisted = existingById.get(row.id);
    if (persisted && persisted.fingerprint !== row.fingerprint) {
      throw new Error(`Accepted speaker provenance ${row.id} conflicts with persisted immutable content`);
    }
  }
  if (
    existing.length === rows.length &&
    existing.every((row) => requestedById.get(row.id)?.fingerprint === row.fingerprint)
  ) {
    return;
  }
  const superseded = existing
    .filter((row) => !requestedById.has(row.id))
    .map((row) => transitionAcceptedSpeakerProvenance(row, 'superseded'));
  if (superseded.length > 0) {
    const updated = await db.query<{ id: string }>(
      `
        /* speaker-workflow:supersede-provenance */
        update accepted_speaker_provenance target
        set status = 'superseded', stale_reason = null,
            payload = source.payload, updated_at = now()
        from jsonb_to_recordset($6::jsonb) as source(id text, payload jsonb)
        where target.id = source.id and target.user_id = $1 and target.book_id = $2
          and target.content_revision_id = $3 and target.chapter_id = $4
          and target.paragraph_id = any($5::text[]) and target.status = 'active'
        returning target.id
      `,
      [
        userId,
        input.bookId,
        input.contentRevisionId,
        input.chapterId,
        paragraphIds,
        JSON.stringify(superseded.map((row) => ({ id: row.id, payload: row }))),
      ],
    );
    if (updated.rowCount !== superseded.length) {
      throw new Error('Accepted speaker provenance changed during scoped replacement');
    }
  }
  const rowsToInsert = rows.filter((row) => !existingById.has(row.id));
  if (rowsToInsert.length === 0) return;
  const inserted = await db.query<{ id: string }>(
    `
      /* speaker-workflow:insert-provenance */
      insert into accepted_speaker_provenance (
        id, user_id, book_id, content_revision_id, chapter_id, paragraph_id, segment_id,
        source_span_id, scene_id, dialogue_burst_id, narrative_order, speaker_entity_id,
        canonical_speaker_id, resolution_kind, source_manifest_fingerprint, packet_fingerprint,
        temporal_snapshot_id, sequence_decision_id, artifact_id, confidence, status, stale_reason,
        fingerprint, payload, created_at, updated_at
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId', item->>'chapterId',
        item->>'paragraphId', item->>'segmentId', item->>'sourceSpanId', item->>'sceneId',
        nullif(item->>'dialogueBurstId',''), (item->>'narrativeOrder')::bigint,
        nullif(item->>'speakerEntityId',''), item->>'canonicalSpeakerId', item->>'resolutionKind',
        item->>'sourceManifestFingerprint', nullif(item->>'packetFingerprint',''),
        nullif(item->>'temporalSnapshotId',''), nullif(item->>'sequenceDecisionId',''),
        item->>'artifactId', (item->>'confidence')::double precision, item->>'status',
        nullif(item->>'staleReason',''), item->>'fingerprint', item,
        (item->>'createdAt')::timestamptz, now()
      from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set fingerprint = accepted_speaker_provenance.fingerprint
        where accepted_speaker_provenance.user_id = $1
          and accepted_speaker_provenance.fingerprint = excluded.fingerprint
          and accepted_speaker_provenance.status = excluded.status
      returning id
    `,
    [userId, JSON.stringify(rowsToInsert)],
  );
  if (inserted.rowCount !== rowsToInsert.length) {
    throw new Error('Accepted speaker provenance conflicts with persisted immutable content');
  }
}

export async function listHostedAcceptedSpeakerProvenance(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly chapterId?: string;
    readonly activeOnly?: boolean;
  },
): Promise<AcceptedSpeakerProvenanceV1[]> {
  await assertBookOwnership(db, userId, input.bookId, input.contentRevisionId);
  const result = await db.query<{ payload: AcceptedSpeakerProvenanceV1 }>(
    `
      /* speaker-workflow:list-provenance */
      select payload
      from accepted_speaker_provenance
      where user_id = $1 and book_id = $2 and content_revision_id = $3
        and ($4::text is null or chapter_id = $4)
        and ($5::boolean = false or status = 'active')
      order by narrative_order, id
    `,
    [userId, input.bookId, input.contentRevisionId, input.chapterId ?? null, input.activeOnly !== false],
  );
  const rows = result.rows.map((row) => row.payload);
  rows.forEach(assertAcceptedSpeakerProvenance);
  assertNoDuplicateActiveSpeakerProvenance(rows);
  return rows;
}

export async function putHostedSpeakerArtifactDependencies(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  rows: readonly SpeakerArtifactDependencyV1[],
): Promise<void> {
  const unique = uniqueDependencyRows(rows);
  if (unique.length === 0) return;
  const scopes = [...new Map(unique.map((row) => [`${row.bookId}\u0000${row.contentRevisionId}`, row])).values()];
  for (const row of scopes) await assertBookOwnership(db, userId, row.bookId, row.contentRevisionId);
  const result = await db.query<{ id: string }>(
    `
      /* speaker-workflow:upsert-dependencies */
      insert into speaker_artifact_dependencies (
        id, user_id, book_id, content_revision_id, chapter_id, scene_id, burst_id,
        artifact_id, artifact_kind, dependency_level, status, stale_reason,
        fingerprint, payload, created_at, updated_at
      )
      select item->>'id', $1, item->>'bookId', item->>'contentRevisionId', nullif(item->>'chapterId',''),
        nullif(item->>'sceneId',''), nullif(item->>'burstId',''), item->>'artifactId', item->>'artifactKind',
        item->>'level', item->>'status', nullif(item->>'staleReason',''), item->>'fingerprint', item,
        coalesce((item->>'createdAt')::timestamptz, now()), now()
      from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set
        status = case
          when speaker_artifact_dependencies.status = 'stale' then 'stale'
          else excluded.status
        end,
        stale_reason = case
          when speaker_artifact_dependencies.status = 'stale' then speaker_artifact_dependencies.stale_reason
          else excluded.stale_reason
        end,
        payload = case
          when speaker_artifact_dependencies.status = 'active' and excluded.status = 'stale' then
            jsonb_set(
              jsonb_set(speaker_artifact_dependencies.payload, '{status}', '"stale"'::jsonb, true),
              '{staleReason}', to_jsonb(excluded.stale_reason), true
            )
          else speaker_artifact_dependencies.payload
        end,
        updated_at = case
          when speaker_artifact_dependencies.status = 'active' and excluded.status = 'stale' then now()
          else speaker_artifact_dependencies.updated_at
        end
        where speaker_artifact_dependencies.user_id = $1
          and speaker_artifact_dependencies.fingerprint = excluded.fingerprint
      returning id
    `,
    [userId, JSON.stringify(unique)],
  );
  if (result.rowCount !== unique.length) {
    throw new Error('Speaker artifact dependency conflicts with persisted immutable lineage');
  }
}

export async function markHostedSpeakerArtifactDependenciesStale(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly rowIds: readonly string[];
    readonly staleReason: string;
  },
): Promise<number> {
  const rowIds = [...new Set(input.rowIds)];
  if (rowIds.length === 0) return 0;
  const staleReason = input.staleReason.trim();
  if (!staleReason) throw new Error('A stale speaker artifact dependency requires a reason');
  await assertBookOwnership(db, userId, input.bookId, input.contentRevisionId);
  const result = await db.query<{ id: string }>(
    `
      /* speaker-workflow:mark-dependencies-stale */
      update speaker_artifact_dependencies
      set status = 'stale',
        stale_reason = coalesce(stale_reason, $5),
        payload = jsonb_set(
          jsonb_set(payload, '{status}', '"stale"'::jsonb, true),
          '{staleReason}', to_jsonb(coalesce(stale_reason, $5::text)), true
        ),
        updated_at = case when status = 'active' then now() else updated_at end
      where user_id = $1 and book_id = $2 and content_revision_id = $3 and id = any($4::text[])
      returning id
    `,
    [userId, input.bookId, input.contentRevisionId, rowIds, staleReason],
  );
  if (result.rowCount !== rowIds.length) {
    throw new Error('Selected speaker artifact dependency is unavailable in this revision');
  }
  return result.rowCount;
}

export async function rebaseHostedSpeakerArtifactDependencies(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  input: {
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly sourceArtifactId: string;
    readonly targetArtifactId: string;
    readonly additionalDependencyIds?: readonly string[];
    readonly staleSourceReason?: string;
  },
): Promise<number> {
  await assertBookOwnership(db, userId, input.bookId, input.contentRevisionId);
  const source = await db.query<{ payload: SpeakerArtifactDependencyV1 }>(
    `
      /* speaker-workflow:load-artifact-dependencies */
      select payload
      from speaker_artifact_dependencies
      where user_id = $1 and book_id = $2 and content_revision_id = $3
        and artifact_id = $4 and status = 'active'
      order by id
    `,
    [userId, input.bookId, input.contentRevisionId, input.sourceArtifactId],
  );
  const sourceRows = source.rows.map((row) => row.payload);
  sourceRows.forEach(assertSpeakerArtifactDependency);
  if (sourceRows.length === 0) return 0;
  await putHostedSpeakerArtifactDependencies(
    db,
    userId,
    sourceRows.map((row) =>
      createSpeakerArtifactDependency({
        bookId: row.bookId,
        contentRevisionId: row.contentRevisionId,
        chapterId: row.chapterId,
        sceneId: row.sceneId,
        burstId: row.burstId,
        artifactId: input.targetArtifactId,
        artifactKind: row.artifactKind,
        level: row.level,
        dependencyIds: [...row.dependencyIds, ...(input.additionalDependencyIds ?? [])],
      }),
    ),
  );
  if (input.staleSourceReason) {
    await markHostedSpeakerArtifactDependenciesStale(db, userId, {
      bookId: input.bookId,
      contentRevisionId: input.contentRevisionId,
      rowIds: sourceRows.map((row) => row.id),
      staleReason: input.staleSourceReason,
    });
  }
  return sourceRows.length;
}

async function appendIdentityRows<T extends HostedIdentityRow>(input: {
  readonly db: SpeakerWorkflowStateQueryable;
  readonly userId: string;
  readonly table: 'speaker_identity_edges' | 'speaker_voice_identities';
  readonly rows: readonly T[];
  readonly label: string;
  readonly assertRow: (row: T) => void;
  readonly assertNoAmbiguity: (rows: readonly T[]) => void;
}): Promise<void> {
  input.rows.forEach(input.assertRow);
  const rows = uniqueImmutableRows(input.rows, input.label);
  if (rows.length === 0) return;
  const ownershipScopes = [
    ...new Map(rows.map((row) => [`${row.bookId}\u0000${row.contentRevisionId}`, row])).values(),
  ];
  for (const row of ownershipScopes) {
    await assertBookOwnership(input.db, input.userId, row.bookId, row.contentRevisionId);
  }
  const identityScopes = [
    ...new Map(
      rows.map((row) => [
        `${row.bookId}\u0000${row.contentRevisionId}\u0000${row.speakerEntityId}`,
        {
          bookId: row.bookId,
          contentRevisionId: row.contentRevisionId,
          speakerEntityId: row.speakerEntityId,
        },
      ]),
    ).values(),
  ];
  const existingResult = await input.db.query<{ payload: T }>(
    `
      /* speaker-workflow:load-identity-overlaps:${input.table} */
      select target.payload
      from ${input.table} target
      where target.user_id = $1 and exists (
        select 1 from jsonb_array_elements($2::jsonb) scope
        where target.book_id = scope->>'bookId'
          and target.content_revision_id = scope->>'contentRevisionId'
          and target.speaker_entity_id = scope->>'speakerEntityId'
      )
    `,
    [input.userId, JSON.stringify(identityScopes)],
  );
  const existing = existingResult.rows.map((row) => row.payload);
  existing.forEach(input.assertRow);
  input.assertNoAmbiguity([
    ...existing,
    ...rows.filter((row) => !existing.some((persisted) => persisted.id === row.id)),
  ]);
  const columns =
    input.table === 'speaker_identity_edges'
      ? '(id,user_id,book_id,content_revision_id,source_reveal_anchor_id,speaker_entity_id,character_id,visible_from_narrative_order,visible_to_narrative_order,status,fingerprint,payload,created_at)'
      : '(id,user_id,book_id,content_revision_id,source_reveal_anchor_id,speaker_entity_id,voice_identity_id,visible_from_narrative_order,visible_to_narrative_order,user_pinned,fingerprint,payload,created_at)';
  const projection =
    input.table === 'speaker_identity_edges'
      ? "item->>'id',$1,item->>'bookId',item->>'contentRevisionId',item->>'sourceRevealAnchorId',item->>'speakerEntityId',item->>'characterId',(item->>'visibleFromNarrativeOrder')::integer,(item->>'visibleToNarrativeOrder')::integer,item->>'status',item->>'fingerprint',item,coalesce((item->>'createdAt')::timestamptz,now())"
      : "item->>'id',$1,item->>'bookId',item->>'contentRevisionId',item->>'sourceRevealAnchorId',item->>'speakerEntityId',item->>'voiceIdentityId',(item->>'visibleFromNarrativeOrder')::integer,(item->>'visibleToNarrativeOrder')::integer,coalesce((item->>'userPinned')::boolean,false),item->>'fingerprint',item,coalesce((item->>'createdAt')::timestamptz,now())";
  const result = await input.db.query<{ id: string }>(
    `
      /* speaker-workflow:append-identities:${input.table} */
      insert into ${input.table} ${columns}
      select ${projection} from jsonb_array_elements($2::jsonb) item
      on conflict (id) do update set fingerprint = ${input.table}.fingerprint
        where ${input.table}.user_id = $1 and ${input.table}.fingerprint = excluded.fingerprint
      returning id
    `,
    [input.userId, JSON.stringify(rows)],
  );
  if (result.rowCount !== rows.length) {
    throw new Error(`Append-only ${input.table} row conflicts with persisted immutable content`);
  }
}

export function appendHostedSpeakerIdentityEdges(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  rows: readonly SpeakerIdentityEdgeV1[],
): Promise<void> {
  return appendIdentityRows({
    db,
    userId,
    table: 'speaker_identity_edges',
    rows,
    label: 'Speaker identity edge',
    assertRow: assertSpeakerIdentityEdge,
    assertNoAmbiguity: assertNoAmbiguousSpeakerIdentityEdges,
  });
}

export function appendHostedSpeakerVoiceIdentities(
  db: SpeakerWorkflowStateQueryable,
  userId: string,
  rows: readonly SpeakerVoiceIdentityV1[],
): Promise<void> {
  return appendIdentityRows({
    db,
    userId,
    table: 'speaker_voice_identities',
    rows,
    label: 'Speaker voice identity',
    assertRow: assertSpeakerVoiceIdentity,
    assertNoAmbiguity: assertNoAmbiguousSpeakerVoiceIdentities,
  });
}
