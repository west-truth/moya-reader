import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuthHook } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { ProviderErrorCategory } from '../providers/provider-error-classification.js';
import { createStructuredLogger } from './logger.js';
import {
  normalizeProviderErrorCategory,
  normalizeProviderJobType,
  normalizeProviderOutcome,
  ObservabilityMetrics,
  registerMetricsRoute,
  type MetricsBackend,
} from './metrics.js';

describe('observability metrics', () => {
  it('bounds every worker-controlled metric label', async () => {
    const backend = new MemoryMetricsBackend();
    const metrics = createMetrics(backend, () => 10_000);

    await metrics.observeProviderJob({
      durationMs: 1_200,
      jobType: 'user-controlled-provider-id',
      outcome: 'arbitrary-outcome',
      errorCategory: 'arbitrary-error' as ProviderErrorCategory,
    });
    const output = await metrics.renderPrometheus([
      {
        label: 'provider',
        queue: { getJobCounts: async () => ({ waiting: 2, active: 1, delayed: 0, failed: 3 }) },
      },
    ]);

    expect(normalizeProviderJobType('user-controlled-provider-id')).toBe('other');
    expect(normalizeProviderOutcome('arbitrary-outcome')).toBe('failed');
    expect(normalizeProviderErrorCategory('arbitrary-error')).toBe('unknown');
    expect(output).toContain('job_type="other",outcome="failed"');
    expect(output).toContain('job_type="other",category="unknown"');
    expect(output).toContain('noveldesk_queue_depth{queue="provider",state="waiting"} 2');
    expect(output).not.toContain('user-controlled-provider-id');
    expect(output).not.toContain('arbitrary-outcome');
    expect(output).not.toContain('arbitrary-error');
  });

  it('reports a single process heartbeat and marks it stale only after the configured threshold', async () => {
    let now = 100_000;
    const backend = new MemoryMetricsBackend();
    const metrics = createMetrics(backend, () => now, 60_000);

    await metrics.processHeartbeat();
    let output = await metrics.renderPrometheus([]);
    expect(output).toContain('noveldesk_worker_process_heartbeat_age_seconds 0.000');
    expect(output).toContain('noveldesk_worker_process_heartbeat_stale 0');
    expect(output).not.toContain('worker="import"');
    expect(output).not.toContain('worker="provider"');

    now += 60_001;
    output = await metrics.renderPrometheus([]);
    expect(output).toContain('noveldesk_worker_process_heartbeat_age_seconds 60.001');
    expect(output).toContain('noveldesk_worker_process_heartbeat_stale 1');
  });

  it('keeps the metrics endpoint behind configured self-host authentication', async () => {
    const backend = new MemoryMetricsBackend();
    const metrics = createMetrics(backend, () => 10_000);
    const app = Fastify({ logger: false });
    await registerAuthHook(app, metricsTestConfig());
    await registerMetricsRoute(app, metrics, []);

    const denied = await app.inject({ method: 'GET', url: '/metrics' });
    const allowed = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('text/plain');
    expect(allowed.body).toContain('noveldesk_worker_process_heartbeat_age_seconds');
    await app.close();
  });
});

function createMetrics(backend: MetricsBackend, now: () => number, staleHeartbeatMs = 60_000): ObservabilityMetrics {
  const logger = createStructuredLogger({ service: 'worker', sink: { write: () => undefined } });
  return new ObservabilityMetrics(backend, logger, now, staleHeartbeatMs);
}

class MemoryMetricsBackend implements MetricsBackend {
  private readonly hashes = new Map<string, Map<string, string>>();

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this.hash(key).set(field, value);
  }

  async hincrby(key: string, field: string, increment: number): Promise<void> {
    this.increment(key, field, increment);
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<void> {
    this.increment(key, field, increment);
  }

  private hash(key: string): Map<string, string> {
    const current = this.hashes.get(key);
    if (current) return current;
    const created = new Map<string, string>();
    this.hashes.set(key, created);
    return created;
  }

  private increment(key: string, field: string, increment: number): void {
    const hash = this.hash(key);
    hash.set(field, String(Number(hash.get(field) ?? 0) + increment));
  }
}

function metricsTestConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
    redisUrl: 'redis://127.0.0.1:6379',
    dataDir: '.server-test-data',
    maxChunkBytes: 1_024,
    maxUploadBytes: 1_024,
    staleUploadMaxAgeMs: 0,
    runMigrationsOnStart: false,
    defaultUserId: 'user_test',
    authToken: 'metrics-token',
    s3: {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'test',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true,
    },
  };
}
