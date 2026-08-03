import { persistentId128 } from '@noveldesk/text-core/hash';
import type pg from 'pg';
import type {
  AnalysisArtifactType,
  AnalysisInputRevision,
  AnalysisStagingArtifact,
} from './analysis-input-contracts.js';
import type { RevisionQueryable } from './analysis-input-repository.js';

interface StagingArtifactRow extends pg.QueryResultRow {
  id: string;
  input_revision_id: string;
  provider_job_id: string;
  workflow_id: string | null;
  book_id: string;
  chapter_id: string | null;
  artifact_type: AnalysisArtifactType;
  output_hash: string;
  payload: unknown;
  metadata: unknown;
  expected_content_revision_id: string;
  expected_graph_revision_id: string | null;
  status: AnalysisStagingArtifact['status'];
  stale_reason: string | null;
  created_at: Date | string;
  promoted_at: Date | string | null;
}

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapArtifact(row: StagingArtifactRow): AnalysisStagingArtifact {
  return {
    id: row.id,
    inputRevisionId: row.input_revision_id,
    providerJobId: row.provider_job_id,
    workflowId: row.workflow_id ?? undefined,
    bookId: row.book_id,
    chapterId: row.chapter_id ?? undefined,
    artifactType: row.artifact_type,
    outputHash: row.output_hash,
    payload: row.payload,
    metadata: metadata(row.metadata),
    expectedContentRevisionId: row.expected_content_revision_id,
    expectedGraphRevisionId: row.expected_graph_revision_id ?? undefined,
    status: row.status,
    staleReason: row.stale_reason ?? undefined,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    promotedAt: iso(row.promoted_at),
  };
}

const artifactColumns = `
  id, input_revision_id, provider_job_id, workflow_id, book_id, chapter_id,
  artifact_type, output_hash, payload, metadata, expected_content_revision_id,
  expected_graph_revision_id, status, stale_reason, created_at, promoted_at
`;

export async function stageAnalysisArtifact(
  db: RevisionQueryable,
  inputRevision: AnalysisInputRevision,
  artifactType: AnalysisArtifactType,
  outputHash: string,
  payload: unknown,
  artifactMetadata: Readonly<Record<string, unknown>> = {},
): Promise<AnalysisStagingArtifact> {
  const id = persistentId128('analysis_staging_artifact', [inputRevision.id, artifactType, outputHash]);
  const inserted = await db.query<StagingArtifactRow>(
    `
      insert into analysis_staging_artifacts (
        id, input_revision_id, provider_job_id, workflow_id, book_id, chapter_id,
        artifact_type, output_hash, payload, metadata, expected_content_revision_id,
        expected_graph_revision_id, status, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'staged', now())
      on conflict (provider_job_id, artifact_type, output_hash) do nothing
      returning ${artifactColumns}
    `,
    [
      id,
      inputRevision.id,
      inputRevision.providerJobId,
      inputRevision.workflowId ?? null,
      inputRevision.bookId,
      inputRevision.chapterId ?? null,
      artifactType,
      outputHash,
      JSON.stringify(payload),
      JSON.stringify(artifactMetadata),
      inputRevision.contentRevisionId,
      inputRevision.characterGraphRevisionId ?? null,
    ],
  );
  const artifact = inserted.rows[0] ? mapArtifact(inserted.rows[0]) : await loadAnalysisArtifact(db, id);
  if (!artifact) throw new Error(`Analysis staging artifact could not be loaded: ${id}`);
  return artifact;
}

export async function loadAnalysisArtifact(
  db: RevisionQueryable,
  artifactId: string,
  lock = false,
): Promise<AnalysisStagingArtifact | undefined> {
  const result = await db.query<StagingArtifactRow>(
    `select ${artifactColumns} from analysis_staging_artifacts where id = $1${lock ? ' for update' : ''}`,
    [artifactId],
  );
  return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
}

export async function loadPromotedAnalysisArtifactForJob(
  db: RevisionQueryable,
  providerJobId: string,
  artifactType: AnalysisArtifactType,
): Promise<AnalysisStagingArtifact | undefined> {
  const result = await db.query<StagingArtifactRow>(
    `
      select ${artifactColumns}
      from analysis_staging_artifacts
      where provider_job_id = $1 and artifact_type = $2 and status = 'promoted'
      order by promoted_at desc, created_at desc
      limit 1
    `,
    [providerJobId, artifactType],
  );
  return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
}

export async function markAnalysisArtifactStale(
  db: RevisionQueryable,
  artifactId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `
      update analysis_staging_artifacts
      set status = 'stale', stale_reason = $2
      where id = $1 and status = 'staged'
    `,
    [artifactId, reason],
  );
}

export async function markAnalysisArtifactPromoted(db: RevisionQueryable, artifactId: string): Promise<void> {
  await db.query(
    `
      update analysis_staging_artifacts
      set status = 'promoted', stale_reason = null, promoted_at = coalesce(promoted_at, now())
      where id = $1 and status in ('staged', 'promoted')
    `,
    [artifactId],
  );
}
