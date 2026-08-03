export function formatDateTime(value?: string): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('ko-KR').format(value);
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${formatCount(Math.round(value / (1024 * 1024)))} MB`;
  if (value >= 1024) return `${formatCount(Math.round(value / 1024))} KB`;
  return `${formatCount(value)} B`;
}

export function formatProgress(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
