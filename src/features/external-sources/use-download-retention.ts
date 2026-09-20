import { useEffect, useRef, useState } from 'react';
import { retentionCandidates, type RetainedReadCount } from '../../external-sources/series/download-retention';
import { externalDocumentReleaseSourceId } from '../../external-sources/series/document-series-identity';
import { removeDownloadedReleases } from '../../external-sources/series/remove-downloaded-releases';
import type { UseExternalSourceControllerOptions } from './useExternalSourceController';

interface Candidate {
  scope: string;
  bookId: string;
  title: string;
  revision: string;
  sections: string[];
}
export interface DownloadRetention {
  enabled: boolean;
  keep: RetainedReadCount;
  busy: boolean;
  readerActive: boolean;
  error: string;
  preview?: readonly Candidate[];
  setEnabled(value: boolean): void;
  setKeep(value: RetainedReadCount): void;
  inspect(): Promise<void>;
  clean(): Promise<void>;
}

export function useDownloadRetention(input: {
  options: UseExternalSourceControllerOptions;
  busy: boolean;
  setBusy(value: boolean): void;
}): DownloadRetention {
  const latest = useRef(input);
  latest.current = input;
  const key = `moya.download-retention.v1:${input.options.settingsScope ?? 'local'}`;
  const [policy, setPolicy] = useState<{ key: string; enabled: boolean; keep: RetainedReadCount }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      return { key, enabled: saved.enabled === true, keep: [5, 10, 20].includes(saved.keep) ? saved.keep : 5 };
    } catch {
      return { key, enabled: false, keep: 5 };
    }
  });
  // A different account/server never inherits automatic deletion from this mount.
  const enabled = policy.key === key && policy.enabled;
  const keep = policy.key === key ? policy.keep : 5;
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Candidate[]>();
  const save = (next: { enabled: boolean; keep: RetainedReadCount }) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setPolicy({ key, ...next });
      setPreview(undefined);
      setError('');
    } catch {
      setError('설정을 저장하지 못했습니다. 자동 정리는 켜지지 않았습니다.');
    }
  };
  const candidates = async (bookId?: string): Promise<Candidate[]> => {
    const { options } = latest.current;
    const links = await options.state.listLinks();
    const books = bookId ? [await options.getNovel(bookId)] : await options.listNovels();
    const found: Candidate[] = [];
    for (const novel of books) {
      if (!novel || novel.deletedAt || novel.favorite || novel.id === options.readingTarget?.novelId) continue;
      if (
        !options.assets ||
        (novel.format === 'txt'
          ? !options.importService.supportsExpectedBase
          : novel.format !== 'image_archive' || !options.importService.supportsIncrementalImageSeriesAppend)
      )
        continue;
      const related = links.filter(
        (link) => link.localBookId === novel.id && link.collectionRemoteId && !link.pendingImport,
      );
      if (!related.length) continue;
      const ids = new Set(
        related.flatMap((link) => [
          link.source.remoteId,
          externalDocumentReleaseSourceId(link.source, link.collectionRemoteId!),
        ]),
      );
      const sections = retentionCandidates(novel, await options.listChapters(novel.id), keep).filter((id) =>
        ids.has(id),
      );
      if (sections.length)
        found.push({
          scope: options.settingsScope ?? 'local',
          bookId: novel.id,
          title: novel.title,
          revision: novel.activeContentRevisionId!,
          sections,
        });
    }
    return found;
  };
  const run = async (task: () => Promise<void>) => {
    if (running.current || latest.current.busy) return;
    running.current = true;
    setBusy(true);
    setError('');
    latest.current.setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : '읽은 회차를 정리하지 못했습니다.');
    } finally {
      running.current = false;
      setBusy(false);
      latest.current.setBusy(false);
    }
  };
  const remove = async (plans: readonly Candidate[]) => {
    let removed = 0;
    try {
      for (const plan of plans) {
        // Re-check exact read markers and revision immediately before mutation.
        const fresh = (await candidates(plan.bookId))[0];
        if (!fresh || fresh.revision !== plan.revision || fresh.scope !== plan.scope) continue;
        const sections = fresh.sections.filter((id) => plan.sections.includes(id));
        const { options } = latest.current;
        if (
          !sections.length ||
          options.readingActive ||
          options.readingTarget ||
          !options.assets ||
          (options.settingsScope ?? 'local') !== plan.scope
        )
          continue;
        await removeDownloadedReleases({
          bookId: plan.bookId,
          sectionIds: sections,
          expectedContentRevisionId: fresh.revision,
          assets: options.assets,
          importService: options.importService,
          getNovel: options.getNovel,
        });
        removed += sections.length;
      }
    } finally {
      setPreview(undefined);
      if (removed) {
        await latest.current.options.onLibraryChanged();
        latest.current.options.notify(`읽은 회차 ${removed}개의 다운로드를 정리했습니다.`, 'success');
      }
    }
  };
  const previousBook = useRef<string>();
  const pending = useRef<string>();
  const readingBook = input.options.readingTarget?.novelId;
  const readingActive = input.options.readingActive ?? Boolean(readingBook);
  useEffect(() => {
    if (previousBook.current && previousBook.current !== readingBook) pending.current = previousBook.current;
    previousBook.current = readingBook;
  }, [readingBook]);
  const auto = useRef({ candidates, remove, run });
  auto.current = { candidates, remove, run };
  useEffect(() => {
    if (!enabled) {
      pending.current = undefined;
      return;
    }
    if (readingActive || readingBook || input.busy || running.current || !pending.current) return;
    const bookId = pending.current;
    pending.current = undefined;
    void auto.current.run(async () => auto.current.remove(await auto.current.candidates(bookId)));
  }, [enabled, readingActive, readingBook, input.busy]);
  return {
    enabled,
    keep,
    busy,
    readerActive: readingActive,
    error,
    preview,
    setEnabled: (value) => save({ enabled: value, keep }),
    setKeep: (value) => {
      if ([5, 10, 20].includes(value)) save({ enabled, keep: value });
    },
    inspect: () => run(async () => setPreview(await candidates())),
    clean: async () => {
      if (latest.current.options.readingActive || latest.current.options.readingTarget) {
        setError('정리하려면 먼저 리더를 닫아 주세요.');
        return;
      }
      if (!preview?.length) return;
      const count = preview.reduce((sum, entry) => sum + entry.sections.length, 0);
      if (
        !latest.current.options.confirm(
          `${preview.length}개 작품의 읽은 회차 ${count}개 다운로드를 삭제할까요? 다시 보려면 재다운로드가 필요합니다.`,
        )
      )
        return;
      await run(() => remove(preview));
    },
  };
}
