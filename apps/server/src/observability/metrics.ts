import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { ProviderErrorCategory } from '../providers/provider-error-classification.js';
import type { StructuredLogger } from './logger.js';

const metricPrefix = 'noveldesk:observability:v1';
const processHeartbeatKey = `${metricPrefix}:worker-process-heartbeat`;
const latencyKey = `${metricPrefix}:provider-job-latency`;
const errorKey = `${metricPrefix}:provider-job-errors`;
const latencyBucketsMs = [100, 500, 1_000, 5_000, 15_000, 60_000, 300_000] as const;
const providerJobTypes = new Set([
  'chapter_segment_labeling',
  'chapter_label_repair',
  'character_bundle_analysis',
  'character_graph_merge',
  'tts_synthesis',
]);
const providerOutcomes = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const providerErrorCategories = new Set<ProviderErrorCategory>([
  'auth',
  'quota',
  'missing_config',
  'schema',
  'retryable_network',
  'content_too_large',
  'unsupported',
  'cancelled',
  'unknown',
]);
const queueStates = ['waiting', 'active', 'delayed', 'failed'] as const;

interface MetricsRedisClient {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<unknown>;
  hincrbyfloat(key: string, field: string, increment: number): Promise<unknown>;
}

export type MetricsBackend = MetricsRedisClient;

export interface QueueMetricSource {
  readonly label: 'import' | 'provider';
  readonly queue: Pick<Queue, 'getJobCounts'>;
}

export interface ProviderJobMetricInput {
  readonly durationMs: number;
  readonly jobType?: string;
  readonly outcome: string;
  readonly errorCategory?: ProviderErrorCategory;
}

export class ObservabilityMetrics {
  constructor(
    private readonly backend: MetricsBackend,
    private readonly logger: StructuredLogger,
    private readonly now: () => number = Date.now,
    private readonly staleHeartbeatMs = workerHeartbeatStaleMs(),
  ) {}

  async processHeartbeat(): Promise<void> {
    await this.bestEffort('worker_process_heartbeat_write_failed', () =>
      this.backend.hset(processHeartbeatKey, 'process', String(this.now())),
    );
  }

  async observeProviderJob(input: ProviderJobMetricInput): Promise<void> {
    const jobType = normalizeProviderJobType(input.jobType);
    const outcome = normalizeProviderOutcome(input.outcome);
    const durationMs = Math.max(0, Math.round(Number.isFinite(input.durationMs) ? input.durationMs : 0));
    const bucketWrites = latencyBucketsMs
      .filter((boundary) => durationMs <= boundary)
      .map((boundary) => this.backend.hincrby(latencyKey, latencyField(jobType, outcome, `bucket_${boundary}`), 1));
    bucketWrites.push(this.backend.hincrby(latencyKey, latencyField(jobType, outcome, 'bucket_inf'), 1));
    bucketWrites.push(this.backend.hincrby(latencyKey, latencyField(jobType, outcome, 'count'), 1));

    await this.bestEffort('provider_job_metric_write_failed', async () => {
      await Promise.all([
        ...bucketWrites,
        this.backend.hincrbyfloat(latencyKey, latencyField(jobType, outcome, 'sum_ms'), durationMs),
        ...(input.errorCategory
          ? [this.backend.hincrby(errorKey, `${jobType}|${normalizeProviderErrorCategory(input.errorCategory)}`, 1)]
          : []),
      ]);
    });
  }

  async renderPrometheus(queues: readonly QueueMetricSource[]): Promise<string> {
    const lines = metricPreamble();
    await this.appendQueueMetrics(lines, queues);
    await this.appendStoredMetrics(lines);
    return `${lines.join('\n')}\n`;
  }

  private async appendQueueMetrics(lines: string[], queues: readonly QueueMetricSource[]): Promise<void> {
    for (const source of queues) {
      try {
        const counts = await source.queue.getJobCounts(...queueStates);
        lines.push(`noveldesk_queue_observation_up{queue="${source.label}"} 1`);
        for (const state of queueStates) {
          lines.push(`noveldesk_queue_depth{queue="${source.label}",state="${state}"} ${counts[state] ?? 0}`);
        }
      } catch {
        lines.push(`noveldesk_queue_observation_up{queue="${source.label}"} 0`);
      }
    }
  }

  private async appendStoredMetrics(lines: string[]): Promise<void> {
    try {
      const [heartbeats, latencies, errors] = await Promise.all([
        this.backend.hgetall(processHeartbeatKey),
        this.backend.hgetall(latencyKey),
        this.backend.hgetall(errorKey),
      ]);
      lines.push('noveldesk_observability_store_up 1');
      this.appendProcessHeartbeatMetrics(lines, heartbeats);
      appendLatencyMetrics(lines, latencies);
      appendProviderErrorMetrics(lines, errors);
    } catch {
      lines.push('noveldesk_observability_store_up 0');
      this.appendProcessHeartbeatMetrics(lines, {});
    }
  }

  private appendProcessHeartbeatMetrics(lines: string[], heartbeats: Record<string, string>): void {
    const recordedAt = Number(heartbeats.process);
    const ageMs = Number.isFinite(recordedAt) && recordedAt > 0 ? Math.max(0, this.now() - recordedAt) : NaN;
    lines.push(
      `noveldesk_worker_process_heartbeat_age_seconds ${Number.isFinite(ageMs) ? (ageMs / 1000).toFixed(3) : 'NaN'}`,
    );
    lines.push(
      `noveldesk_worker_process_heartbeat_stale ${!Number.isFinite(ageMs) || ageMs > this.staleHeartbeatMs ? 1 : 0}`,
    );
  }

