import { hashSync } from '../legacy-hash';
import { integrityHash, tagLegacySha256Hash } from '../id-hash-contract';
import { parsedChapterId, parsedNovelId } from '../identity/parser';

export const hash = integrityHash;
export const normalizeSourceHash = tagLegacySha256Hash;
export const novelId = parsedNovelId;
export const chapterId = parsedChapterId;

export function coverSeed(fileName: string): number {
  // This seed is visual metadata, so retaining FNV keeps existing book covers stable across the ID migration.
  return Number.parseInt(hashSync(fileName).slice(0, 4), 16);
}
