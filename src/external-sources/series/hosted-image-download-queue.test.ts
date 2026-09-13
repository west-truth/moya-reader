import { expect, it, vi } from 'vitest';
import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import type { ExternalSourceRegistryPort } from '../app-external-source-registry';
import type { HostedImageDownload } from '../../services/import/hosted-image-import';
import { createHostedImageDownloadQueue } from './hosted-image-download-queue';

it('prefetches in order and discards receipts that arrive after disposal', async () => {
  const sourceId = 'fixture.images' as ExtensionContributionId;
  const resolvers: ((value: HostedImageDownload) => void)[] = [];
  const discard = vi.fn(async () => undefined);
  const queue = createHostedImageDownloadQueue({
    sourceId,
    registry: {
      getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: 'one' }),
    } as unknown as ExternalSourceRegistryPort,
    hostContext: { brokers: { get: () => undefined } },
    signal: new AbortController().signal,
    items: [0, 1, 2].map((i) => ({
      key: { connectorId: sourceId, remoteId: `${i}` },
      title: `${i}`,
      kind: 'file',
      importability: 'supported',
      collection: { remoteId: 'work', title: 'Work' },
      release: { title: `${i}` },
    })),
    onStage: vi.fn(),
    port: { download: () => new Promise((resolve) => resolvers.push(resolve)), discard },
  });
  const receipt = (id: string) => ({ artifactId: id, sourceContentHash: `sha256:${'a'.repeat(64)}`, byteLength: 100 });
  try {
    const first = queue.take(0);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1](receipt('second'));
    resolvers[0](receipt('first'));
    expect((await first).artifactId).toBe('first');
    queue.release('first');
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    queue.close();
    resolvers[2](receipt('late'));
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('late'));
    expect(discard).toHaveBeenCalledWith('second');
  } finally {
    queue.close();
  }
});
