import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceStorageEstimate } from './DeviceStorageEstimate';

describe('DeviceStorageEstimate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the browser estimate separately from server storage', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ usage: 5 * 1024 ** 2, quota: 100 * 1024 ** 2 })) },
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<DeviceStorageEstimate />);
    });
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('5.0 MiB / 100 MiB');
    expect(text).toContain('서버 책장 용량은 포함하지 않습니다');
    act(() => root.unmount());
  });
});
