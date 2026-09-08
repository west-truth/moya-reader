import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import type {
  DownloadedExternalSource,
  ExternalItemSummary,
  ExternalSourceDownloadRef,
  TrustedExternalSourceHostContext,
} from '../contracts';
import { OrderedDownloadQueue } from './ordered-download-queue';

type SeriesItem = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;

export function seriesDownloadRef(item: SeriesItem, connectionGeneration?: string): ExternalSourceDownloadRef {
  const document = item.collection.seriesProfile?.kind === 'document_series';
  return {
    key: item.key,
    fileName:
      item.importFileName ??
      (document ? `${item.release.title}.txt` : `${item.collection.title} - ${item.release.title}.cbz`),
    mimeType: item.mimeType,
    byteLength: item.byteLength,
    remoteRevision: item.remoteRevision,
    ...(document
      ? { context: { expectedProfile: item.collection.seriesProfile, connectionGeneration, maxBytes: 2 * 1024 * 1024 } }
      : {}),
  };
}

export function createSeriesDownloadQueue(options: {
  sourceId: ExtensionContributionId;
  registry: ExternalSourceRegistryPort;
  hostContext: TrustedExternalSourceHostContext;
  items: readonly SeriesItem[];
  signal: AbortSignal;
  onStage(item: SeriesItem, stage: 'downloading' | 'downloaded'): void;
}) {
  const initial = options.registry.getExternalSourceStatus(options.sourceId, options.hostContext);
  const assertConnection = () => {
    const current = options.registry.getExternalSourceStatus(options.sourceId, options.hostContext);
    if (
      current.state !== 'connected' ||
      current.connectionGeneration !== initial.connectionGeneration ||
      current.accountConnectionId !== initial.accountConnectionId
    )
      throw new Error('외부 소스 연결이 변경되었습니다. 목록을 다시 열어 주세요.');
  };
  const document = options.items[0]?.collection.seriesProfile?.kind === 'document_series';
  const estimate = document ? 2 * 1024 * 1024 : 32 * 1024 * 1024;
  const queue = new OrderedDownloadQueue<DownloadedExternalSource>({
    signal: options.signal,
    concurrency: options.items.some((item) => item.collection.maxConcurrentDownloads === 1) ? 1 : 2,
    maxBufferedBytes: estimate * 2,
    count: () => options.items.length,
    estimateBytes: (index) => {
      const value = options.items[index]?.byteLength;
      return value && Number.isFinite(value) && value > 0 ? value : estimate;
    },
    size: (value) => value.file.size,
    download: async (index, signal) => {
      assertConnection();
      const item = options.items[index]!;
      options.onStage(item, 'downloading');
      const result = await options.registry.downloadExternalSource(
        options.sourceId,
        options.hostContext,
        seriesDownloadRef(item, initial.connectionGeneration),
        signal,
      );
      signal.throwIfAborted();
      assertConnection();
      options.onStage(item, 'downloaded');
      return result;
    },
  });
  return {
    async take(index: number) {
      assertConnection();
      const result = await queue.take(index);
      assertConnection();
      return result;
    },
    close: () => queue.close(),
  };
}
