import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BookEnrichmentApprovalReceipt,
  BookEnrichmentCandidate,
  BookEnrichmentMetadataField,
  BookEnrichmentProviderSummary,
} from './book-enrichment-contract';
import { BookEnrichmentService } from './book-enrichment-service';

export interface BookEnrichmentController {
  readonly available: boolean;
  readonly providers: readonly BookEnrichmentProviderSummary[];
  readonly candidates: readonly BookEnrichmentCandidate[];
  readonly receipts: readonly BookEnrichmentApprovalReceipt[];
  readonly busy: boolean;
  readonly error?: string;
  load(bookId: string): Promise<void>;
  propose(bookId: string, providerId: ExtensionContributionId): Promise<void>;
  applyMetadata(candidateId: string, selectedFields: readonly BookEnrichmentMetadataField[]): Promise<boolean>;
  applyCover(
    candidateId: string,
    layout: { fit: 'crop' | 'contain'; positionX: number; positionY: number },
  ): Promise<boolean>;
  reject(candidateId: string): Promise<void>;
  undo(receiptId: string): Promise<boolean>;
}

export interface UseBookEnrichmentControllerInput {
  readonly service?: BookEnrichmentService;
  refreshNovels(): Promise<unknown>;
  refreshAfterMutation(): Promise<unknown>;
  notify(message: string, tone?: 'info' | 'success' | 'warning' | 'danger'): void;
}

export function useBookEnrichmentController(input: UseBookEnrichmentControllerInput): BookEnrichmentController {
  const [candidates, setCandidates] = useState<BookEnrichmentCandidate[]>([]);
  const [receipts, setReceipts] = useState<BookEnrichmentApprovalReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeBookId = useRef<string>();
  const proposalAbort = useRef<AbortController>();

  useEffect(() => () => proposalAbort.current?.abort(), []);

  const load = useCallback(
    async (bookId: string) => {
      activeBookId.current = bookId;
      if (!input.service) {
        setCandidates([]);
        setReceipts([]);
        return;
      }
      try {
        const [loadedCandidates, loadedReceipts] = await Promise.all([
          input.service.listCandidates(bookId),
          input.service.listReceipts(bookId),
        ]);
        if (activeBookId.current === bookId) {
          setCandidates(loadedCandidates);
          setReceipts(loadedReceipts);
          setError(undefined);
        }
      } catch (cause) {
        if (activeBookId.current === bookId) {
          setError(cause instanceof Error ? cause.message : '추천 정보를 불러오지 못했습니다.');
        }
      }
    },
    [input.service],
  );

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(undefined);
      try {
        await operation();
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '작품 정보 추천 작업을 완료하지 못했습니다.';
        setError(message);
        input.notify(message, 'danger');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, input],
  );

  return useMemo<BookEnrichmentController>(
    () => ({
      available: Boolean(input.service),
      providers: input.service?.listProviders() ?? [],
      candidates,
      receipts,
      busy,
      error,
      load,
      propose: async (bookId, providerId) => {
        if (!input.service) return;
        proposalAbort.current?.abort();
        const controller = new AbortController();
        proposalAbort.current = controller;
        await run(async () => {
          const proposed = await input.service!.propose(bookId, providerId, controller.signal);
          await load(bookId);
          input.notify(
            proposed.length > 0 ? `${proposed.length}개의 추천 후보를 준비했습니다.` : '새로 제안할 정보가 없습니다.',
            proposed.length > 0 ? 'success' : 'info',
          );
        });
      },
      applyMetadata: async (candidateId, selectedFields) => {
        if (!input.service) return false;
        let applied = false;
        await run(async () => {
          const receipt = await input.service!.applyMetadata(candidateId, selectedFields);
          await Promise.all([input.refreshNovels(), input.refreshAfterMutation()]);
          await load(receipt.bookId);
          input.notify('선택한 추천 정보를 적용했습니다.', 'success');
          applied = true;
        });
        return applied;
      },
      applyCover: async (candidateId, layout) => {
        if (!input.service) return false;
        let applied = false;
        await run(async () => {
          const receipt = await input.service!.applyCover(candidateId, layout);
          await Promise.all([input.refreshNovels(), input.refreshAfterMutation()]);
          await load(receipt.bookId);
          input.notify('추천 표지를 적용했습니다.', 'success');
          applied = true;
        });
        return applied;
      },
      reject: async (candidateId) => {
        if (!input.service) return;
        await run(async () => {
          const candidate = await input.service!.reject(candidateId);
          if (candidate) await load(candidate.bookId);
        });
      },
      undo: async (receiptId) => {
        if (!input.service) return false;
        let undone = false;
        await run(async () => {
          const receipt = await input.service!.undo(receiptId);
          await Promise.all([input.refreshNovels(), input.refreshAfterMutation()]);
          await load(receipt.bookId);
          input.notify('승인한 변경을 되돌렸습니다.', 'success');
          undone = true;
        });
        return undone;
      },
    }),
    [busy, candidates, error, input, load, receipts, run],
  );
}
