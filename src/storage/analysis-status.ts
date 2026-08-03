import type { Novel } from '../domain/types';

const analysisStatuses = new Set<Novel['analysisStatus']>([
  'not_analyzed',
  'mock_ready',
  'queued',
  'building_graph',
  'analyzing_characters',
  'labeling_segments',
  'validating',
  'ready',
  'needs_review',
  'failed',
  'cancelled',
]);

export function analysisStatusValue(value: unknown): Novel['analysisStatus'] | undefined {
  return typeof value === 'string' && analysisStatuses.has(value as Novel['analysisStatus'])
    ? (value as Novel['analysisStatus'])
    : undefined;
}
