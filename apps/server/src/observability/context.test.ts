import Fastify from 'fastify';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { currentCorrelationContext, runWithCorrelation } from './context.js';
import { registerRequestObservability } from './fastify.js';
import { createStructuredLogger, type LogSink } from './logger.js';
import { ObservabilityMetrics, type MetricsBackend } from './metrics.js';
import { observeProviderJobExecution } from './worker.js';

describe('observability correlation', () => {
  it('propagates request correlation through async handlers and response headers', async () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'api', sink: lineSink(lines) });
    const app = Fastify({ logger: false });
    registerRequestObservability(app, logger);
    app.get('/jobs/:jobId/workflows/:workflowId', async () => {
      await Promise.resolve();
      logger.info('handler_observed');
      return { correlationId: currentCorrelationContext()?.correlationId };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/jobs/job_1/workflows/workflow_1',
      headers: { 'x-request-id': 'request_1', 'x-correlation-id': 'correlation_1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('request_1');
    expect(response.headers['x-correlation-id']).toBe('correlation_1');
    expect(response.json()).toEqual({ correlationId: 'correlation_1' });
    expect(parsedEvent(lines, 'handler_observed')).toMatchObject({
      requestId: 'request_1',
      correlationId: 'correlation_1',
      jobId: 'job_1',
      workflowId: 'workflow_1',
    });
    await app.close();
  });

  it('keeps nested async correlation isolated', async () => {
    await runWithCorrelation({ correlationId: 'outer' }, async () => {
      expect(currentCorrelationContext()?.correlationId).toBe('outer');
      await runWithCorrelation({ correlationId: 'inner' }, async () => {
        await Promise.resolve();
        expect(currentCorrelationContext()?.correlationId).toBe('inner');
      });
      expect(currentCorrelationContext()?.correlationId).toBe('outer');
    });
  });

  it('adds job, attempt, and workflow correlation to provider lifecycle logs', async () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'worker', sink: lineSink(lines) });
    const backend = new MemoryMetricsBackend();
    const metrics = new ObservabilityMetrics(backend, logger, () => 1_000);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ job_type: 'tts_synthesis', status: 'running', workflow_id: 'workflow_7' }],
      })
      .mockResolvedValueOnce({
        rows: [{ job_type: 'tts_synthesis', status: 'succeeded', workflow_id: 'workflow_7' }],
      });
    const pool = { query } as unknown as pg.Pool;

    await observeProviderJobExecution(pool, metrics, logger, { jobId: 'job_7', attemptId: 'attempt_7' }, async () => {
      await Promise.resolve();
      logger.info('provider_boundary_observed');
    });

    expect(parsedEvent(lines, 'provider_boundary_observed')).toMatchObject({
      correlationId: 'workflow_7',
      jobId: 'job_7',
      attemptId: 'attempt_7',
      workflowId: 'workflow_7',
    });
    expect(parsedEvent(lines, 'provider_job_finished')).toMatchObject({
      jobType: 'tts_synthesis',
      outcome: 'succeeded',
    });
  });
});

function parsedEvent(lines: string[], event: string): Record<string, unknown> | undefined {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.event === event);
}

function lineSink(lines: string[]): LogSink {
  return { write: (line) => void lines.push(line) };
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
    const existing = this.hashes.get(key);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.hashes.set(key, created);
    return created;
  }

  private increment(key: string, field: string, increment: number): void {
    const hash = this.hash(key);
    hash.set(field, String(Number(hash.get(field) ?? 0) + increment));
  }
}
