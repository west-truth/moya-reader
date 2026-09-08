import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import { createSeriesDownloadQueue } from './series-download-queue';

function fixture(limit?: 1 | 2) {
  const sourceId = 'fixture.text' as ExtensionContributionId;
  let generation = 'one';
  const file = new File(['Original\r\n  text'], '1.txt', { type: 'text/plain' });
  const download = vi.fn<ExternalSourceRegistryPort['downloadExternalSource']>(async () => ({
    file,
    content: { kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
  }));
  const registry = {
    getExternalSourceStatus: () => ({
      state: 'connected',
      accountConnectionId: 'account',
      connectionGeneration: generation,
    }),
    downloadExternalSource: download,
  } as unknown as ExternalSourceRegistryPort;
  const items = Array.from({ length: 3 }, (_, index) => ({
    key: { connectorId: sourceId, accountConnectionId: 'account', remoteId: `release-${index}` },
    kind: 'file' as const,
    title: `${index}`,
    importability: 'supported' as const,
    collection: {
      remoteId: 'work',
      title: 'Work',
      maxConcurrentDownloads: limit,
      seriesProfile: {
        kind: 'document_series' as const,
        format: 'txt' as const,
        encoding: 'utf-8' as const,
        chapterSplitMode: 'single' as const,
      },
    },
    release: { title: `${index}` },
  }));
  const stage = vi.fn();
  const abort = new AbortController();
  const queue = createSeriesDownloadQueue({
    sourceId,
    registry,
    items,
    signal: abort.signal,
    hostContext: { brokers: { get: () => undefined } },
    onStage: stage,
  });
  return {
    queue,
    download,
    file,
    items,
    stage,
    changeConnection: () => {
      generation = 'two';
    },
  };
}

describe('series download boundary', () => {
  it('prefetches with the TXT hard limit, immutable connection generation and unchanged file', async () => {
    const h = fixture();
    try {
      expect((await h.queue.take(0)).file).toBe(h.file);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(3));
      expect(h.download.mock.calls[0]?.[2].context).toEqual({
        expectedProfile: h.items[0]!.collection.seriesProfile,
        connectionGeneration: 'one',
        maxBytes: 2 * 1024 * 1024,
      });
      expect(h.stage).toHaveBeenCalledWith(h.items[1], 'downloaded');
      h.changeConnection();
      await expect(h.queue.take(1)).rejects.toThrow('연결이 변경');
    } finally {
      h.queue.close();
    }
  });

  it('honors the collection limit of one and aborts speculative requests on disposal', async () => {
    const h = fixture(1);
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const normal = h.download.getMockImplementation()!;
    h.download.mockImplementation(async (...args) => {
      await gate;
      return normal(...args);
    });
    try {
      const first = h.queue.take(0);
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
      resolve();
      await first;
      await vi.waitFor(() => expect(h.download).toHaveBeenCalledTimes(2));
      h.queue.close();
      expect(h.download.mock.calls.every((call) => call[3].aborted)).toBe(true);
      await expect(h.queue.take(1)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      resolve();
      h.queue.close();
    }
  });
});
