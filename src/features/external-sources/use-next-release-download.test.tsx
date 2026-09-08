import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useNextReleaseDownload } from './use-next-release-download';

describe('next release download scheduling', () => {
  it('defaults off, waits for a manual batch, and downloads once per read section without chaining', async () => {
    const run = vi.fn(async () => {});
    const reportError = vi.fn();
    let control!: ReturnType<typeof useNextReleaseDownload>;
    function Probe({ section, busy = false }: { section: string; busy?: boolean }) {
      control = useNextReleaseDownload({ readingKey: section, busy, run, reportError });
      return null;
    }
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<Probe section="book:1" busy />);
    });
    expect(control.enabled).toBe(false);
    await act(async () => control.setEnabled(true));
    expect(run).not.toHaveBeenCalled();
    await act(async () => {
      root.update(<Probe section="book:1" />);
    });
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.update(<Probe section="book:1" />);
    });
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      root.update(<Probe section="book:2" />);
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.update(<Probe section="book:2" />);
    });
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => control.setEnabled(false));
    await act(async () => {
      root.update(<Probe section="book:3" />);
    });
    expect(run).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });
});
