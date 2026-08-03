export interface UploadedChunkShape {
  chunkIndex: number;
  sizeBytes: number;
}

export interface UploadCompletenessInput {
  expectedBytes: number;
  totalChunks?: number | null;
  chunks: UploadedChunkShape[];
}

export interface UploadProgressSummary {
  expectedBytes: number;
  expectedChunks: number;
  uploadedBytes: number;
  receivedChunkIndexes: number[];
  missingChunkIndexes: number[];
  complete: boolean;
}

export interface UploadCompletenessOk {
  ok: true;
  expectedChunks: number;
  uploadedBytes: number;
}

export interface UploadCompletenessError {
  ok: false;
  error: string;
  expectedChunks: number;
  uploadedBytes: number;
  missingChunkIndexes: number[];
}

export type UploadCompletenessResult = UploadCompletenessOk | UploadCompletenessError;

export function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function validateChunkIndex(chunkIndex: number, totalChunks?: number | null): string | undefined {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) return 'chunkIndex must be a non-negative integer';
  if (totalChunks !== null && totalChunks !== undefined && chunkIndex >= totalChunks) {
    return `chunkIndex ${chunkIndex} is outside declared totalChunks ${totalChunks}`;
  }
  return undefined;
}

export function validateUploadSize(sizeBytes: number, maxUploadBytes: number): string | undefined {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) return undefined;
  if (sizeBytes > maxUploadBytes) {
    return `sizeBytes ${sizeBytes} exceeds max upload size ${maxUploadBytes}`;
  }
  return undefined;
}

export function summarizeUploadProgress(input: UploadCompletenessInput): UploadProgressSummary {
  const expectedBytes = input.expectedBytes;
  const expectedChunks = input.totalChunks ?? (input.chunks.length ? Math.max(...input.chunks.map((chunk) => chunk.chunkIndex)) + 1 : 0);
  const uploadedBytes = input.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  const receivedChunkIndexes = [...new Set(input.chunks.map((chunk) => chunk.chunkIndex))].sort((a, b) => a - b);
  const received = new Set(receivedChunkIndexes);
  const missingChunkIndexes: number[] = [];
  for (let index = 0; index < expectedChunks; index += 1) {
    if (!received.has(index)) missingChunkIndexes.push(index);
  }

  return {
    expectedBytes,
    expectedChunks,
    uploadedBytes,
    receivedChunkIndexes,
    missingChunkIndexes,
    complete: expectedChunks > 0 && missingChunkIndexes.length === 0 && uploadedBytes === expectedBytes,
  };
}

export function validateUploadCompleteness(input: UploadCompletenessInput): UploadCompletenessResult {
  const progress = summarizeUploadProgress(input);
  const { expectedBytes, expectedChunks, uploadedBytes, missingChunkIndexes } = progress;
  const invalidChunk = input.chunks.find(
    (chunk) =>
      !Number.isSafeInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= expectedChunks ||
      !Number.isSafeInteger(chunk.sizeBytes) ||
      chunk.sizeBytes <= 0,
  );

  if (expectedChunks <= 0) {
    return {
      ok: false,
      error: 'upload has no declared or stored chunks',
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
    };
  }

  if (invalidChunk) {
    return {
      ok: false,
      error: `upload has an invalid chunk at index ${invalidChunk.chunkIndex}`,
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
    };
  }

  if (missingChunkIndexes.length > 0) {
    return {
      ok: false,
      error: 'upload is missing one or more chunks',
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
    };
  }

  if (uploadedBytes !== expectedBytes) {
    return {
      ok: false,
      error: `uploaded bytes ${uploadedBytes} do not match declared sizeBytes ${expectedBytes}`,
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
    };
  }

  return { ok: true, expectedChunks, uploadedBytes };
}