  private async bestEffort(event: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.warn(event, { errorName: error instanceof Error ? error.name : 'Error' });
    }
  }
}

export function metricsFromQueue(
  queue: Pick<Queue, 'client'>,
  logger: StructuredLogger,
  options: { now?: () => number; staleHeartbeatMs?: number } = {},
): ObservabilityMetrics {
  const backend = new LazyQueueMetricsBackend(queue);
  return new ObservabilityMetrics(backend, logger, options.now, options.staleHeartbeatMs);
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  metrics: ObservabilityMetrics,
  queues: readonly QueueMetricSource[],
): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    const body = await metrics.renderPrometheus(queues);
    return reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
  });
}

export function workerHeartbeatIntervalMs(): number {
  return positiveEnvironmentInteger('WORKER_HEARTBEAT_INTERVAL_MS', 15_000);
}

export function workerHeartbeatStaleMs(): number {
  return positiveEnvironmentInteger('WORKER_HEARTBEAT_STALE_MS', 60_000);
}

export function normalizeProviderJobType(value: string | undefined): string {
  return value && providerJobTypes.has(value) ? value : 'other';
}

export function normalizeProviderOutcome(value: string): string {
  return providerOutcomes.has(value) ? value : 'failed';
}

export function normalizeProviderErrorCategory(value: string): ProviderErrorCategory {
  return providerErrorCategories.has(value as ProviderErrorCategory) ? (value as ProviderErrorCategory) : 'unknown';
}

class LazyQueueMetricsBackend implements MetricsBackend {
  constructor(private readonly queue: Pick<Queue, 'client'>) {}

  async hgetall(key: string): Promise<Record<string, string>> {
    return (await this.client()).hgetall(key);
  }

  async hset(key: string, field: string, value: string): Promise<unknown> {
    return (await this.client()).hset(key, field, value);
  }

  async hincrby(key: string, field: string, increment: number): Promise<unknown> {
    return (await this.client()).hincrby(key, field, increment);
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<unknown> {
    return (await this.client()).hincrbyfloat(key, field, increment);
  }

  private async client(): Promise<MetricsRedisClient> {
    return (await this.queue.client) as unknown as MetricsRedisClient;
  }
}

function latencyField(jobType: string, outcome: string, statistic: string): string {
  return `${jobType}|${outcome}|${statistic}`;
}

function appendLatencyMetrics(lines: string[], values: Record<string, string>): void {
  for (const [field, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
    const [jobType, outcome, statistic] = field.split('|');
    if (!jobType || !outcome || !statistic || !Number.isFinite(Number(value))) continue;
    const labels = `job_type="${normalizeProviderJobType(jobType)}",outcome="${normalizeProviderOutcome(outcome)}"`;
    if (statistic === 'count') lines.push(`noveldesk_provider_job_latency_seconds_count{${labels}} ${value}`);
    else if (statistic === 'sum_ms') {
      lines.push(`noveldesk_provider_job_latency_seconds_sum{${labels}} ${(Number(value) / 1000).toFixed(6)}`);
    } else if (statistic.startsWith('bucket_')) {
      const bucket = statistic.slice('bucket_'.length);
      const boundary = bucket === 'inf' ? '+Inf' : String(Number(bucket) / 1000);
      lines.push(`noveldesk_provider_job_latency_seconds_bucket{${labels},le="${boundary}"} ${value}`);
    }
  }
}

function appendProviderErrorMetrics(lines: string[], values: Record<string, string>): void {
  for (const [field, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
    const [jobType, category] = field.split('|');
    if (!jobType || !category || !Number.isFinite(Number(value))) continue;
    lines.push(
      `noveldesk_provider_errors_total{job_type="${normalizeProviderJobType(jobType)}",category="${normalizeProviderErrorCategory(category)}"} ${value}`,
    );
  }
}

function metricPreamble(): string[] {
  return [
    '# HELP noveldesk_queue_depth BullMQ jobs by bounded queue and state.',
    '# TYPE noveldesk_queue_depth gauge',
    '# HELP noveldesk_queue_observation_up Whether queue depth collection succeeded.',
    '# TYPE noveldesk_queue_observation_up gauge',
    '# HELP noveldesk_worker_process_heartbeat_age_seconds Seconds since any worker process heartbeat.',
    '# TYPE noveldesk_worker_process_heartbeat_age_seconds gauge',
    '# HELP noveldesk_worker_process_heartbeat_stale Whether the worker process heartbeat is missing or stale.',
    '# TYPE noveldesk_worker_process_heartbeat_stale gauge',
    '# HELP noveldesk_provider_job_latency_seconds Provider queue job lifecycle latency.',
    '# TYPE noveldesk_provider_job_latency_seconds histogram',
    '# HELP noveldesk_provider_errors_total Provider job failures by safe category.',
    '# TYPE noveldesk_provider_errors_total counter',
    '# HELP noveldesk_observability_store_up Whether shared observability state was readable.',
    '# TYPE noveldesk_observability_store_up gauge',
  ];
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
