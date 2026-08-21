import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { ReaderChrome } from './ReaderChrome';
import {
  ReaderScreenHandle,
  type ReaderLocationSnapshot,
  type ReaderScreenActions,
  type ReaderScreenModel,
} from './reader-screen-contract';
import type { ReaderViewportApi } from './ReaderViewport';
import type { ReaderChromeController } from './use-reader-chrome';
import type { ReaderSearchController } from './use-reader-search';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ReaderChrome bookmark action', () => {
  it('uses the viewport location fallback and blocks duplicate taps while the mobile save is pending', async () => {
    const pending = deferred();
    const toggleBookmark = vi.fn(() => pending.promise);
    const notify = vi.fn();
    const screenHandle = new ReaderScreenHandle();
    screenHandle.setActions({ toggleBookmark, notify } as unknown as ReaderScreenActions);
    const fallbackLocation: ReaderLocationSnapshot = {
      progress: 0.37,
      scrollTop: 420,
      paragraphIndex: 12,
      ttsIndex: 12,
    };
    const viewport = { getLocation: () => fallbackLocation } as ReaderViewportApi;
    const model = {
      novel: { id: 'book_1', title: '모바일 책', totalChapters: 2, format: 'epub' },
      chapter: { id: 'chapter_1', novelId: 'book_1', index: 1, title: '첫 화', paragraphCount: 20 },
      chapters: [],
      settings: defaultSettings,
      bookmarks: [],
      highlights: [],
      addonOpen: false,
      addonTab: 'info',
      overlays: { settingsOpen: false, syncPanelOpen: false, importOpen: false },
      canRestoreSavedPosition: false,
      statsVisible: false,
      openRequestVersion: 0,
    } as unknown as ReaderScreenModel;
    const chrome = {
      visible: true,
      immersive: false,
      fullscreen: false,
      reveal: vi.fn(),
      hide: vi.fn(),
      enterImmersive: vi.fn(),
      exitImmersive: vi.fn(),
      toggleImmersive: vi.fn(),
      toggleFullscreen: vi.fn(async () => undefined),
    } as ReaderChromeController;
    const search = {
      query: '',
      desktopInputRef: { current: null },
      mobileInputRef: { current: null },
      setQuery: vi.fn(),
      handleInputKeyDown: vi.fn(),
    } as unknown as ReaderSearchController;

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ReaderChrome
          model={model}
          screenHandle={screenHandle}
          viewport={viewport}
          chrome={chrome}
          search={search}
          mode="read"
          readingFlow="scroll"
          mobileSearchOpen={false}
          overflowOpen={false}
          onSetMode={vi.fn()}
          onMobileSearchOpenChanged={vi.fn()}
          onOverflowOpenChanged={vi.fn()}
          onGoToSavedPosition={vi.fn()}
          onToggleImmersive={vi.fn()}
        />,
      );
    });

    act(() => renderer.root.findByProps({ 'aria-label': '북마크 추가' }).props.onClick());
    expect(toggleBookmark).toHaveBeenCalledWith(fallbackLocation);
    const savingButton = renderer.root.findByProps({ 'aria-label': '북마크 저장 중' });
    expect(savingButton.props.disabled).toBe(true);

    act(() => savingButton.props.onClick());
    expect(toggleBookmark).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(renderer.root.findByProps({ 'aria-label': '북마크 추가' }).props.disabled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
