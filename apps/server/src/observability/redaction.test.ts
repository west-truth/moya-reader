import { describe, expect, it } from 'vitest';
import { createStructuredLogger, type LogSink } from './logger.js';

describe('structured log redaction', () => {
  it('never serializes secrets, endpoint URLs, credential paths, provider errors, or novel text', () => {
    const lines: string[] = [];
    const sink: LogSink = { write: (line) => void lines.push(line) };
    const logger = createStructuredLogger({ service: 'worker', sink, now: () => new Date('2026-07-10T00:00:00Z') });

    logger.error('provider_job_failed', {
      jobId: 'job_safe',
      apiKey: 'sk-super-secret',
      authorization: 'Bearer private-token',
      credentialPath: 'C:\\private\\service-account.json',
      endpointUrl: 'https://provider.example/v1/generate',
      requestBody: { prompt: 'the complete novel text' },
      novelText: 'raw chapter content',
      providerError: new Error('response included private-token and raw provider body'),
      nested: { content: 'another raw paragraph', safeLookingButUnknown: 'must not pass' },
    });

    const line = lines[0];
    expect(line).toContain('job_safe');
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('private-token');
    expect(line).not.toContain('service-account');
    expect(line).not.toContain('provider.example');
    expect(line).not.toContain('complete novel');
    expect(line).not.toContain('raw chapter');
    expect(line).not.toContain('raw provider body');
    expect(line).not.toContain('must not pass');
  });

  it('suppresses free-form Fastify messages while preserving safe identifiers', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'api', sink: { write: (line) => void lines.push(line) } });

    logger.fastify.error({ jobId: 'job_2', err: new Error('provider raw response') }, 'provider raw message');

    expect(lines[0]).toContain('"event":"application_log"');
    expect(lines[0]).toContain('job_2');
    expect(lines[0]).not.toContain('provider raw');
  });

  it('does not treat provider-controlled error names as a free-form field', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'worker', sink: { write: (line) => void lines.push(line) } });

    logger.error('provider_job_failed', { errorName: 'Error with raw provider body' });

    expect(lines[0]).toContain('"errorName":"Error"');
    expect(lines[0]).not.toContain('raw provider body');
  });

  it('redacts binary values before they can serialize as numeric objects', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ service: 'worker', sink: { write: (line) => void lines.push(line) } });
    const bytes = new TextEncoder().encode('binary-secret');

    logger.info('binary_payload_received', {
      buffer: Buffer.from(bytes),
      uint8Array: bytes,
      arrayBuffer: bytes.buffer,
      dataView: new DataView(bytes.buffer),
      typedArray: new Uint16Array(bytes.buffer, 0, 6),
    });

    const payload = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(payload).toMatchObject({
      buffer: '[REDACTED]',
      uint8Array: '[REDACTED]',
      arrayBuffer: '[REDACTED]',
      dataView: '[REDACTED]',
      typedArray: '[REDACTED]',
    });
    expect(lines[0]).not.toContain('binary-secret');
    expect(lines[0]).not.toContain('"0":98');
  });
});
