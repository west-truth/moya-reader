import { expect, it } from 'vitest';
import { streamImageWindow } from './stream-image-window';

it('loads visible images first then five ahead and behind the viewport, nearest first', () => {
  expect(streamImageWindow([10, 11], 10, 100, 5)).toEqual([10, 11, 12, 9, 13, 8, 14, 7, 15, 6, 16, 5]);
});
it('tracks the viewport even when saved reading position lags during fast scrolling', () => {
  expect(streamImageWindow([20, 21], 10, 100, 2)).toEqual([10, 20, 21, 22, 19, 23, 18]);
});
it('handles the first and last page and a restored position before viewport measurement', () => {
  expect(streamImageWindow([], 0, 3, 5)).toEqual([0, 1, 2]);
  expect(streamImageWindow([2], 2, 3, 5)).toEqual([2, 1, 0]);
  expect(streamImageWindow([], 8, 100, 2)).toEqual([8, 9, 7, 10, 6]);
  expect(streamImageWindow([], 0, 0, 5)).toEqual([]);
});
it('disables speculative requests at zero and bounds malformed settings', () => {
  expect(streamImageWindow([10, 11], 10, 100, 0)).toEqual([10, 11]);
  expect(streamImageWindow([10], 10, 100, NaN)).toEqual([10]);
  expect(streamImageWindow([50], 50, 100, 999)).toHaveLength(21);
});
