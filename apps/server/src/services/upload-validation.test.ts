import { describe, expect, it } from 'vitest';
import {
  MAX_REPORTED_MISSING_CHUNKS,
  MAX_UPLOAD_CHUNKS,
  summarizeUploadProgress,
  validateChunkIndex,
  validateUploadCompleteness,
  validateUploadChunkPlan,
  validateUploadSize,
} from './upload-validation.js';

describe('upload validation', () => {
  it('accepts complete contiguous chunks with matching bytes', () => {
    const result = validateUploadCompleteness({
      expectedBytes: 11,
      totalChunks: 3,
      chunks: [
        { chunkIndex: 0, sizeBytes: 4 },
        { chunkIndex: 1, sizeBytes: 4 },
        { chunkIndex: 2, sizeBytes: 3 },
      ],
    });

    expect(result).toEqual({ ok: true, expectedChunks: 3, uploadedBytes: 11 });
  });

  it('rejects missing chunks before import is queued', () => {
    const result = validateUploadCompleteness({
      expectedBytes: 11,
      totalChunks: 3,
      chunks: [
        { chunkIndex: 0, sizeBytes: 4 },
        { chunkIndex: 2, sizeBytes: 3 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing');
      expect(result.missingChunkIndexes).toEqual([1]);
    }
  });

  it('rejects byte totals that do not match the declared file size', () => {
    const result = validateUploadCompleteness({
      expectedBytes: 12,
      totalChunks: 2,
      chunks: [
        { chunkIndex: 0, sizeBytes: 4 },
        { chunkIndex: 1, sizeBytes: 4 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('do not match');
      expect(result.uploadedBytes).toBe(8);
    }
  });

  it('rejects chunk indexes outside the declared upload range', () => {
    expect(validateChunkIndex(0, 2)).toBeUndefined();
    expect(validateChunkIndex(2, 2)).toContain('outside declared totalChunks');
  });

  it('enforces absolute chunk bounds and a feasible declared chunk plan', () => {
    expect(validateChunkIndex(MAX_UPLOAD_CHUNKS)).toContain('maximum supported');
    expect(
      validateUploadChunkPlan({
        sizeBytes: MAX_UPLOAD_CHUNKS + 1,
        totalChunks: MAX_UPLOAD_CHUNKS + 1,
        maxChunkBytes: 1,
      }),
    ).toContain('maximum supported');
    expect(validateUploadChunkPlan({ sizeBytes: 10, totalChunks: 11, maxChunkBytes: 10 })).toContain('cannot exceed');
    expect(validateUploadChunkPlan({ sizeBytes: 11, totalChunks: 1, maxChunkBytes: 10 })).toContain('cannot carry');
    expect(validateUploadChunkPlan({ sizeBytes: 11, totalChunks: 2, maxChunkBytes: 10 })).toBeUndefined();
  });

  it('bounds missing chunk details even for the largest accepted plan', () => {
    const progress = summarizeUploadProgress({
      expectedBytes: MAX_UPLOAD_CHUNKS,
      totalChunks: MAX_UPLOAD_CHUNKS,
      chunks: [],
    });
    expect(progress.missingChunkIndexes).toHaveLength(MAX_REPORTED_MISSING_CHUNKS);
    expect(progress.missingChunkIndexesTruncated).toBe(true);
  });

  it('rejects files over the configured upload size', () => {
    expect(validateUploadSize(100, 100)).toBeUndefined();
    expect(validateUploadSize(101, 100)).toContain('exceeds');
  });

  it('summarizes upload progress for resume/status responses', () => {
    expect(
      summarizeUploadProgress({
        expectedBytes: 12,
        totalChunks: 4,
        chunks: [
          { chunkIndex: 0, sizeBytes: 4 },
          { chunkIndex: 2, sizeBytes: 4 },
        ],
      }),
    ).toEqual({
      expectedBytes: 12,
      expectedChunks: 4,
      uploadedBytes: 8,
      receivedChunkIndexes: [0, 2],
      missingChunkIndexes: [1, 3],
      missingChunkIndexesTruncated: false,
      complete: false,
    });
  });
});
