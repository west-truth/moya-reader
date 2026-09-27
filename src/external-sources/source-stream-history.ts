/** Device-only reading metadata. No source URL, credential, or image payload is stored. */
export interface SourceStreamPosition {
  page: number;
  count: number;
  fraction: number;
  ratio: number;
  updatedAt: number;
}
const key = 'moya.source-stream-positions.v1';
const maxAge = 180 * 86400000;
function entries(): [string, SourceStreamPosition][] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is [string, SourceStreamPosition] => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1]) return false;
        const p = entry[1];
        return (
          Number.isSafeInteger(p.page) &&
          p.page >= 0 &&
          Number.isSafeInteger(p.count) &&
          p.page < p.count &&
          Number.isFinite(p.fraction) &&
          p.fraction >= 0 &&
          p.fraction < 1 &&
          Number.isFinite(p.ratio) &&
          p.ratio > 0 &&
          p.ratio < 10000 &&
          Number.isFinite(p.updatedAt) &&
          p.updatedAt > Date.now() - maxAge
        );
      })
      .slice(-200);
  } catch {
    return [];
  }
}
export function readSourceStreamPosition(identity: string): SourceStreamPosition | undefined {
  return entries().find(([id]) => id === identity)?.[1];
}
export function saveSourceStreamPosition(identity: string, position: Omit<SourceStreamPosition, 'updatedAt'>): void {
  try {
    const next = entries().filter(([id]) => id !== identity);
    next.push([identity, { ...position, updatedAt: Date.now() }]);
    localStorage.setItem(key, JSON.stringify(next.slice(-200)));
  } catch {
    /* Reading remains available with browser storage disabled or full. */
  }
}
