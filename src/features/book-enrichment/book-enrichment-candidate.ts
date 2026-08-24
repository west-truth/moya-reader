import { normalizeBookMetadataPatch } from '@noveldesk/text-core/library-metadata';
import type { Novel, BookAssetMetadata } from '../../domain/types';
import { integrityHash, persistentId128 } from '../../domain/id-hash-contract';
import { normalizeCoverImage } from '../../services/cover-image';
import type { TrustedBookEnrichmentProviderContribution } from '../../extensions/trusted-extension-registry';
import {
  BOOK_ENRICHMENT_CANDIDATE_SCHEMA_VERSION,
  BOOK_ENRICHMENT_METADATA_FIELDS,
  type BookEnrichmentCandidate,
  type BookEnrichmentCandidateDraft,
  type BookEnrichmentMetadataField,
  type BookEnrichmentMetadataValues,
  type PublicBookMetadataSnapshot,
} from './book-enrichment-contract';

const metadataFieldSet = new Set<string>(BOOK_ENRICHMENT_METADATA_FIELDS);

export function publicBookMetadataSnapshot(
  novel: Novel,
  cover?: Pick<BookAssetMetadata, 'provenance' | 'contentHash'>,
): PublicBookMetadataSnapshot {
  return {
    bookId: novel.id,
    metadataRevision: novel.metadataRevision ?? 0,
    contentRevisionId: novel.activeContentRevisionId,
    sourceFileName: novel.sourceFileName.split(/[\\/]/u).at(-1),
    title: novel.title,
    author: novel.author,
    seriesTitle: novel.seriesTitle,
    seriesIndex: novel.seriesIndex,
    tags: [...(novel.tags ?? [])],
    description: novel.description,
    language: novel.language,
    readingDirection: novel.readingDirection,
    cover: {
      present: Boolean(novel.coverAssetId),
      provenance: cover?.provenance,
      contentHash: cover?.contentHash ?? novel.coverContentHash,
    },
  };
}

