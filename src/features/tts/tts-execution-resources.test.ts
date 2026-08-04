import { describe, expect, it } from 'vitest';
import { abortPrefetchControllers, releasePrefetchController } from './tts-execution-resources';

describe('TTS execution resources', () => {
  it('does not let an old finally block remove a replacement prefetch controller', () => {
    const controllers = new Map<string, AbortController>();
    const oldController = new AbortController();
    const replacement = new AbortController();
    controllers.set('request-1', replacement);

    expect(releasePrefetchController(controllers, 'request-1', oldController)).toBe(false);
    expect(controllers.get('request-1')).toBe(replacement);
    expect(releasePrefetchController(controllers, 'request-1', replacement)).toBe(true);
    expect(controllers.has('request-1')).toBe(false);
  });

  it('aborts every pending prefetch before clearing the registry', () => {
    const first = new AbortController();
    const second = new AbortController();
    const controllers = new Map([
      ['first', first],
      ['second', second],
    ]);

    abortPrefetchControllers(controllers);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(controllers.size).toBe(0);
  });
});
