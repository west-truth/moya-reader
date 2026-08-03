import type { BookAnalysisWorkflow } from './book-analysis-workflow-gateway';

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function progressNumber(progress: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = progress?.[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type CompactSpeakerWorkflowStage =
  'source' | 'inventory' | 'snapshot' | 'attribution' | 'sequence' | 'escalation' | 'review' | 'complete';

export type CompactSpeakerRiskClass = 'candidate' | 'boundary' | 'temporal' | 'sequence' | 'semantic' | 'provider';

export interface CompactSpeakerRiskSummary {
  readonly riskClass: CompactSpeakerRiskClass;
  readonly label: string;
  readonly targetSpanCount: number;
}

export interface CompactSpeakerWorkflowView {
  readonly contractId: string;
  readonly requestProfileId?: string;
  readonly stage: CompactSpeakerWorkflowStage;
  readonly stageLabel: string;
  readonly targetSpanCount?: number;
  readonly sceneRequestCount?: number;
  readonly escalationCapLabel?: string;
  readonly riskSummaries: readonly CompactSpeakerRiskSummary[];
}

const COMPACT_SPEAKER_CONTRACT = 'speaker-attribution-workflow-v3';
const COMPACT_SPEAKER_PROFILE = 'speaker-attribution-v3-compact';
const COMPACT_SPEAKER_JOB_TYPE = 'speaker_attribution_v3';
const RISK_CLASS_ORDER: readonly CompactSpeakerRiskClass[] = [
  'candidate',
  'boundary',
  'temporal',
  'sequence',
  'semantic',
  'provider',
];
const RISK_CLASS_LABELS: Readonly<Record<CompactSpeakerRiskClass, string>> = {
  candidate: '화자 후보',
  boundary: '대화 경계',
  temporal: '시점 문맥',
  sequence: '대화 순서',
  semantic: '의미 모호성',
  provider: '제공자 실행',
};

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function compactStageLabel(
  stage: string | undefined,
  reviewOpen: boolean,
): {
  readonly stage: CompactSpeakerWorkflowStage;
  readonly stageLabel: string;
} {
  if (reviewOpen || stage === 'routing_speaker_review' || stage === 'needs_review') {
    return { stage: 'review', stageLabel: '검토 항목 분류' };
  }
  if (stage === 'escalating_speakers' || stage?.includes('escalation')) {
    return { stage: 'escalation', stageLabel: '모호 구간 재판별' };
  }
  if (stage === 'decoding_speaker_sequence' || stage?.includes('sequence')) {
    return { stage: 'sequence', stageLabel: '대화 순서 판정' };
  }
  if (stage === 'attributing_speakers' || stage?.includes('attribution')) {
    return { stage: 'attribution', stageLabel: '화자 판별' };
  }
  if (stage === 'loading_speaker_snapshot' || stage?.includes('snapshot')) {
    return { stage: 'snapshot', stageLabel: '문맥 스냅샷 준비' };
  }
  if (stage?.includes('inventory')) return { stage: 'inventory', stageLabel: '대화 구간 정리' };
  if (stage === 'ready' || stage === 'succeeded') return { stage: 'complete', stageLabel: '화자 분리 완료' };
  return { stage: 'source', stageLabel: '원문 고정' };
}

function riskSummaries(progress: Record<string, unknown>): readonly CompactSpeakerRiskSummary[] {
  const metadata = recordValue(progress.metadata);
  const manualReview = recordValue(progress.manualReview);
  const routes = arrayValue(progress.riskRoutes ?? metadata?.riskRoutes ?? manualReview?.riskRoutes);
  const spanIndexesByClass = new Map<CompactSpeakerRiskClass, Set<number>>();
  const routeCountByClass = new Map<CompactSpeakerRiskClass, number>();

  for (const route of routes) {
    const body = recordValue(route);
    const riskClass = stringValue(body?.riskClass);
    if (!riskClass || !RISK_CLASS_ORDER.includes(riskClass as CompactSpeakerRiskClass)) continue;
    const typedClass = riskClass as CompactSpeakerRiskClass;
    const targetIndexes = arrayValue(body?.targetSpanIndexes).filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    );
    if (targetIndexes.length > 0) {
      const indexes = spanIndexesByClass.get(typedClass) ?? new Set<number>();
      targetIndexes.forEach((index) => indexes.add(index));
      spanIndexesByClass.set(typedClass, indexes);
    } else {
      routeCountByClass.set(typedClass, (routeCountByClass.get(typedClass) ?? 0) + 1);
    }
  }

  return RISK_CLASS_ORDER.flatMap((riskClass) => {
    const targetSpanCount = spanIndexesByClass.get(riskClass)?.size ?? routeCountByClass.get(riskClass) ?? 0;
    return targetSpanCount > 0 ? [{ riskClass, label: RISK_CLASS_LABELS[riskClass], targetSpanCount }] : [];
  });
}

function escalationCapLabel(progress: Record<string, unknown>): string | undefined {
  const budget = recordValue(progress.budgetEstimate);
  const escalation = recordValue(progress.speakerEscalation);
  const ratio = finiteNumber(
    escalation?.configuredMaximumRatio,
    escalation?.maximumRatio,
    budget?.speakerEscalationMaximumRatio,
    budget?.escalationMaximumRatio,
    budget?.escalationCapRatio,
  );
  const targets = finiteNumber(
    escalation?.configuredMaximumTargets,
    escalation?.maximumTargets,
    budget?.speakerEscalationMaximumTargets,
    budget?.escalationMaximumTargets,
    budget?.escalationCapTargets,
  );
  const labels: string[] = [];
  if (ratio !== undefined && ratio >= 0) {
    labels.push(`최대 ${Math.round((ratio <= 1 ? ratio * 100 : ratio) * 10) / 10}%`);
  }
  if (targets !== undefined && targets >= 0) labels.push(`${Math.floor(targets)}개`);
  return labels.length > 0 ? labels.join(' / ') : undefined;
}

function compactJobProgress(workflow: BookAnalysisWorkflow):
  | {
      readonly progress: Record<string, unknown>;
      readonly stage?: string;
    }
  | undefined {
  const compactJobs = workflow.jobs.filter((link) => {
    const progress = recordValue(link.job?.progress);
    const sourceContext = recordValue(progress?.sourceContext);
    const budget = recordValue(progress?.budgetEstimate);
    return (
      link.job?.type === COMPACT_SPEAKER_JOB_TYPE ||
      sourceContext?.labelingContract === COMPACT_SPEAKER_CONTRACT ||
      budget?.requestProfileId === COMPACT_SPEAKER_PROFILE
    );
  });
  const current =
    [...compactJobs].reverse().find((link) => ['queued', 'running'].includes(link.job?.status ?? '')) ??
    compactJobs.at(-1);
  const progress = recordValue(current?.job?.progress);
  return progress ? { progress, stage: current?.job?.stage ?? current?.stage } : undefined;
}

export function bookAIWorkflowCompactSpeakerView(
  workflow?: BookAnalysisWorkflow,
): CompactSpeakerWorkflowView | undefined {
  if (!workflow) return undefined;
  const compact = compactJobProgress(workflow);
  if (!compact) return undefined;
  const { progress } = compact;
  const sourceContext = recordValue(progress.sourceContext);
  const budget = recordValue(progress.budgetEstimate);
  const manualReview = recordValue(progress.manualReview);
  const manualReviewStatus = stringValue(manualReview?.status);
  const reviewOpen = Boolean(
    manualReviewStatus && !['approved', 'promoted', 'superseded'].includes(manualReviewStatus),
  );
  const stage = compactStageLabel(compact.stage ?? workflow.stage, reviewOpen);
  return {
    contractId: stringValue(progress.labelingContract ?? sourceContext?.labelingContract) ?? COMPACT_SPEAKER_CONTRACT,
    requestProfileId: stringValue(budget?.requestProfileId ?? progress.requestProfileId),
    ...stage,
    targetSpanCount: finiteNumber(progress.targetSpanCount, budget?.targetSpanCount),
    sceneRequestCount: finiteNumber(progress.sceneRequestCount, budget?.sceneRequestCount),
    escalationCapLabel: escalationCapLabel(progress),
    riskSummaries: riskSummaries(progress),
  };
}

export function isTerminalBookAIWorkflow(workflow?: BookAnalysisWorkflow): boolean {
  return Boolean(workflow && ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(workflow.status));
}

export interface BookAIWorkflowControlStateInput {
  readonly workflow?: BookAnalysisWorkflow;
  readonly available: boolean;
  readonly hasNovel: boolean;
  readonly loading: boolean;
  readonly running: boolean;
  readonly anotherAnalysisRunning: boolean;
  readonly providerBlocked: boolean;
}

export function bookAIWorkflowControlState(input: BookAIWorkflowControlStateInput) {
  const { workflow } = input;
  const terminal = isTerminalBookAIWorkflow(workflow);
  const needsReview = workflow?.readiness.outcome === 'needs_review';
  return {
    terminal,
    needsReview,
    reviewItems: workflow?.readiness.reviewItems ?? [],
    labelVoiceReady: workflow?.readiness.outcome === 'ready_for_tts',
    busy: input.loading || input.running || Boolean(workflow && !terminal),
    retryDisabled:
      !input.available ||
      !input.hasNovel ||
      !workflow ||
      (!needsReview && workflow.status !== 'failed') ||
      input.running ||
      input.providerBlocked,
    cancelDisabled:
      !input.available ||
      !input.hasNovel ||
      !workflow ||
      ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(workflow.status),
    startDisabled:
      !input.available ||
      input.anotherAnalysisRunning ||
      input.running ||
      !input.hasNovel ||
      needsReview ||
      input.providerBlocked,
  };
}

export function bookAIWorkflowStageLabel(stage: string | undefined): string {
  if (stage === 'building_graph') return 'Character Graph 구축';
  if (stage === 'merging_graph') return 'Character Graph 병합';
  if (stage === 'labeling_chapters') return '화자/감정 라벨링';
  if (stage === 'tts_ready_preparation') return '라벨/음성 준비도 검증';
  if (stage === 'ready_for_tts') return '라벨/음성 매핑 준비됨';
  if (stage === 'audio_cache_ready') return '오디오 cache 준비됨';
  if (stage === 'needs_review') return '검토 필요';
  if (stage === 'cancelled') return '취소됨';
  return stage || '대기';
}

export function bookAIWorkflowProgress(workflow?: BookAnalysisWorkflow): {
  readonly totalBundleWindows: number;
  readonly totalLabelingWindows: number;
  readonly totalLabelingChapters: number;
  readonly childSucceeded: number;
  readonly childFailed: number;
  readonly childPending: number;
} {
  const progress = recordValue(workflow?.progress);
  return {
    totalBundleWindows: progressNumber(progress, 'totalBundleWindows') ?? workflow?.plan.bundleWindows.length ?? 0,
    totalLabelingWindows:
      progressNumber(progress, 'totalLabelingWindows') ?? workflow?.plan.labelingWindows.length ?? 0,
    totalLabelingChapters:
      progressNumber(progress, 'totalLabelingChapters') ?? workflow?.plan.labelingChapters.length ?? 0,
    childSucceeded: workflow?.jobs.filter((job) => job.job?.status === 'succeeded').length ?? 0,
    childFailed:
      workflow?.jobs.filter((job) => job.job?.status === 'failed' || job.job?.status === 'cancelled').length ?? 0,
    childPending:
      workflow?.jobs.filter((job) => !job.job || job.job.status === 'queued' || job.job.status === 'running').length ??
      0,
  };
}
