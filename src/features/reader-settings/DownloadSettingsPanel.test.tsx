import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';
import { DownloadSettingsPanel } from './DownloadSettingsPanel';

const controller = {
  autoDownloadNext: false,
  autoDownloadNextCount: 1,
  recoverableDownloads: [],
} as unknown as ExternalSourceController;

describe('DownloadSettingsPanel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the browser estimate separately from server storage', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ usage: 5 * 1024 ** 2, quota: 100 * 1024 ** 2 })) },
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(<DownloadSettingsPanel controller={controller} />);
    });
    const text = JSON.stringify(root.toJSON());
    expect(text).toContain('5.0 MB / 100 MB');
    expect(text).toContain('서버 책장 용량은 포함하지 않습니다');
    expect(text).toContain('다음 접속에서 복구 가능');
    act(() => root.unmount());
  });
});
