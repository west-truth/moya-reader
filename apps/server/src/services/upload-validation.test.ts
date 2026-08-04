import { describe, expect, it } from 'vitest';
import {
  summarizeUploadProgress,
  validateChunkIndex,
  validateUploadCompleteness,
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
      complete: false,
    });
  });
});
