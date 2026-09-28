import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceSubscriptionRecord } from '../../external-sources/local-state';
import { useLibraryWorkCovers } from './use-library-work-covers';

const work: ExternalSourceSubscriptionRecord = {
  id: 'work',
  connectorId: 'source',
  collectionRemoteId: 'series',
  navigationRef: 'series',
  title: '작품',
  knownReleaseIds: [],
  newReleaseIds: [],
  availableReleaseCount: 0,
  schemaVersion: 1,
  createdAt: '',
  updatedAt: '',
  lastCheckedAt: '',
};

describe('library artwork resolution', () => {
  it('caches device artwork across progress updates without writing subscriptions', async () => {
    const resolve = vi.fn(async () => 'blob:cover');
    let result: readonly ExternalSourceSubscriptionRecord[] = [];
    function Probe({ updatedAt }: { updatedAt: string }) {
      result = useLibraryWorkCovers([{ ...work, updatedAt }], 'account', resolve);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe updatedAt="1" />);
    });
    expect(result[0]?.thumbnailUrl).toBe('blob:cover');
    await act(async () => renderer.update(<Probe updatedAt="2" />));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(work.thumbnailUrl).toBeUndefined();
    await act(async () => renderer.unmount());
  });

  it('discards late artwork after an account switch and retries for the new connection', async () => {
    let finish!: (url: string) => void;
    const resolve = vi
      .fn<Parameters<typeof useLibraryWorkCovers>[2]>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      )
      .mockResolvedValueOnce('blob:new-account');
    let result: readonly ExternalSourceSubscriptionRecord[] = [];
    function Probe({ account }: { account: string }) {
      result = useLibraryWorkCovers([work], account, resolve);
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe account="old" />);
    });
    const signal = resolve.mock.calls[0]![1];
    await act(async () => renderer.update(<Probe account="new" />));
    expect(signal.aborted).toBe(true);
    await act(async () => finish('blob:old-account'));
    expect(result[0]?.thumbnailUrl).toBe('blob:new-account');
    await act(async () => renderer.unmount());
  });

  it('keeps the library usable on a cover failure and skips existing artwork', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('offline');
    });
    let result: readonly ExternalSourceSubscriptionRecord[] = [];
    function Probe() {
      result = useLibraryWorkCovers(
        [work, { ...work, id: 'existing', thumbnailUrl: 'data:image/png;base64,AQID' }],
        'account',
        resolve,
      );
      return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(result).toHaveLength(2);
    expect(result[1]?.thumbnailUrl).toBe('data:image/png;base64,AQID');
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
