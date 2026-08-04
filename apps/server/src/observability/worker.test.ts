import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStructuredLogger } from './logger.js';
import { startWorkerProcessHeartbeat } from './worker.js';

describe('worker process heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('writes one process heartbeat per interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const metrics = {
      processHeartbeat: async () => {
        writes.push('process');
      },
    };
    const logger = createStructuredLogger({ service: 'worker', sink: { write: () => undefined } });

    const heartbeat = startWorkerProcessHeartbeat(metrics, logger, 1_000);
    expect(writes).toEqual(['process']);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(writes).toEqual(['process', 'process', 'process', 'process']);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(4);
  });
});
