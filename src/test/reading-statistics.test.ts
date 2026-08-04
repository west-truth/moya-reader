import { describe, expect, it } from 'vitest';
import type { ReadingSessionEvent } from '../domain/types';
import { readingSessionsCsv, summarizeReadingSessions } from '../features/book-workspace/reading-statistics';

function event(overrides: Partial<ReadingSessionEvent>): ReadingSessionEvent {
  return {
    id: 'session-1',
    operationId: 'operation-1',
    deviceId: 'device-1',
    bookId: 'book-1',
    mode: 'reading',
    startedAt: '2026-07-12T01:00:00.000Z',
    endedAt: '2026-07-12T01:01:00.000Z',
    activeSeconds: 60,
    ...overrides,
  };
}

describe('reading statistics', () => {
  it('separates reading and listening while computing calendar periods', () => {
    const summary = summarizeReadingSessions(
      [
        event({ activeSeconds: 120 }),
        event({ id: 'session-2', operationId: 'operation-2', mode: 'listening', activeSeconds: 30 }),
        event({ id: 'old', operationId: 'old', endedAt: '2026-05-01T00:00:00.000Z', activeSeconds: 500 }),
      ],
      new Date('2026-07-12T12:00:00.000Z'),
    );

    expect(summary.readingSeconds).toBe(620);
    expect(summary.listeningSeconds).toBe(30);
    expect(summary.todaySeconds).toBe(150);
    expect(summary.sevenDaySeconds).toBe(150);
    expect(summary.daily.at(-1)).toMatchObject({ readingSeconds: 120, listeningSeconds: 30 });
  });

  it('exports stable CSV columns', () => {
    const csv = readingSessionsCsv([event({})]);
    expect(csv).toContain('activeSeconds');
    expect(csv).toContain('"book-1"');
  });
});
