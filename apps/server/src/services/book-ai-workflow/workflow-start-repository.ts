import type { BookAIWorkflowPlan } from '../../../../../src/providers/book-ai-workflow-plan';
import {
  DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
  DEFAULT_BOOK_AI_WORKFLOW_VERSION,
} from '../../../../../src/providers/book-ai-workflow-definition';
import type pg from 'pg';
import type { RevisionQueryable } from './analysis-input-repository.js';
import type { BookAIWorkflowRow } from './workflow-contracts.js';

interface WorkflowDbRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  book_id: string;
  workflow_definition_id?: string;
  workflow_version?: string;
  provider_id: string;
  model_id: string | null;
  plan_hash: string;
  plan: unknown;
  content_revision_id: string;
  base_graph_revision_id: string | null;
  revision_fence: number | string;
  status: string;
  stage: string;
  progress: unknown;
}

function mapWorkflow(row: WorkflowDbRow): BookAIWorkflowRow {
  return {
    ...row,
    workflow_definition_id: row.workflow_definition_id ?? DEFAULT_BOOK_AI_WORKFLOW_DEFINITION_ID,
    workflow_version: row.workflow_version ?? DEFAULT_BOOK_AI_WORKFLOW_VERSION,
    revision_fence: Number(row.revision_fence),
  };
}

export async function lockWorkflowStartKey(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly contentRevisionId: string;
  },
): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 419641))`, [
    [input.userId, input.bookId, input.providerId, input.modelId, input.contentRevisionId].join('\u001f'),
  ]);
}

const workflowColumns = `
  id, user_id, book_id, workflow_definition_id, workflow_version, provider_id, model_id, plan_hash, plan,
  content_revision_id, base_graph_revision_id, revision_fence,
  status, stage, progress
`;

export async function findActiveWorkflow(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly contentRevisionId: string;
  },
): Promise<BookAIWorkflowRow | undefined> {
  // An active run owns this provider/model/content revision even when a deploy changes plan topology and its hash.
  const result = await db.query<WorkflowDbRow>(
    `
      select ${workflowColumns}
      from book_ai_workflows
      where user_id = $1
        and book_id = $2
        and workflow_type = 'book_ai_tts'
        and provider_id = $3
        and model_id is not distinct from $4
        and content_revision_id = $5
        and status = 'running'
      order by created_at desc
      limit 1
    `,
    [input.userId, input.bookId, input.providerId, input.modelId, input.contentRevisionId],
  );
  return result.rows[0] ? mapWorkflow(result.rows[0]) : undefined;
}

export async function insertWorkflow(
  db: RevisionQueryable,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly bookId: string;
    readonly workflowDefinitionId: string;
    readonly workflowVersion: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly planHash: string;
    readonly plan: BookAIWorkflowPlan;
    readonly contentRevisionId: string;
    readonly graphRevisionId?: string;
    readonly revisionFence: number;
    readonly providerOptions: Readonly<Record<string, unknown>>;
  },
): Promise<BookAIWorkflowRow> {
  const result = await db.query<WorkflowDbRow>(
    `
      insert into book_ai_workflows (
        id, user_id, book_id, workflow_type, provider_id, model_id, plan_hash, plan,
        content_revision_id, base_graph_revision_id, revision_fence,
        status, stage, progress, started_at, created_at, updated_at,
        workflow_definition_id, workflow_version
      )
      values (
        $1, $2, $3, 'book_ai_tts', $4, $5, $6, $7, $8, $9, $10,
        'running', 'building_graph', $11, now(), now(), now(), $12, $13
      )
      returning ${workflowColumns}
    `,
    [
      input.id,
      input.userId,
      input.bookId,
      input.providerId,
      input.modelId,
      input.planHash,
      JSON.stringify(input.plan),
      input.contentRevisionId,
      input.graphRevisionId ?? null,
      input.revisionFence,
      JSON.stringify({
        planHash: input.planHash,
        providerOptions: input.providerOptions,
        totalBundleWindows: input.plan.bundleWindows.length,
        totalLabelingWindows: input.plan.labelingWindows.length,
        queuedGraphBootstrapJobs: 0,
        graphBootstrapJobs: [],
      }),
      input.workflowDefinitionId,
      input.workflowVersion,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Analysis workflow could not be created: ${input.id}`);
  return mapWorkflow(row);
}

export async function markBookWorkflowStarted(
  db: RevisionQueryable,
  input: {
    readonly userId: string;
    readonly bookId: string;
    readonly contentRevisionId: string;
    readonly fence: number;
  },
): Promise<void> {
  const result = await db.query(
    `
      update library_books
      set analysis_status = 'building_graph', updated_at = now()
      where id = $1 and user_id = $2 and active_content_revision_id = $3 and revision_fence = $4
    `,
    [input.bookId, input.userId, input.contentRevisionId, input.fence],
  );
  if (result.rowCount !== undefined && result.rowCount === 0) {
    throw new Error(`Book revision changed while starting analysis workflow: ${input.bookId}`);
  }
}
