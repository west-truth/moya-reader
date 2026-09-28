import 'fake-indexeddb/auto';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearSourceWorkReadingTime,
  sourceWorkReadingSeconds,
  sourceWorkSessionId,
  useSourceWorkReadingTime,
} from './source-work-reading-time';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('persists stream-only time after leaving, isolates accounts, and stops counting after exit', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', { setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const work = { connectorId: 'time.source', accountConnectionId: 'a', remoteId: 'work' };
  const id = sourceWorkSessionId('scope', work);
  await clearSourceWorkReadingTime(id);
  function Probe({ active }: { active: boolean }) {
    useSourceWorkReadingTime(id, active);
    return null;
  }
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Probe active />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12000);
    tree.update(<Probe active={false} />);
  });
  expect(await sourceWorkReadingSeconds(id)).toBe(12);
  expect(await sourceWorkReadingSeconds(sourceWorkSessionId('scope', { ...work, accountConnectionId: 'b' }))).toBe(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await sourceWorkReadingSeconds(id)).toBe(12);
  await clearSourceWorkReadingTime(id);
  expect(await sourceWorkReadingSeconds(id)).toBe(0);
  await act(async () => tree.unmount());
});
