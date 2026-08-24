import { structuredIntegrityHash } from '@noveldesk/text-core/hash';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import {
  BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID,
  type BookAIWorkflowPlan,
  type BookAIWorkflowStageId,
} from '../../../providers/book-ai-workflow-plan';
import type {
  NativeBookWorkflowStageRequest,
  NativeBookWorkflowSubmitRequest,
  NativeStructuredJsonRequest,
  NativeWorkflowJobType,
  NativeWorkflowStage,
} from './contracts';

export const NATIVE_BOOK_WORKFLOW_PLAN_SCHEMA_VERSION = 2;
export const NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION = 3;

const canonicalStageOrder = [
  'character_graph_bootstrap',
  'character_graph_merge',
  'chapter_labeling',
  'tts_ready_preparation',
] as const satisfies readonly NativeWorkflowStage[];

const canonicalDependencies: Readonly<Record<NativeWorkflowStage, BookAIWorkflowStageId | undefined>> = {
  character_graph_bootstrap: undefined,
  character_graph_merge: 'character_graph_bootstrap',
  chapter_labeling: 'character_graph_merge',
  tts_ready_preparation: 'chapter_labeling',
};

export interface NativeBookWorkflowPlanHashPayload {
  readonly schemaVersion: typeof NATIVE_BOOK_WORKFLOW_PLAN_SCHEMA_VERSION;
  readonly novelId: string;
  readonly contentRevision: string;
  readonly stages: readonly {
    readonly stage: NativeWorkflowStage;
    readonly itemIds: readonly string[];
  }[];
}

export interface BuildNativeBookWorkflowSubmitRequestInput {
  readonly plan: BookAIWorkflowPlan;
  readonly contentRevision: string;
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly idempotencyKey?: string;
  readonly requestsByJobId?: Readonly<Record<string, NativeStructuredJsonRequest>>;
  readonly compactExecutionManifest?: NativeCompactExecutionManifestV3;
}

function nativeWorkflowIdempotencyKey(input: {
  readonly workflowDefinitionId: ExtensionContributionId;
  readonly workflowVersion: string;
  readonly planHash: string;
}): string {
  const workflowDefinitionId = input.workflowDefinitionId.trim();
  const workflowVersion = input.workflowVersion.trim();
  if (!workflowDefinitionId || !workflowVersion) {
    throw new Error('Native workflow definition id and version are required');
  }
  return structuredIntegrityHash({ workflowDefinitionId, workflowVersion, planHash: input.planHash });
}

export interface NativeCompactExecutionJobV3 {
  readonly id: string;
  readonly jobType: NativeWorkflowJobType;
  readonly contractFingerprint?: string;
  readonly request?: NativeStructuredJsonRequest;
}

export interface NativeCompactExecutionStageV3 {
  readonly stage: NativeWorkflowStage;
  readonly jobs: readonly NativeCompactExecutionJobV3[];
}

export interface NativeCompactExecutionManifestV3 {
  readonly schemaVersion: typeof NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION;
  readonly stages: readonly NativeCompactExecutionStageV3[];
}

export function buildNativeCompactExecutionManifest(
  plan: BookAIWorkflowPlan,
  contractFingerprint: string,
): NativeCompactExecutionManifestV3 {
  assertCanonicalPlan(plan);
  const fingerprint = contractFingerprint.trim();
  if (!fingerprint) throw new Error('Native compact speaker contract fingerprint is required');
  return {
    schemaVersion: NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION,
    stages: [
      {
        stage: 'character_graph_bootstrap',
        jobs: plan.bundleWindows.map((window) => ({
          id: window.id,
          jobType: 'character_bundle_analysis' as const,
        })),
      },
      {
        stage: 'character_graph_merge',
        jobs: [{ id: BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID, jobType: 'character_graph_merge' as const }],
      },
      {
        stage: 'chapter_labeling',
        jobs: plan.labelingWindows.map((window) => ({
          id: window.id,
          jobType: 'speaker_attribution_v3' as const,
          contractFingerprint: fingerprint,
        })),
      },
      { stage: 'tts_ready_preparation', jobs: [] },
    ],
  };
}

