import { expect, it } from 'vitest';
import { taskProgressPercent } from './task-progress';
it('only presents a measured stage percentage and clears it when finalizing', () => {
  expect(taskProgressPercent({ phase: 'downloading', completed: 12, total: 28, unit: 'images' })).toBe(42);
  expect(taskProgressPercent({ phase: 'downloading', completed: 1024, unit: 'bytes' })).toBeUndefined();
  expect(taskProgressPercent({ phase: 'saving', completed: 999, total: 1000 })).toBe(99);
  expect(taskProgressPercent({ phase: 'finalizing', completed: 1000, total: 1000 })).toBeUndefined();
  expect(taskProgressPercent({ phase: 'saving', completed: NaN, total: 1000 })).toBeUndefined();
});
