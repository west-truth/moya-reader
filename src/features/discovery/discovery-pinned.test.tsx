import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';
import type {
  ExternalItemPage,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import { newTab, pinnedSource, togglePinnedSource, type DiscoveryConfig } from './discovery-config';
import { DiscoverySession } from './discovery-session';
import { useDiscoveryPages } from './useDiscoveryPages';

describe('source pinning', () => {
  it('preserves a user tab with two lists of the same source and toggles only the dedicated pin', () => {
    const tab = {
      ...newTab('내 목록'),
      sections: [
        { id: 'popular', sourceId: 'one', title: '', mode: 'popular' as const },
        { id: 'latest', sourceId: 'one', title: '', mode: 'latest' as const },
      ],
    };
    const config: DiscoveryConfig = { version: 1, tabs: [tab] };
    const pinned = togglePinnedSource(config, 'one', '소스');
    expect(pinned.tabs).toHaveLength(2);
    expect(pinned.tabs[0]).toEqual(tab);
    expect(pinnedSource(pinned.tabs[1]!)).toBe('one');
    expect(togglePinnedSource(pinned, 'one', '소스')).toEqual(config);
  });
  it('treats a pin edited into multiple lists as a regular user tab', () => {
    const config = togglePinnedSource({ version: 1, tabs: [] }, 'one', '소스');
    const tab = config.tabs[0]!;
    tab.sections.push({ ...tab.sections[0]!, id: 'second', mode: 'latest' });
    expect(pinnedSource(tab)).toBeUndefined();
    expect(togglePinnedSource(config, 'one', '소스').tabs[0]).toEqual(tab);
  });
});

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it('appends unique works, retains results on next-page failure, and restores depth without refetching', async () => {
  vi.stubGlobal('window', {});
  const item = (id: string) => ({ key: { connectorId: 'one', remoteId: id }, kind: 'work' as const, title: id });
  let fail = true;
  const list = vi.fn(
    async (_source: unknown, _context: unknown, input: ExternalSourceListInput): Promise<ExternalItemPage> => {
      if (input.cursor === 'next') {
        if (fail) throw new Error('temporary failure');
        return { items: [item('a'), item('b')] };
      }
      return { items: [item('a')], nextCursor: 'next' };
    },
  );
  const registry = {
    getExternalSourceStatus: () => ({ state: 'connected' }),
    listExternalSource: list,
  } as unknown as ExternalSourceRegistryPort;
  const session = new DiscoverySession(registry, {} as TrustedExternalSourceHostContext, crypto.randomUUID());
  let latest!: ReturnType<typeof useDiscoveryPages>;
  function Harness() {
    latest = useDiscoveryPages(session, 'one', { browseMode: 'popular' }, 0, true);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(latest.items.map((item) => item.title)).toEqual(['a']);
  await act(async () => latest.loadMore());
  expect(latest.error).toBe('temporary failure');
  expect(latest.items.map((item) => item.title)).toEqual(['a']);
  fail = false;
  await act(async () => latest.retry());
  expect(latest.items.map((item) => item.title)).toEqual(['a', 'b']);
  const calls = list.mock.calls.length;
  act(() => renderer!.unmount());
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(latest.items.map((item) => item.title)).toEqual(['a', 'b']);
  expect(list).toHaveBeenCalledTimes(calls);
  session.dispose();
});
