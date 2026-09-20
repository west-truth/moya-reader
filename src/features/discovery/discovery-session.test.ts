import 'fake-indexeddb/auto';
import {
  ExternalSourceLocalStateStore,
  resetExternalSourceLocalStateForTests,
} from '../../external-sources/local-state';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import { DiscoverySession } from './discovery-session';
const context = {} as TrustedExternalSourceHostContext;
function fixture() {
  let generation = 'one';
  const list = vi.fn(async (..._args: unknown[]) => ({ items: [] }));
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: generation }),
    listExternalSource: list,
  } as unknown as ExternalSourceRegistryPort;
  return {
    registry,
    session: new DiscoverySession(registry, context),
    list,
    change: () => {
      generation = 'two';
    },
  };
}
describe('DiscoverySession', () => {
  beforeEach(async () => resetExternalSourceLocalStateForTests());
  it('shares concurrent requests and reuses the page across tabs', async () => {
    const { session, list } = fixture();
    await Promise.all([session.list('a', { browseMode: 'popular' }), session.list('a', { browseMode: 'popular' })]);
    await session.list('a', { browseMode: 'popular' });
    expect(list).toHaveBeenCalledTimes(1);
    await session.list('a', { browseMode: 'latest' });
    expect(list).toHaveBeenCalledTimes(2);
    session.dispose();
  });
  it('does not publish responses from a disconnected generation', async () => {
    const { session, list, change } = fixture();
    let finish!: (value: { items: [] }) => void;
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.list('a', {});
    change();
    finish({ items: [] });
    await expect(pending).rejects.toThrow('변경');
    expect(session.peek('a', {})).toBeUndefined();
    session.dispose();
  });
  it('bounds parallel lists and releases the queue when a source fails', async () => {
    const { session, list } = fixture();
    const finish: Array<() => void> = [];
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish.push(() => resolve({ items: [] }));
        }),
    );
    const requests = ['a', 'b', 'c', 'd'].map((id) => session.list(id, {}));
    expect(list).toHaveBeenCalledTimes(2);
    finish.shift()!();
    await requests[0];
    expect(list).toHaveBeenCalledTimes(3);
    finish.shift()!();
    await requests[1];
    expect(list).toHaveBeenCalledTimes(4);
    finish.forEach((f) => f());
    await Promise.all(requests);
    list.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(session.list('e', {})).rejects.toThrow('unavailable');
    expect(session.peek('a', {})).toBeDefined();
    session.dispose();
  });
  it('restores persisted results after reopening without extending their age or crossing account scopes', async () => {
    const { session, registry, list } = fixture();
    const store = new ExternalSourceLocalStateStore();
    const input = { browseMode: 'popular' as const };
    await session.list('a', input);
    await vi.waitFor(async () => expect(await store.getCachePage(session.key('a', input))).toBeDefined());
    const time = session.peek('a', input)!.time;
    session.dispose();
    const reopened = new DiscoverySession(registry, context);
    await reopened.restore('a', input);
    expect(reopened.peek('a', input)?.time).toBe(time);
    await reopened.list('a', input);
    expect(list).toHaveBeenCalledTimes(1);
    const other = new DiscoverySession(registry, context, 'other-account');
    expect(await other.restore('a', input)).toBeUndefined();
    await reopened.list('a', input, true);
    expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ cacheMode: 'reload' });
    reopened.dispose();
    other.dispose();
  });
});
