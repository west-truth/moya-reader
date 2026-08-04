import { describe, expect, it } from 'vitest';
import { verifyRealReaderPathContract } from './real-reader-path-contract.mjs';

describe('Phase 6 real reader path contract', () => {
  it('keeps the gate wired to worker import, IndexedDB storage, virtualization, and bounded search', async () => {
    const result = await verifyRealReaderPathContract(process.cwd());
    expect(result.results).toHaveLength(17);
    expect(result.results.filter((check) => !check.passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
