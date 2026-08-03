import { textIntegrityHash } from '@noveldesk/text-core/hash';

export interface RepetitionEvidence {
  readonly partialOutputHash: string;
  readonly repetitionScore: number;
  readonly parsedItemCount?: number;
  readonly analyzedCharacters: number;
}

const MAX_ANALYZED_CHARACTERS = 262_144;

function repeatedChunkRatio(text: string, size: number): number {
  if (text.length < size * 2) return 0;
  const counts = new Map<string, number>();
  let total = 0;
  for (let offset = 0; offset + size <= text.length; offset += size) {
    const chunk = text.slice(offset, offset + size);
    if (!chunk.trim()) continue;
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
    total += 1;
  }
  if (total < 2) return 0;
  let repeated = 0;
  for (const count of counts.values()) repeated += Math.max(0, count - 1);
  return repeated / total;
}

function repeatedKeySequenceRatio(text: string): number {
  const keys = [...text.matchAll(/"([A-Za-z0-9_]{1,64})"\s*:/g)].map((match) => match[1]);
  if (keys.length < 8) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index + 4 <= keys.length; index += 4) {
    const sequence = keys.slice(index, index + 4).join('|');
    counts.set(sequence, (counts.get(sequence) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return total > 0 ? repeated / total : 0;
}

function largestArrayLength(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    return Math.max(value.length, ...value.map((item) => largestArrayLength(item, depth + 1) ?? 0));
  }
  const lengths = Object.values(value as Record<string, unknown>)
    .map((item) => largestArrayLength(item, depth + 1))
    .filter((item): item is number => item !== undefined);
  return lengths.length > 0 ? Math.max(...lengths) : undefined;
}

export function parsedOutputItemCount(text: string): number | undefined {
  try {
    return largestArrayLength(JSON.parse(text));
  } catch {
    const likelyRows = text.match(/\{\s*"(?:s|span|span_id|paragraph_id|paragraphIndex)"\s*:/g)?.length;
    return likelyRows && likelyRows > 0 ? likelyRows : undefined;
  }
}

export function analyzeRepetitionEvidence(text: string): RepetitionEvidence {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const analyzed =
    normalized.length > MAX_ANALYZED_CHARACTERS
      ? `${normalized.slice(0, MAX_ANALYZED_CHARACTERS / 2)}${normalized.slice(-MAX_ANALYZED_CHARACTERS / 2)}`
      : normalized;
  const chunkScore = Math.max(
    repeatedChunkRatio(analyzed, 16),
    repeatedChunkRatio(analyzed, 24),
    repeatedChunkRatio(analyzed, 32),
  );
  const keyScore = repeatedKeySequenceRatio(analyzed);
  const repetitionScore = Math.round(Math.min(1, chunkScore * 0.7 + keyScore * 0.3) * 1_000) / 1_000;
  return {
    partialOutputHash: textIntegrityHash(text),
    repetitionScore,
    parsedItemCount: parsedOutputItemCount(text),
    analyzedCharacters: analyzed.length,
  };
}
