import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import type { ExternalItemSummary, TrustedExternalSourceHostContext } from '../contracts';
import type { HostedImageDownload, HostedImageImportPort } from '../../services/import/hosted-image-import';
import { OrderedDownloadQueue } from './ordered-download-queue';
import { seriesDownloadRef } from './series-download-queue';

type Item = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;
export function createHostedImageDownloadQueue(options: {
  sourceId: ExtensionContributionId;
  registry: ExternalSourceRegistryPort;
  hostContext: TrustedExternalSourceHostContext;
  port: Pick<HostedImageImportPort, 'download' | 'discard'>;
  document?: boolean;
  items: readonly Item[];
  signal: AbortSignal;
  onStage(item: Item, phase: 'downloading' | 'downloaded'): void;
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
  const receipts = new Set<string>();
  let closed = false;
  const discard = (id: string) => {
    receipts.delete(id);
    void options.port.discard(id).catch(() => undefined);
  };
  const queue = new OrderedDownloadQueue<HostedImageDownload>({
    signal: options.signal,
    concurrency: options.items.some((item) => item.collection.maxConcurrentDownloads === 1) ? 1 : 2,
    maxBufferedBytes: (options.document ? 4 : 64) * 1024 * 1024,
    count: () => options.items.length,
    estimateBytes: (i) => options.items[i]?.byteLength || (options.document ? 2 : 32) * 1024 * 1024,
    size: (value) => value.byteLength,
    download: async (i, signal) => {
      assertConnection();
      const item = options.items[i]!;
      options.onStage(item, 'downloading');
      const receipt = await options.port.download(seriesDownloadRef(item, initial.connectionGeneration), signal);
      receipts.add(receipt.artifactId);
      try {
        signal.throwIfAborted();
        assertConnection();
        if (closed) throw new DOMException('Cancelled', 'AbortError');
        options.onStage(item, 'downloaded');
        return receipt;
      } catch (error) {
        discard(receipt.artifactId);
        throw error;
      }
    },
  });
  return {
    async take(i: number) {
      assertConnection();
      const value = await queue.take(i);
      assertConnection();
      return value;
    },
    release(id: string) {
      discard(id);
    },
    /** Transfer cleanup ownership to the sequential importer. */
    forget(id: string) {
      receipts.delete(id);
    },
    close() {
      closed = true;
      queue.close();
      for (const id of receipts) discard(id);
    },
  };
}
