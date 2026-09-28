import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { useSessionExtensionUpdates } from './use-session-extension-updates';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function harness({ update = true, failed = false } = {}) {
  const inventory = {
    packages: [{ pkg: 'sample', code: 1, version: '1' }],
    repositories: ['one', 'two'].map((host) => ({
      url: `https://${host}.test/index.json`,
      entries: [{ pkg: 'sample', code: update ? 2 : 1, version: update ? '2' : '1', name: 'Sample' }],
    })),
  };
  const apk = {
    list: vi.fn(async () => inventory),
    refreshRepository: vi.fn(async () => {
      if (failed) throw Error('offline');
    }),
    inspectRepository: vi.fn(),
    install: vi.fn(),
  };
  const manager = {
    refresh: vi.fn(async () => {
      if (failed) throw Error('offline');
    }),
    getSnapshot: () => ({ available: true, packages: [] }),
    apk,
  } as unknown as InstalledExtensionManager;
  const notify = vi.fn();
  const openUpdates = vi.fn();
  let ready = false;
  function Harness() {
    useSessionExtensionUpdates({ ready, manager, notify, openUpdates });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  return {
    manager,
    apk,
    notify,
    openUpdates,
    start() {
      ready = true;
      act(() => renderer.update(<Harness />));
    },
    rerender() {
      act(() => renderer.update(<Harness />));
    },
    unmount() {
      act(() => renderer.unmount());
    },
  };
}
it('checks after bootstrap, deduplicates repositories, notifies once, and only opens reviews on request', async () => {
  const test = harness();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(test.manager.refresh).not.toHaveBeenCalled();
  test.start();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(test.notify).toHaveBeenCalledExactlyOnceWith(
    '확장 소스 업데이트 1개가 있습니다.',
    'info',
    expect.objectContaining({ label: '확인' }),
  );
  expect(test.apk.install).not.toHaveBeenCalled();
  expect(test.apk.inspectRepository).not.toHaveBeenCalled();
  test.notify.mock.calls[0][2].onSelect();
  expect(test.openUpdates).toHaveBeenCalledOnce();
  test.rerender();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200000);
  });
  expect(test.manager.refresh).toHaveBeenCalledOnce();
  expect(test.notify).toHaveBeenCalledOnce();
  test.unmount();
});
it.each([{ update: false }, { failed: true }])('keeps routine results and failures silent: %j', async (options) => {
  const test = harness(options);
  test.start();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(test.notify).not.toHaveBeenCalled();
  test.unmount();
});
it('cancels deferred checks on unmount and checks again in a fresh app session', async () => {
  const first = harness();
  first.start();
  first.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(first.manager.refresh).not.toHaveBeenCalled();
  const second = harness();
  second.start();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(second.notify).toHaveBeenCalledOnce();
  second.unmount();
});

it('does not notify when an in-flight check completes after unmount', async () => {
  const test = harness();
  let finish!: () => void;
  vi.mocked(test.manager.refresh).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  test.start();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  test.unmount();
  await act(async () => {
    finish();
  });
  expect(test.apk.list).not.toHaveBeenCalled();
  expect(test.notify).not.toHaveBeenCalled();
});
