import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { Novel } from '../../domain/types';
import type { BookEnrichmentCandidate, BookEnrichmentMetadataField } from './book-enrichment-contract';

export type BookEnrichmentAutomaticApplyMode = 'off' | 'missing_fields';

export interface BookEnrichmentAutomationRunner {
  propose(
    bookId: string,
    contributionId: ExtensionContributionId,
    signal?: AbortSignal,
  ): Promise<readonly BookEnrichmentCandidate[]>;
  applyMetadata(candidateId: string, selectedFields: readonly BookEnrichmentMetadataField[]): Promise<unknown>;
  applyCover(candidateId: string): Promise<unknown>;
}

export interface BookEnrichmentBatchProgress {
  readonly state: 'idle' | 'running' | 'completed' | 'cancelled';
  readonly total: number;
  readonly completed: number;
  readonly matched: number;
  readonly applied: number;
  readonly failed: number;
  readonly skipped: number;
  readonly currentTitle?: string;
}

export interface BookEnrichmentBatchResult extends BookEnrichmentBatchProgress {
  readonly errors: readonly { readonly bookId: string; readonly title: string; readonly message: string }[];
}

export interface RunBookEnrichmentBatchInput {
  readonly runner: BookEnrichmentAutomationRunner;
  readonly providerId: ExtensionContributionId;
  readonly books: readonly Novel[];
  readonly automaticApply: BookEnrichmentAutomaticApplyMode;
  readonly signal?: AbortSignal;
  onProgress?(progress: BookEnrichmentBatchProgress): void;
}

export interface BookEnrichmentAutomaticApplyResult {
  readonly appliedCount: number;
  readonly errors: readonly string[];
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function sourceFileStem(sourceFileName: string): string {
  const baseName = sourceFileName.split(/[\\/]/u).at(-1) ?? sourceFileName;
  return baseName.replace(/\.[^.]+$/u, '').trim();
}

export function selectMissingMetadataFields(
  book: Novel,
  candidate: Extract<BookEnrichmentCandidate, { kind: 'metadata' }>,
): BookEnrichmentMetadataField[] {
  const fields: BookEnrichmentMetadataField[] = [];
  const patch = candidate.patch;
  const sourceDerivedTitle =
    sourceFileStem(book.sourceFileName).localeCompare(book.title.trim(), undefined, { sensitivity: 'base' }) === 0;

  if (sourceDerivedTitle && hasText(patch.title)) fields.push('title');
  if (!hasText(book.author) && hasText(patch.author)) fields.push('author');
  if (!hasText(book.seriesTitle) && hasText(patch.seriesTitle)) fields.push('seriesTitle');
  if (book.seriesIndex === undefined && patch.seriesIndex !== undefined && patch.seriesIndex !== null) {
    fields.push('seriesIndex');
  }
  if ((book.tags?.length ?? 0) === 0 && (patch.tags?.length ?? 0) > 0) fields.push('tags');
  if (!hasText(book.description) && hasText(patch.description)) fields.push('description');
  if (!hasText(book.language) && hasText(patch.language)) fields.push('language');
  return fields;
}

function eligibleAutomaticCandidateGroup(
  candidates: readonly BookEnrichmentCandidate[],
): readonly BookEnrichmentCandidate[] | undefined {
  const eligible = candidates.filter((candidate) => {
    const hint = candidate.provenance.automation;
    return (
      candidate.status === 'pending' &&
      hint?.autoApplyEligible === true &&
      (hint.matchType === 'exact_identity' ||
        hint.matchType === 'exact_title_and_author' ||
        hint.matchType === 'exact_title') &&
      hint.metadataQuality === 'full' &&
      hint.reasons.length === 0
    );
  });
  const groupIds = new Set(eligible.map((candidate) => candidate.proposalGroupId).filter(Boolean));
  if (groupIds.size !== 1 || eligible.some((candidate) => !candidate.proposalGroupId)) return undefined;
  const [groupId] = groupIds;
  return eligible.filter((candidate) => candidate.proposalGroupId === groupId);
}

export async function applyEligibleMissingEnrichment(
  runner: BookEnrichmentAutomationRunner,
  book: Novel,
  candidates: readonly BookEnrichmentCandidate[],
  signal?: AbortSignal,
): Promise<BookEnrichmentAutomaticApplyResult> {
  const group = eligibleAutomaticCandidateGroup(candidates);
  if (!group) return { appliedCount: 0, errors: [] };
  const metadata = group.find(
    (candidate): candidate is Extract<BookEnrichmentCandidate, { kind: 'metadata' }> => candidate.kind === 'metadata',
  );
  let cover = group.find(
    (candidate): candidate is Extract<BookEnrichmentCandidate, { kind: 'cover' }> => candidate.kind === 'cover',
  );
  let appliedCount = 0;
  let metadataApplied = false;
  const errors: string[] = [];
  if (metadata) {
    const fields = selectMissingMetadataFields(book, metadata);
    if (fields.length > 0) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      try {
        await runner.applyMetadata(metadata.id, fields);
        appliedCount += 1;
        metadataApplied = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '작품 정보를 자동 적용하지 못했습니다.');
      }
    }
  }
  if (!book.coverAssetId) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (!cover && metadataApplied) {
      try {
        const refreshed = await runner.propose(book.id, group[0]!.provenance.contributionId, signal);
        cover = eligibleAutomaticCandidateGroup(refreshed)?.find(
          (candidate): candidate is Extract<BookEnrichmentCandidate, { kind: 'cover' }> => candidate.kind === 'cover',
        );
        if (!cover || cover.baseCover.present) {
          errors.push('작품 정보는 적용했지만 최신 표지 후보를 확인하지 못했습니다.');
          return { appliedCount, errors };
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '최신 표지 후보를 다시 확인하지 못했습니다.');
        return { appliedCount, errors };
      }
    }
    if (!cover || cover.baseCover.present) return { appliedCount, errors };
    try {
      await runner.applyCover(cover.id);
      appliedCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '표지를 자동 적용하지 못했습니다.');
    }
  }
  return { appliedCount, errors };
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function bookNeedsEnrichment(book: Novel): boolean {
  if (book.deletedAt) return false;
  const hasCover = Boolean(book.coverAssetId);
  const hasCoreMetadata = hasText(book.author) && (hasText(book.description) || (book.tags?.length ?? 0) > 0);
  return !hasCover || !hasCoreMetadata;
}

