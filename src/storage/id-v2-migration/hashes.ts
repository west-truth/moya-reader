import { hashSync } from '../../domain/hash';
import {
  integrityHash,
  integrityHashVersion,
  matchesIntegrityHash,
  tagLegacySha256Hash,
} from '../../domain/id-hash-contract';
import type { Paragraph } from '../../domain/types';
import { IdV2MigrationValidationError } from './errors';

export function canonicalStoredHash(
  stored: unknown,
  sourceText: string | undefined,
  label: string,
  entityType: 'book' | 'chapter' | 'paragraph' | 'page',
  entityId?: string,
): string {
  if (typeof stored !== 'string') {
    throw new IdV2MigrationValidationError('unknown_hash', `${label} has no supported hash`, entityType, entityId);
  }
  const version = integrityHashVersion(stored);
  if (version === 'unknown') {
    throw new IdV2MigrationValidationError(
      'unknown_hash',
      `${label} uses an unknown hash format`,
      entityType,
      entityId,
    );
  }
  if (sourceText !== undefined && !matchesIntegrityHash(stored, sourceText)) {
    throw new IdV2MigrationValidationError(
      'hash_mismatch',
      `${label} does not match its source text`,
      entityType,
      entityId,
    );
  }
  if (version === 'v2-sha256-tagged') return stored;
  if (version === 'v1-sha256') return tagLegacySha256Hash(stored);
  if (sourceText === undefined) {
    throw new IdV2MigrationValidationError(
      'unverifiable_fnv_hash',
      `${label} is FNV but its source text is unavailable`,
      entityType,
      entityId,
    );
  }
  return integrityHash(sourceText);
}

export function reconstructChapterText(paragraphs: Paragraph[], characterCount: number): string {
  const ordered = [...paragraphs].sort((left, right) => left.index - right.index);
  if (!ordered.length) return '';
  let length = Math.max(0, characterCount);
  let previousEnd = 0;
  for (const paragraph of ordered) {
    if (
      paragraph.startOffsetInChapter < 0 ||
      paragraph.endOffsetInChapter < paragraph.startOffsetInChapter ||
      paragraph.endOffsetInChapter - paragraph.startOffsetInChapter !== paragraph.text.length ||
      paragraph.startOffsetInChapter < previousEnd
    ) {
      throw new IdV2MigrationValidationError(
        'invalid_paragraph_offsets',
        `Paragraph ${paragraph.id} has invalid chapter offsets`,
        'paragraph',
        paragraph.id,
      );
    }
    length = Math.max(length, paragraph.endOffsetInChapter);
    previousEnd = paragraph.endOffsetInChapter;
  }

  const chunks: string[] = [];
  let cursor = 0;
  for (const paragraph of ordered) {
    if (paragraph.startOffsetInChapter > cursor) {
      chunks.push('\n'.repeat(paragraph.startOffsetInChapter - cursor));
    }
    chunks.push(paragraph.text);
    cursor = paragraph.endOffsetInChapter;
  }
  if (cursor < length) chunks.push('\n'.repeat(length - cursor));
  return chunks.join('');
}

export function verifyLegacyPageHash(stored: unknown, paragraphs: Paragraph[], pageId: string): void {
  if (typeof stored !== 'string') {
    throw new IdV2MigrationValidationError('unknown_hash', `Page ${pageId} has no supported hash`, 'page', pageId);
  }
  const version = integrityHashVersion(stored);
  const paragraphHashes = paragraphs.map((paragraph) => paragraph.textHash);
  if (version === 'v1-fnv32') {
    const legacyHashes = paragraphs.map((paragraph) => hashSync(paragraph.text));
    if (stored !== hashSync(legacyHashes.join(':'))) {
      throw new IdV2MigrationValidationError('hash_mismatch', `Page ${pageId} hash does not match`, 'page', pageId);
    }
    return;
  }
  const expected = JSON.stringify(paragraphHashes);
  if (!matchesIntegrityHash(stored, expected)) {
    throw new IdV2MigrationValidationError('hash_mismatch', `Page ${pageId} hash does not match`, 'page', pageId);
  }
}

export function canonicalPageHash(paragraphs: Paragraph[]): string {
  return integrityHash(JSON.stringify(paragraphs.map((paragraph) => paragraph.textHash)));
}

export function recordValueHash(value: Record<string, unknown>): string {
  return integrityHash(JSON.stringify(value));
}
