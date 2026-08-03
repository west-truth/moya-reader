import type { ReadingSessionEvent } from '../../domain/types';

export interface ReadingStatisticsSummary {
  readonly readingSeconds: number;
  readonly listeningSeconds: number;
  readonly todaySeconds: number;
  readonly sevenDaySeconds: number;
  readonly thirtyDaySeconds: number;
  readonly daily: ReadonlyArray<{ date: string; readingSeconds: number; listeningSeconds: number }>;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function summarizeReadingSessions(
  events: readonly ReadingSessionEvent[],
  now = new Date(),
): ReadingStatisticsSummary {
  const today = startOfDay(now);
  const sevenDaysAgo = today - 6 * 86_400_000;
  const thirtyDaysAgo = today - 29 * 86_400_000;
  const dailyMap = new Map<string, { readingSeconds: number; listeningSeconds: number }>();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = localDateKey(new Date(today - offset * 86_400_000));
    dailyMap.set(date, { readingSeconds: 0, listeningSeconds: 0 });
  }
  let readingSeconds = 0;
  let listeningSeconds = 0;
  let todaySeconds = 0;
  let sevenDaySeconds = 0;
  let thirtyDaySeconds = 0;
  for (const event of events) {
    const seconds = Math.max(0, event.activeSeconds);
    if (event.mode === 'reading') readingSeconds += seconds;
    else listeningSeconds += seconds;
    const endedAt = Date.parse(event.endedAt);
    if (endedAt >= today) todaySeconds += seconds;
    if (endedAt >= sevenDaysAgo) sevenDaySeconds += seconds;
    if (endedAt >= thirtyDaysAgo) thirtyDaySeconds += seconds;
    const day = localDateKey(new Date(event.endedAt));
    const current = dailyMap.get(day);
    if (current) current[event.mode === 'reading' ? 'readingSeconds' : 'listeningSeconds'] += seconds;
  }
  return {
    readingSeconds,
    listeningSeconds,
    todaySeconds,
    sevenDaySeconds,
    thirtyDaySeconds,
    daily: Array.from(dailyMap, ([date, values]) => ({ date, ...values })),
  };
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function readingSessionsCsv(events: readonly ReadingSessionEvent[]): string {
  const header = ['id', 'bookId', 'mode', 'startedAt', 'endedAt', 'activeSeconds', 'deviceId', 'operationId'];
  return [
    header.join(','),
    ...events.map((event) => header.map((key) => csvCell(event[key as keyof ReadingSessionEvent])).join(',')),
  ].join('\r\n');
}