export function metadataValuesFromSnapshot(snapshot: PublicBookMetadataSnapshot): BookEnrichmentMetadataValues {
  return {
    title: snapshot.title,
    author: snapshot.author ?? null,
    seriesTitle: snapshot.seriesTitle ?? null,
    seriesIndex: snapshot.seriesIndex ?? null,
    tags: [...snapshot.tags],
    description: snapshot.description ?? null,
    language: snapshot.language ?? null,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  return normalized || undefined;
}

function candidateProvenance(
  provider: TrustedBookEnrichmentProviderContribution,
  draft: BookEnrichmentCandidateDraft,
  generatedAt: string,
) {
  if (
    draft.confidence !== undefined &&
    (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1)
  ) {
    throw new Error('Book enrichment confidence must be between 0 and 1.');
  }
  const sourceFingerprints = [...new Set(draft.sourceFingerprints ?? [])];
  if (sourceFingerprints.length > 16 || sourceFingerprints.some((value) => !value.trim() || value.length > 256)) {
    throw new Error('Book enrichment source fingerprints are invalid.');
  }
  return {
    extensionId: provider.extensionId,
    extensionVersion: provider.extensionVersion,
    contributionId: provider.descriptor.id,
    origin: 'bundled_trusted' as const,
    registrationFingerprint: integrityHash(
      new TextEncoder().encode(
        `${provider.extensionId}\u0000${provider.extensionVersion}\u0000${provider.descriptor.id}`,
      ),
    ),
    sourceFingerprints,
    providerId: boundedOptionalText(draft.providerId, 'providerId', 160),
    modelId: boundedOptionalText(draft.modelId, 'modelId', 160),
    generatedAt,
    confidence: draft.confidence,
    rationale: boundedOptionalText(draft.rationale, 'rationale', 500),
    sourceLabel: boundedOptionalText(draft.sourceLabel, 'sourceLabel', 300),
    sourceUrl: boundedOptionalText(draft.sourceUrl, 'sourceUrl', 2_048),
    licenseSummary: boundedOptionalText(draft.licenseSummary, 'licenseSummary', 1_000),
  };
}

function candidateId(providerId: string, snapshot: PublicBookMetadataSnapshot, kind: string, fingerprint: string) {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return persistentId128('book_enrichment_candidate', [
    providerId,
    snapshot.bookId,
    String(snapshot.metadataRevision),
    kind,
    fingerprint,
    nonce,
  ]);
}

async function prepareMetadataCandidate(
  provider: TrustedBookEnrichmentProviderContribution,
  snapshot: PublicBookMetadataSnapshot,
  draft: Extract<BookEnrichmentCandidateDraft, { kind: 'metadata' }>,
  generatedAt: string,
): Promise<BookEnrichmentCandidate | undefined> {
  const unknownFields = Object.keys(draft.patch).filter((field) => !metadataFieldSet.has(field));
  if (unknownFields.length > 0) throw new Error(`Book enrichment metadata field is not allowed: ${unknownFields[0]}`);
  const normalized = normalizeBookMetadataPatch(draft.patch);
  const baseValues = metadataValuesFromSnapshot(snapshot);
  const patch: Record<string, unknown> = {};
  for (const field of BOOK_ENRICHMENT_METADATA_FIELDS) {
    const value = normalized[field];
    if (value !== undefined && !sameValue(value, baseValues[field])) patch[field] = value;
  }
  if (Object.keys(patch).length === 0) return undefined;
  const fingerprint = integrityHash(new TextEncoder().encode(JSON.stringify(patch)));
  return {
    schemaVersion: BOOK_ENRICHMENT_CANDIDATE_SCHEMA_VERSION,
    id: candidateId(provider.descriptor.id, snapshot, draft.kind, fingerprint),
    bookId: snapshot.bookId,
    kind: 'metadata',
    status: 'pending',
    baseMetadataRevision: snapshot.metadataRevision,
    baseContentRevisionId: snapshot.contentRevisionId,
    baseValues,
    patch: patch as BookEnrichmentMetadataValues,
    provenance: candidateProvenance(provider, draft, generatedAt),
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
}

async function prepareCoverCandidate(
  provider: TrustedBookEnrichmentProviderContribution,
  snapshot: PublicBookMetadataSnapshot,
  draft: Extract<BookEnrichmentCandidateDraft, { kind: 'cover' }>,
  generatedAt: string,
): Promise<BookEnrichmentCandidate> {
  if (!draft.licenseSummary?.trim()) {
    throw new Error('Book enrichment cover candidates require a license or usage summary.');
  }
  if (!(draft.binary instanceof Blob)) throw new Error('Book enrichment cover binary must be a Blob.');
  const declaredContentType = draft.declaredContentType.trim().toLowerCase();
  const file = new File([draft.binary], draft.fileName, { type: declaredContentType });
  const cover = await normalizeCoverImage(file, {
    fit: draft.fit,
    positionX: draft.positionX,
    positionY: draft.positionY,
  });
  if (cover.contentType !== declaredContentType) {
    throw new Error('Book enrichment cover MIME declaration does not match its binary.');
  }
  const derivationFingerprint = draft.derivationFingerprint.trim();
  if (!derivationFingerprint || derivationFingerprint.length > 256) {
    throw new Error('Book enrichment cover derivation fingerprint is invalid.');
  }
  return {
    schemaVersion: BOOK_ENRICHMENT_CANDIDATE_SCHEMA_VERSION,
    id: candidateId(provider.descriptor.id, snapshot, draft.kind, cover.contentHash),
    bookId: snapshot.bookId,
    kind: 'cover',
    status: 'pending',
    baseMetadataRevision: snapshot.metadataRevision,
    baseContentRevisionId: snapshot.contentRevisionId,
    baseCover: snapshot.cover,
    cover,
    derivationFingerprint,
    provenance: candidateProvenance(provider, draft, generatedAt),
    createdAt: generatedAt,
    updatedAt: generatedAt,
  };
}

export async function prepareBookEnrichmentCandidates(
  provider: TrustedBookEnrichmentProviderContribution,
  snapshot: PublicBookMetadataSnapshot,
  drafts: readonly BookEnrichmentCandidateDraft[],
): Promise<BookEnrichmentCandidate[]> {
  if (drafts.length > 12) throw new Error('A book enrichment provider returned too many candidates.');
  const generatedAt = new Date().toISOString();
  const candidates: BookEnrichmentCandidate[] = [];
  for (const draft of drafts) {
    if (!provider.descriptor.capabilities.includes(draft.kind)) {
      throw new Error(`Book enrichment provider did not declare the ${draft.kind} capability.`);
    }
    const candidate =
      draft.kind === 'metadata'
        ? await prepareMetadataCandidate(provider, snapshot, draft, generatedAt)
        : await prepareCoverCandidate(provider, snapshot, draft, generatedAt);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function selectMetadataCandidateFields(
  candidate: Extract<BookEnrichmentCandidate, { kind: 'metadata' }>,
  selectedFields: readonly BookEnrichmentMetadataField[],
): BookEnrichmentMetadataValues {
  const selected = new Set(selectedFields);
  const patch: Record<string, unknown> = {};
  for (const field of BOOK_ENRICHMENT_METADATA_FIELDS) {
    if (selected.has(field) && candidate.patch[field] !== undefined) patch[field] = candidate.patch[field];
  }
  if (Object.keys(patch).length === 0) throw new Error('적용할 추천 항목을 선택하세요.');
  return normalizeBookMetadataPatch(patch) as BookEnrichmentMetadataValues;
}
