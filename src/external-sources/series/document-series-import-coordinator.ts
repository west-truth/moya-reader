import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { Novel } from '../../domain/types';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ImportExpectedBase, ImportProgress, ImportService } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import {
  externalItemKeyId,
  externalSourceLinkId,
  type ExternalItemSummary,
  type ExternalSourceLink,
  type TrustedExternalSourceHostContext,
} from '../contracts';
import type { ExternalSourceLocalState } from '../local-state';
import {
  acquireExternalSourcePendingLinks,
  finalizeExternalSourceLinks,
  restoreExternalSourceLinks,
} from '../link-import-reconciliation';
import { assembleDocumentSeries } from './document-series-assembler';
import { externalDocumentCollectionId } from './document-series-identity';

type DocumentItem = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;
const MAX_BATCH_RELEASES = 50;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export interface DocumentSeriesImportOptions {
  sourceId: ExtensionContributionId;
  items: readonly DocumentItem[];
  registry: ExternalSourceRegistryPort;
  hostContext: TrustedExternalSourceHostContext;
  state: ExternalSourceLocalState;
  assets?: BookAssetRepository;
  importService: ImportService;
  signal: AbortSignal;
  getNovel(id: string): Promise<Novel | undefined>;
  onProgress(value: {
    received: number;
    committed: number;
    total: number;
    title: string;
    detail?: ImportProgress;
    item?: DocumentItem;
    items?: readonly DocumentItem[];
    stage?: 'downloading' | 'verifying';
  }): void;
  onCommitted(novel: Novel, items: readonly DocumentItem[]): Promise<void>;
  /** A committed release replaced previously imported source bytes. */
  onReplacedRelease?(): void;
}

function sameHash(a: string | undefined, b: string | undefined) {
  return Boolean(a && b && a.replace(/^sha256:/u, '').toLowerCase() === b.replace(/^sha256:/u, '').toLowerCase());
}

function isBaseConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ContentRevisionConflictError' || error.message === 'import_expected_base_conflict')
  );
}

/** Export and its activation fence must describe the same immutable source. */
async function snapshot(options: DocumentSeriesImportOptions, bookId: string) {
  const before = await options.getNovel(bookId);
  if (!before) return { expectedBase: { kind: 'absent' } as ImportExpectedBase };
  if (before.deletedAt) throw new Error('휴지통의 작품을 복원한 뒤 다시 가져와 주세요.');
  if (before.format !== 'txt' || !before.activeContentRevisionId) {
    throw new Error('이 작품은 원격 TXT 연재로 갱신할 수 없습니다.');
  }
  const exported = await options.assets?.exportSource(bookId);
  options.signal.throwIfAborted();
  const sourceHash = exported
    ? await hashBlobInChunks(exported.blob, { shouldCancel: () => options.signal.aborted })
    : undefined;
  const after = await options.getNovel(bookId);
  if (
    !after ||
    after.deletedAt ||
    after.activeContentRevisionId !== before.activeContentRevisionId ||
    !exported ||
    !sameHash(exported.metadata.contentHash, before.sourceContentHash) ||
    !sameHash(sourceHash, before.sourceContentHash) ||
    !sameHash(after.sourceContentHash, before.sourceContentHash)
  ) {
    throw new Error('원본을 읽는 중 작품이 변경되었거나 원본이 없습니다. 다시 시도해 주세요.');
  }
  return {
    novel: before,
    expectedBase: { kind: 'revision', contentRevisionId: before.activeContentRevisionId } as ImportExpectedBase,
    existingSource: { blob: exported.blob, contentType: exported.metadata.contentType },
  };
}

