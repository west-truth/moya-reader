import { expect, test } from 'vitest';
import { createStructuredLogger } from '../observability/logger.js';
import { ImportMeasurements } from './import-measurements.js';

test('reports bounded phase times and byte/page counts through the redacting logger', () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({ service: 'worker', sink: { write: (line) => lines.push(line) } });
  let now = 0;
  const measurements = new ImportMeasurements(logger, 'job_test', () => now);
  now = 10;
  measurements.start('base_read_merge');
  now = 40;
  measurements.start('write_assets');
  measurements.counts.reusedPages = 83;
  measurements.counts.writtenPages = 65;
  now = 60;
  measurements.finish('not_committed');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: 'import_job_profile',
    jobId: 'job_test',
    outcome: 'not_committed',
    state: 'write_assets',
    durationMs: 60,
    reusedPages: 83,
    writtenPages: 65,
    phasesMs: { read_upload: 10, base_read_merge: 30, write_assets: 20 },
  });
  expect(() =>
    new ImportMeasurements(
      {
        info() {
          throw new Error('sink');
        },
      },
      'job_test',
    ).finish('noop'),
  ).not.toThrow();
});