function stageItemIds(plan: BookAIWorkflowPlan, stageId: BookAIWorkflowStageId): readonly string[] {
  const stage = plan.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Native workflow plan is missing stage: ${stageId}`);
  return stage.itemIds;
}

function sameItems(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function assertCanonicalPlan(plan: BookAIWorkflowPlan): void {
  if (
    plan.stages.length !== canonicalStageOrder.length ||
    plan.stages.some(
      (stage, index) => stage.id !== canonicalStageOrder[index] || stage.dependsOn !== canonicalDependencies[stage.id],
    )
  ) {
    throw new Error('Native workflow plan must contain the four canonical stages');
  }
  const expectedItems: Readonly<Record<BookAIWorkflowStageId, readonly string[]>> = {
    character_graph_bootstrap: plan.bundleWindows.map((window) => window.id),
    character_graph_merge: [BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID],
    chapter_labeling: plan.labelingWindows.map((window) => window.id),
    tts_ready_preparation: plan.ttsReady.chapterIds,
  };
  for (const stage of plan.stages) {
    if (!sameItems(stage.itemIds, expectedItems[stage.id])) {
      throw new Error(`Native workflow plan items do not match materialization windows: ${stage.id}`);
    }
  }
}

export function nativeBookWorkflowPlanHashPayload(
  plan: BookAIWorkflowPlan,
  contentRevision: string,
): NativeBookWorkflowPlanHashPayload {
  assertCanonicalPlan(plan);
  const stages = canonicalStageOrder.map((stage) => ({
    stage,
    itemIds: stage === 'tts_ready_preparation' ? [] : [...stageItemIds(plan, stage)],
  }));
  if (stages[1].itemIds.length !== 1 || stages[1].itemIds[0] !== BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID) {
    throw new Error('Native workflow graph merge stage must contain the canonical merge item');
  }
  return {
    schemaVersion: NATIVE_BOOK_WORKFLOW_PLAN_SCHEMA_VERSION,
    novelId: plan.novelId,
    contentRevision,
    stages,
  };
}

export function nativeBookWorkflowPlanHash(plan: BookAIWorkflowPlan, contentRevision: string): string {
  return structuredIntegrityHash(nativeBookWorkflowPlanHashPayload(plan, contentRevision));
}

export function nativeCompactBookWorkflowPlanHash(
  plan: BookAIWorkflowPlan,
  contentRevision: string,
  contractFingerprint: string,
): string {
  const manifest = buildNativeCompactExecutionManifest(plan, contractFingerprint);
  return structuredIntegrityHash(nativeCompactExecutionPlanHashPayload({ plan, contentRevision, manifest }));
}

function plannedJobs(
  itemIds: readonly string[],
  requestsByJobId: Readonly<Record<string, NativeStructuredJsonRequest>> | undefined,
) {
  return itemIds.map((id) => ({
    id,
    ...(requestsByJobId?.[id] ? { request: requestsByJobId[id] } : {}),
  }));
}

function expectedJobType(stage: NativeWorkflowStage): NativeWorkflowJobType | undefined {
  if (stage === 'character_graph_bootstrap') return 'character_bundle_analysis';
  if (stage === 'character_graph_merge') return 'character_graph_merge';
  if (stage === 'chapter_labeling') return 'speaker_attribution_v3';
  return undefined;
}

function compactExecutionStages(manifest: NativeCompactExecutionManifestV3): NativeBookWorkflowStageRequest[] {
  if (
    manifest.schemaVersion !== NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION ||
    manifest.stages.length !== canonicalStageOrder.length ||
    manifest.stages.some((stage, index) => stage.stage !== canonicalStageOrder[index])
  ) {
    throw new Error('Native compact execution manifest must contain the four canonical stages');
  }
  const ids = new Set<string>();
  return manifest.stages.map((stage) => {
    const expected = expectedJobType(stage.stage);
    if (stage.stage === 'tts_ready_preparation' ? stage.jobs.length > 0 : stage.jobs.length === 0) {
      throw new Error(`Native compact execution manifest has an invalid job count: ${stage.stage}`);
    }
    if (stage.stage === 'character_graph_merge' && stage.jobs.length !== 1) {
      throw new Error('Native compact execution manifest must contain one graph merge job');
    }
    return {
      stage: stage.stage,
      jobs: stage.jobs.map((job) => {
        if (!job.id.trim() || ids.has(job.id) || job.jobType !== expected) {
          throw new Error(`Native compact execution job identity is invalid: ${job.id}`);
        }
        ids.add(job.id);
        if (job.jobType === 'speaker_attribution_v3') {
          if (!job.contractFingerprint?.trim()) {
            throw new Error(`Native compact speaker job contract fingerprint is missing: ${job.id}`);
          }
        } else if (job.contractFingerprint !== undefined) {
          throw new Error(`Native non-speaker job must not carry a labeling contract fingerprint: ${job.id}`);
        }
        return {
          id: job.id,
          jobType: job.jobType,
          ...(job.contractFingerprint ? { contractFingerprint: job.contractFingerprint } : {}),
          ...(job.request ? { request: job.request } : {}),
        };
      }),
    };
  });
}

export function nativeCompactExecutionPlanHashPayload(input: {
  readonly plan: BookAIWorkflowPlan;
  readonly contentRevision: string;
  readonly manifest: NativeCompactExecutionManifestV3;
}) {
  assertCanonicalPlan(input.plan);
  const stages = compactExecutionStages(input.manifest);
  const expectedIds: Readonly<Record<NativeWorkflowStage, readonly string[]>> = {
    character_graph_bootstrap: input.plan.bundleWindows.map((window) => window.id),
    character_graph_merge: [BOOK_AI_CHARACTER_GRAPH_MERGE_ITEM_ID],
    chapter_labeling: input.plan.labelingWindows.map((window) => window.id),
    tts_ready_preparation: [],
  };
  for (const stage of stages) {
    if (
      !sameItems(
        stage.jobs.map((job) => job.id),
        expectedIds[stage.stage],
      )
    ) {
      throw new Error(`Native compact execution jobs do not match logical plan windows: ${stage.stage}`);
    }
  }
  return {
    schemaVersion: NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION,
    novelId: input.plan.novelId,
    contentRevision: input.contentRevision,
    stages: stages.map((stage) => ({
      stage: stage.stage,
      jobs: stage.jobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        ...(job.contractFingerprint ? { contractFingerprint: job.contractFingerprint } : {}),
      })),
    })),
  };
}

export function buildNativeBookWorkflowSubmitRequest(
  input: BuildNativeBookWorkflowSubmitRequestInput,
): NativeBookWorkflowSubmitRequest {
  if (input.compactExecutionManifest) {
    if (input.requestsByJobId) {
      throw new Error('Native compact execution requests must be pinned in the execution manifest');
    }
    const stages = compactExecutionStages(input.compactExecutionManifest);
    const planHash = structuredIntegrityHash(
      nativeCompactExecutionPlanHashPayload({
        plan: input.plan,
        contentRevision: input.contentRevision,
        manifest: input.compactExecutionManifest,
      }),
    );
    return {
      schemaVersion: NATIVE_BOOK_WORKFLOW_COMPACT_EXECUTION_SCHEMA_VERSION,
      idempotencyKey:
        input.idempotencyKey?.trim() ||
        nativeWorkflowIdempotencyKey({
          workflowDefinitionId: input.workflowDefinitionId,
          workflowVersion: input.workflowVersion,
          planHash,
        }),
      novelId: input.plan.novelId,
      contentRevision: input.contentRevision,
      planHash,
      stages,
    };
  }
  const payload = nativeBookWorkflowPlanHashPayload(input.plan, input.contentRevision);
  const planHash = structuredIntegrityHash(payload);
  const stages: NativeBookWorkflowStageRequest[] = payload.stages.map(({ stage, itemIds }) => ({
    stage,
    jobs: plannedJobs(itemIds, input.requestsByJobId),
  }));
  return {
    idempotencyKey:
      input.idempotencyKey?.trim() ||
      nativeWorkflowIdempotencyKey({
        workflowDefinitionId: input.workflowDefinitionId,
        workflowVersion: input.workflowVersion,
        planHash,
      }),
    novelId: input.plan.novelId,
    contentRevision: input.contentRevision,
    planHash,
    stages,
  };
}