export async function runBookEnrichmentBatch(input: RunBookEnrichmentBatchInput): Promise<BookEnrichmentBatchResult> {
  const books = input.books.filter(bookNeedsEnrichment);
  const total = books.length;
  const skipped = input.books.length - books.length;
  let completed = 0;
  let matched = 0;
  let applied = 0;
  let failed = 0;
  const errors: { bookId: string; title: string; message: string }[] = [];

  const publish = (state: BookEnrichmentBatchProgress['state'], currentTitle?: string) => {
    const progress: BookEnrichmentBatchProgress = {
      state,
      total,
      completed,
      matched,
      applied,
      failed,
      skipped,
      currentTitle,
    };
    input.onProgress?.(progress);
    return progress;
  };

  publish('running');
  for (const book of books) {
    if (aborted(input.signal)) break;
    publish('running', book.title);
    try {
      const candidates = await input.runner.propose(book.id, input.providerId, input.signal);
      if (aborted(input.signal)) break;
      if (candidates.length > 0) matched += 1;
      if (input.automaticApply === 'missing_fields') {
        const outcome = await applyEligibleMissingEnrichment(input.runner, book, candidates, input.signal);
        if (outcome.appliedCount > 0) applied += 1;
        if (outcome.errors.length > 0) {
          failed += 1;
          errors.push({ bookId: book.id, title: book.title, message: outcome.errors[0]! });
        }
      }
    } catch (error) {
      if (aborted(input.signal)) break;
      failed += 1;
      errors.push({
        bookId: book.id,
        title: book.title,
        message: error instanceof Error ? error.message : '작품 정보를 찾지 못했습니다.',
      });
    } finally {
      if (!aborted(input.signal)) completed += 1;
    }
    publish('running');
  }

  const state = aborted(input.signal) ? 'cancelled' : 'completed';
  return { ...publish(state), errors };
}
