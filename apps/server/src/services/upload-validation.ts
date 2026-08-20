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
  missingChunkIndexesTruncated: boolean;
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
  missingChunkIndexesTruncated: boolean;
}

export type UploadCompletenessResult = UploadCompletenessOk | UploadCompletenessError;

/** Hard stop independent of operator configuration, so status/missing-list work stays bounded. */
export const MAX_UPLOAD_CHUNKS = 65_536;
export const MAX_REPORTED_MISSING_CHUNKS = 256;

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
  if (chunkIndex >= MAX_UPLOAD_CHUNKS) {
    return `chunkIndex ${chunkIndex} exceeds the maximum supported chunk index ${MAX_UPLOAD_CHUNKS - 1}`;
  }
  if (totalChunks !== null && totalChunks !== undefined && chunkIndex >= totalChunks) {
    return `chunkIndex ${chunkIndex} is outside declared totalChunks ${totalChunks}`;
  }
  return undefined;
}

export function validateUploadChunkPlan(input: {
  sizeBytes: number;
  totalChunks?: number | null;
  maxChunkBytes: number;
}): string | undefined {
  if (input.totalChunks === null || input.totalChunks === undefined) return undefined;
  if (!Number.isSafeInteger(input.totalChunks) || input.totalChunks <= 0) {
    return 'totalChunks must be a positive integer when provided';
  }
  if (input.totalChunks > MAX_UPLOAD_CHUNKS) {
    return `totalChunks ${input.totalChunks} exceeds the maximum supported chunk count ${MAX_UPLOAD_CHUNKS}`;
  }
  if (input.totalChunks > input.sizeBytes) {
    return 'totalChunks cannot exceed sizeBytes because empty chunks are not accepted';
  }
  if (Number.isSafeInteger(input.maxChunkBytes) && input.maxChunkBytes > 0) {
    const minimumChunks = Math.ceil(input.sizeBytes / input.maxChunkBytes);
    if (input.totalChunks < minimumChunks) {
      return `totalChunks ${input.totalChunks} cannot carry sizeBytes ${input.sizeBytes} with maxChunkBytes ${input.maxChunkBytes}`;
    }
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
  const expectedChunks =
    input.totalChunks ?? (input.chunks.length ? Math.max(...input.chunks.map((chunk) => chunk.chunkIndex)) + 1 : 0);
  const uploadedBytes = input.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  const receivedChunkIndexes = [...new Set(input.chunks.map((chunk) => chunk.chunkIndex))].sort((a, b) => a - b);
  const received = new Set(receivedChunkIndexes.filter((chunkIndex) => chunkIndex >= 0 && chunkIndex < expectedChunks));
  const missingChunkIndexes: number[] = [];
  for (let index = 0; index < expectedChunks && missingChunkIndexes.length < MAX_REPORTED_MISSING_CHUNKS; index += 1) {
    if (!received.has(index)) missingChunkIndexes.push(index);
  }
  const missingChunkCount = Math.max(0, expectedChunks - received.size);

  return {
    expectedBytes,
    expectedChunks,
    uploadedBytes,
    receivedChunkIndexes,
    missingChunkIndexes,
    missingChunkIndexesTruncated: missingChunkCount > missingChunkIndexes.length,
    complete: expectedChunks > 0 && missingChunkCount === 0 && uploadedBytes === expectedBytes,
  };
}

export function validateUploadCompleteness(input: UploadCompletenessInput): UploadCompletenessResult {
  const progress = summarizeUploadProgress(input);
  const { expectedBytes, expectedChunks, uploadedBytes, missingChunkIndexes, missingChunkIndexesTruncated } = progress;
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
      missingChunkIndexesTruncated,
    };
  }

  if (invalidChunk) {
    return {
      ok: false,
      error: `upload has an invalid chunk at index ${invalidChunk.chunkIndex}`,
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
      missingChunkIndexesTruncated,
    };
  }

  if (missingChunkIndexes.length > 0) {
    return {
      ok: false,
      error: 'upload is missing one or more chunks',
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
      missingChunkIndexesTruncated,
    };
  }

  if (uploadedBytes !== expectedBytes) {
    return {
      ok: false,
      error: `uploaded bytes ${uploadedBytes} do not match declared sizeBytes ${expectedBytes}`,
      expectedChunks,
      uploadedBytes,
      missingChunkIndexes,
      missingChunkIndexesTruncated,
    };
  }

  return { ok: true, expectedChunks, uploadedBytes };
}
