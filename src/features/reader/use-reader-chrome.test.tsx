import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderChrome, type ReaderChromeController } from './use-reader-chrome';

function installBrowserStubs() {
  const fullscreenTarget = new EventTarget() as EventTarget & {
    fullscreenElement: Element | null;
    fullscreenEnabled: boolean;
    documentElement: { requestFullscreen: () => Promise<void> };
    exitFullscreen: () => Promise<void>;
  };
  fullscreenTarget.fullscreenElement = null;
  fullscreenTarget.fullscreenEnabled = true;
  fullscreenTarget.documentElement = { requestFullscreen: vi.fn(() => Promise.resolve()) };
  fullscreenTarget.exitFullscreen = vi.fn(() => Promise.resolve());
  vi.stubGlobal('document', fullscreenTarget);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
}

function renderChrome(keepVisible: boolean) {
  let controller!: ReaderChromeController;
  function Harness() {
    controller = useReaderChrome(keepVisible, vi.fn());
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  return { controller: () => controller, renderer };
}

describe('useReaderChrome immersive mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installBrowserStubs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays hidden when ordinary reveal events fire until immersive mode is explicitly toggled off', () => {
    const view = renderChrome(false);

    act(() => view.controller().enterImmersive());
    expect(view.controller()).toMatchObject({ immersive: true, visible: false });

    act(() => {
      view.controller().reveal();
      vi.advanceTimersByTime(10_000);
    });
    expect(view.controller()).toMatchObject({ immersive: true, visible: false });

    act(() => view.controller().toggleImmersive());
    expect(view.controller()).toMatchObject({ immersive: false, visible: true });

    view.renderer.unmount();
  });

  it('overrides the always-visible chrome preference while immersed', () => {
    const view = renderChrome(true);

    act(() => view.controller().enterImmersive());
    act(() => view.controller().reveal());

    expect(view.controller()).toMatchObject({ immersive: true, visible: false });
    view.renderer.unmount();
  });
});
