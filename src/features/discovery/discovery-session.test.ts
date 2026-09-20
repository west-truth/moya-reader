import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type { TrustedExternalSourceHostContext } from '../../external-sources/contracts';
import { DiscoverySession } from './discovery-session';
const context = {} as TrustedExternalSourceHostContext;
function fixture() {
  let generation = 'one';
  const list = vi.fn(async () => ({ items: [] }));
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected', connectionGeneration: generation }),
    listExternalSource: list,
  } as unknown as ExternalSourceRegistryPort;
  return {
    session: new DiscoverySession(registry, context),
    list,
    change: () => {
      generation = 'two';
    },
  };
}
describe('DiscoverySession', () => {
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
});
