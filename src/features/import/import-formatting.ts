import type { ChapterSplitMode } from '../../domain/types';
import { clamp, formatCount } from '../../utils/format';

export function formatImportBytes(value: number): string {
  if (value >= 1024 * 1024) return `${formatCount(Math.round(value / (1024 * 1024)))} MB`;
  if (value >= 1024) return `${formatCount(Math.round(value / 1024))} KB`;
  return `${formatCount(value)} B`;
}

export function formatImportChapterSplitMode(mode: ChapterSplitMode | undefined): string {
  if (mode === 'mixed') return '혼합 표식';
  if (mode === 'single') return '분리 안 함';
  return '자동 감지';
}

export function importProgressPercent(bytesRead: number, totalBytes: number): number {
  return clamp(Math.round((bytesRead / Math.max(totalBytes, 1)) * 100), 0, 100);
}
