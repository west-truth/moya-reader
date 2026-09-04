export const IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS = 650;

export function createImportProgressUpdateThrottle(
  intervalMs = IMPORT_JOB_PROGRESS_WRITE_INTERVAL_MS,
): (nowMs?: number) => boolean {
  let lastUpdateAt = Number.NEGATIVE_INFINITY;
  return (nowMs = performance.now()) => {
    if (nowMs - lastUpdateAt < intervalMs) return false;
    lastUpdateAt = nowMs;
    return true;
  };
}