/** Bounded TXT batches share the existing activation/link recovery boundaries. */
export async function importDocumentSeries(options: DocumentSeriesImportOptions): Promise<void> {
  if (!options.importService.supportsExpectedBase)
    throw new Error('이 환경은 안전한 텍스트 연재 갱신을 지원하지 않습니다.');
  if (!options.state.acquirePendingLinks || !options.state.compareAndSwapPendingLinks)
    throw new Error('이 환경은 안전한 소스 연결 저장을 지원하지 않습니다.');
  const first = options.items[0];
  if (!first) return;
  const profile = first.collection.seriesProfile;
  if (profile?.kind !== 'document_series') throw new Error('텍스트 연재 형식을 확인하지 못했습니다.');
  const collectionKey = JSON.stringify([
    first.key.connectorId,
    first.key.accountConnectionId ?? '',
    first.collection.remoteId,
  ]);
  const unique = new Map(options.items.map((item) => [externalItemKeyId(item.key), item]));
  const items = [...unique.values()];
  if (
    items.some(
      (item) =>
        JSON.stringify([item.key.connectorId, item.key.accountConnectionId ?? '', item.collection.remoteId]) !==
          collectionKey || JSON.stringify(item.collection.seriesProfile) !== JSON.stringify(profile),
    )
  )
    throw new Error('같은 텍스트 작품의 회차를 선택해 주세요.');
  const links = await options.state.listLinks(options.sourceId);
  const related = (link: ExternalSourceLink) =>
    link.source.connectorId === first.key.connectorId &&
    (link.source.accountConnectionId ?? '') === (first.key.accountConnectionId ?? '') &&
    link.collectionRemoteId === first.collection.remoteId;
  const targetIds = [...new Set(links.filter(related).map((link) => link.localBookId))];
  if (targetIds.length > 1) throw new Error('회차가 여러 작품에 연결되어 있어 자동 병합할 수 없습니다.');
  const bookId = targetIds[0] ?? externalDocumentCollectionId(first.key, first.collection.remoteId);
  const generation = options.registry.getExternalSourceStatus(
    options.sourceId,
    options.hostContext,
  ).connectionGeneration;
  let received = 0;
  let committed = 0;
  let carried: Parameters<typeof assembleDocumentSeries>[0]['releases'][number] | undefined;
  for (let index = 0; index < items.length || carried;) {
    options.signal.throwIfAborted();
    let base = await snapshot(options, bookId);
    let releases: Parameters<typeof assembleDocumentSeries>[0]['releases'][number][] = [];
    const batch: DocumentItem[] = [];
    let bytes = 0;
    while ((index < items.length || carried) && batch.length < MAX_BATCH_RELEASES && bytes < MAX_BATCH_BYTES) {
      const item = (carried?.item as DocumentItem | undefined) ?? items[index++]!;
      options.signal.throwIfAborted();
      options.onProgress({
        received,
        committed,
        total: items.length,
        title: item.release.title,
        item,
        stage: carried ? 'verifying' : 'downloading',
      });
      let release = carried;
      carried = undefined;
      if (!release) {
        const downloaded = await options.registry.downloadExternalSource(
          options.sourceId,
          options.hostContext,
          {
            key: item.key,
            fileName: item.importFileName ?? `${item.release.title}.txt`,
            mimeType: item.mimeType,
            remoteRevision: item.remoteRevision,
            byteLength: item.byteLength,
            context: { expectedProfile: profile, connectionGeneration: generation, maxBytes: 2 * 1024 * 1024 },
          },
          options.signal,
        );
        const content = downloaded.content;
        if (content?.kind !== 'document') throw new Error('텍스트 소스가 올바른 TXT 본문을 반환하지 않았습니다.');
        options.signal.throwIfAborted();
        const sourceContentHash = await hashBlobInChunks(content.file, { shouldCancel: () => options.signal.aborted });
        release = {
          item,
          content,
          sourceContentHash,
          remoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
        };
        received += 1;
        options.onProgress({
          received,
          committed,
          total: items.length,
          title: item.release.title,
          item,
          stage: 'verifying',
        });
      }
      if (batch.length && bytes + release.content.file.size > MAX_BATCH_BYTES) {
        carried = release;
        break;
      }
      releases.push(release);
      batch.push(item);
      bytes += release.content.file.size;
    }
    let retryFences: Map<string, string | null> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const assembled = await assembleDocumentSeries({
        collection: { ...first.collection, seriesProfile: profile },
        releases,
        targetBookId: bookId,
        existingSource: base.existingSource,
        expectedBase: base.expectedBase,
        signal: options.signal,
      });
      retryFences ??= new Map(
        assembled.releaseProjections.map((release) => [release.remoteId, release.previousSourceContentHash]),
      );
      const replacedRelease = assembled.releaseProjections.some(
        (release) =>
          release.previousSourceContentHash !== null &&
          !sameHash(release.previousSourceContentHash, release.sourceContentHash),
      );
      options.signal.throwIfAborted();
      let novel = base.novel;
      const previous = (await options.state.listLinks(options.sourceId)).filter(related);
      if (previous.some((link) => link.localBookId !== bookId))
        throw new Error('작품의 소스 연결이 변경되었습니다. 다시 시도해 주세요.');
      const checked = new Map(releases.map((release) => [externalItemKeyId(release.item.key), release]));
      const now = new Date().toISOString();
      const sourceHash = assembled.file
        ? await hashBlobInChunks(assembled.file, { shouldCancel: () => options.signal.aborted })
        : base.novel?.sourceContentHash;
      if (!sourceHash) throw new Error('저장된 원본을 확인하지 못했습니다.');
      const operationId = crypto.randomUUID();
      const candidates = new Map(previous.map((link) => [externalItemKeyId(link.source), link]));
      for (const item of batch) {
        const key = externalItemKeyId(item.key);
        if (!candidates.has(key))
          candidates.set(key, {
            id: externalSourceLinkId(item.key),
            source: item.key,
            localBookId: bookId,
            collectionRemoteId: first.collection.remoteId,
            linkedAt: now,
          });
      }
      const staged = [...candidates.values()].map((link) => {
        const release = checked.get(externalItemKeyId(link.source));
        return {
          ...link,
          pendingImport: {
            operationId,
            stagedAt: now,
            hadExistingLink: previous.some((old) => old.id === link.id),
            previousActiveContentRevisionId: base.novel?.activeContentRevisionId,
            expectedActiveSourceContentHash: sourceHash,
            collectionRemoteId: first.collection.remoteId,
            importedRemoteRevision: release?.remoteRevision ?? link.importedRemoteRevision,
            importedSourceContentHash: release?.sourceContentHash ?? link.importedSourceContentHash,
          },
        } satisfies ExternalSourceLink;
      });
      await acquireExternalSourcePendingLinks(options.state, staged);
      let activated = false;
      let importStarted = false;
      let finalizationAttempted = false;
      try {
        options.signal.throwIfAborted();
        const currentConnection = options.registry.getExternalSourceStatus(options.sourceId, options.hostContext);
        if (
          currentConnection.state !== 'connected' ||
          currentConnection.connectionGeneration !== generation ||
          (currentConnection.accountConnectionId ?? '') !== (first.key.accountConnectionId ?? '')
        ) {
          throw new Error('외부 소스 연결이 변경되었습니다. 목록을 다시 열어 주세요.');
        }
        if (assembled.file) {
          importStarted = true;
          const task = options.importService.importFile(
            {
              file: assembled.file,
              encoding: 'utf-8',
              chapterSplitMode: 'single',
              clientBookId: bookId,
              expectedBase: base.expectedBase,
              ...(options.importService.supportsExpectedSourceContentHash
                ? { expectedSourceContentHash: sourceHash }
                : {}),
            },
            (detail) =>
              options.onProgress({
                received,
                committed,
                total: items.length,
                title: first.collection.title,
                detail,
                items: batch,
              }),
          );
          const cancel = () => task.cancel();
          options.signal.addEventListener('abort', cancel, { once: true });
          if (options.signal.aborted) cancel();
          try {
            novel = (await task.promise).novel;
            activated = true;
          } finally {
            options.signal.removeEventListener('abort', cancel);
          }
        } else {
          novel = await options.getNovel(bookId);
          if (!novel || novel.activeContentRevisionId !== base.novel?.activeContentRevisionId)
            throw new Error('import_expected_base_conflict');
        }
        // A late cancellation must still finish reconciliation of committed content.
        novel = (await options.getNovel(bookId)) ?? novel;
        finalizationAttempted = true;
        await finalizeExternalSourceLinks(options.state, staged, novel);
      } catch (error) {
        let current: Novel | undefined;
        let inspected = !importStarted && !finalizationAttempted;
        if (importStarted || finalizationAttempted) {
          try {
            current = await options.getNovel(bookId);
            inspected = true;
          } catch {
            /* Keep the intent when commit outcome cannot be read. */
          }
        }
        if (current && sameHash(current.sourceContentHash, sourceHash)) {
          novel = current;
          try {
            await finalizeExternalSourceLinks(options.state, staged, current);
          } catch {
            committed += batch.length;
            options.onProgress({
              received,
              committed,
              total: items.length,
              title: first.collection.title,
              items: batch,
            });
            if (replacedRelease) options.onReplacedRelease?.();
            await options.onCommitted(current, batch).catch(() => undefined);
            throw Object.assign(new Error('본문은 저장되었습니다. 소스 연결은 새로고침할 때 복구합니다.'), {
              cause: error,
            });
          }
        } else {
          if (!activated && inspected)
            await restoreExternalSourceLinks(options.state, staged, previous).catch(() => undefined);
          if (activated && novel) {
            committed += batch.length;
            options.onProgress({
              received,
              committed,
              total: items.length,
              title: first.collection.title,
              items: batch,
            });
            if (replacedRelease) options.onReplacedRelease?.();
            await options.onCommitted(novel, batch).catch(() => undefined);
            throw Object.assign(new Error('본문은 저장되었습니다. 소스 연결은 새로고침할 때 복구합니다.'), {
              cause: error,
            });
          }
          if (inspected && attempt === 0 && isBaseConflict(error) && !options.signal.aborted) {
            base = await snapshot(options, bookId);
            releases = releases.map((release) => ({
              ...release,
              expectedPreviousSourceContentHash: retryFences!.get(release.item.key.remoteId),
            }));
            continue;
          }
          throw error;
        }
      }
      if (!novel) throw new Error('저장된 작품을 확인하지 못했습니다.');
      committed += batch.length;
      options.onProgress({ received, committed, total: items.length, title: first.collection.title, items: batch });
      if (replacedRelease) options.onReplacedRelease?.();
      await options.onCommitted(novel, batch);
      break;
    }
  }
}
