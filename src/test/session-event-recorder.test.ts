import { describe, expect, it, vi } from 'vitest';
import { ActiveIntervalSessionRecorder } from '../features/reader/session-event-recorder';
import type { ReaderPersonalizationRepository } from '../repositories/reader-personalization-repository';
import type { ReadingSessionEvent } from '../domain/types';

describe('active interval session recorder', () => {
  it('stores only active time and excludes pauses', async () => {
    let now = Date.parse('2026-07-12T00:00:00.000Z');
    const appendReadingSession = vi.fn(async (_event: ReadingSessionEvent) => undefined);
    const repository = { appendReadingSession } as unknown as ReaderPersonalizationRepository;
    const recorder = new ActiveIntervalSessionRecorder(repository, 'book-1', 'listening', () => now);
    recorder.setActive(true);
    now += 2_400;
    recorder.setActive(false);
    now += 8_000;
    await recorder.flush();

    expect(appendReadingSession).toHaveBeenCalledOnce();
    expect(appendReadingSession.mock.calls[0][0]).toMatchObject({
      bookId: 'book-1',
      mode: 'listening',
      activeSeconds: 2,
    });
  });

  it('restores consumed listening time when persistence fails', async () => {
    let now = Date.parse('2026-07-12T00:00:00.000Z');
    const appendReadingSession = vi
      .fn<(event: ReadingSessionEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);
    const repository = { appendReadingSession } as unknown as ReaderPersonalizationRepository;
    const recorder = new ActiveIntervalSessionRecorder(repository, 'book-1', 'listening', () => now);
    recorder.setActive(true);
    now += 2_400;
    recorder.setActive(false);

    await expect(recorder.flush()).rejects.toThrow('temporary failure');
    expect(recorder.activeSeconds()).toBe(2);
    await recorder.flush();

    expect(appendReadingSession).toHaveBeenCalledTimes(2);
    expect(appendReadingSession.mock.calls[1][0].activeSeconds).toBe(2);
  });
});
