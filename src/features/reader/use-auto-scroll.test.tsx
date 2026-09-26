import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoScroll } from './use-auto-scroll';
import type { ReaderViewportApi } from './ReaderViewport';

describe('automatic text scrolling', () => {
  let renderer: ReactTestRenderer;
  let controller: ReturnType<typeof useAutoScroll>;
  let frames: Map<number, FrameRequestCallback>;
  let clock: number;
  let documentStub: EventTarget & { hidden: boolean };
  let scope: string;
  let allowed: boolean;
  let ready: boolean;
  let next: Parameters<typeof useAutoScroll>[4];
  let step: ReturnType<typeof vi.fn<NonNullable<ReaderViewportApi['advanceAutoScroll']>>>;
  let viewport: { current: ReaderViewportApi };

  function Harness() {
    controller = useAutoScroll(viewport, scope, allowed, ready, next);
    return null;
  }
  function render() {
    act(() => renderer.update(<Harness />));
  }
  function tick(delta = 50) {
    clock += delta;
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => callbacks.forEach((callback) => callback(clock)));
  }
  function advance(count: number) {
    for (let i = 0; i < count; i++) tick();
  }
  beforeEach(() => {
    frames = new Map();
    clock = 0;
    scope = 'book:1';
    allowed = true;
    ready = true;
    next = undefined;
    let frameId = 0;
    documentStub = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    step = vi.fn<NonNullable<ReaderViewportApi['advanceAutoScroll']>>(() => 'moving');
    viewport = { current: { advanceAutoScroll: step } as unknown as ReaderViewportApi };
    act(() => {
      renderer = create(<Harness />);
    });
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('keeps an opted-in overlay paused and resumes from the current viewport', () => {
    expect(controller.overlayVisible).toBe(false);
    act(() => controller.setAlwaysShowOverlay(true));
    expect(controller.overlayVisible).toBe(false);
    expect(localStorage.setItem).toHaveBeenLastCalledWith('moya.text-auto-overlay.v1', 'true');
    act(() => controller.start());
    advance(3);
    expect(controller.overlayVisible).toBe(true);
    act(() => controller.stop());
    const calls = step.mock.calls.length;
    advance(3);
    expect(step.mock.calls).toHaveLength(calls);
    expect(controller.running).toBe(false);
    expect(controller.overlayVisible).toBe(true);
    act(() => controller.start());
    advance(3);
    expect(step.mock.calls.length).toBeGreaterThan(calls);
    act(() => controller.stop());
    act(() => controller.setAlwaysShowOverlay(false));
    expect(controller.overlayVisible).toBe(false);
  });

  it('remembers the overlay preference without starting automatically on remount', () => {
    act(() => renderer.unmount());
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'moya.text-auto-overlay.v1' ? 'true' : null),
      setItem: vi.fn(),
    });
    act(() => {
      renderer = create(<Harness />);
    });
    expect(controller.alwaysShowOverlay).toBe(true);
    expect(controller.running).toBe(false);
    expect(controller.overlayVisible).toBe(false);
    act(() => controller.start());
    allowed = false;
    render();
    expect(controller.running).toBe(false);
    expect(controller.overlayVisible).toBe(true);
    act(() => controller.start());
    expect(controller.running).toBe(false);
  });

  it('supports 1200px/s while keeping other reading modes at their previous speed', () => {
    act(() => controller.setSpeed(240));
    expect(controller.speed).toBe(240);
    expect(controller.maxSpeed).toBe(240);
    expect(localStorage.setItem).toHaveBeenLastCalledWith('moya.text-auto-pixel-speed.v2', '240');
    act(() => controller.start());
    advance(21);
    expect(step.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBe(1200);
    act(() => controller.setMode('page'));
    expect(controller.speed).toBe(4);
    expect(controller.maxSpeed).toBe(12);
    act(() => controller.setSpeed(240));
    expect(controller.speed).toBe(4);
    act(() => controller.setMode('pixel'));
    expect(controller.speed).toBe(240);
    act(() => controller.setSpeed(241));
    expect(controller.speed).toBe(240);
  });

  it('restores a separate comic pixel preference without overwriting legacy text speeds', () => {
    act(() => renderer.unmount());
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'moya.reader-auto-scroll-speed.v1' ? '12' : key === 'moya.comic-auto-pixel-speed.v2' ? '120' : null,
      setItem: vi.fn(),
    });
    function Comic() {
      controller = useAutoScroll(viewport, scope, allowed, ready, next, 'comic');
      return null;
    }
    act(() => {
      renderer = create(<Comic />);
    });
    expect(controller.speed).toBe(120);
    act(() => controller.setSpeed(200));
    expect(localStorage.setItem).toHaveBeenLastCalledWith('moya.comic-auto-pixel-speed.v2', '200');
    act(() => renderer.unmount());
    act(() => {
      renderer = create(<Harness />);
    });
    expect(controller.speed).toBe(12);
  });

  it('allows blind modes in pagination and keeps scrolling modes disabled', () => {
    const advanceAutoReading = vi.fn(() => 'moving' as const);
    viewport.current = { ...viewport.current, flow: 'paginated', advanceAutoReading };
    render();
    act(() => controller.start());
    expect(controller.running).toBe(false);
    act(() => controller.setMode('blind-line'));
    act(() => controller.start());
    advance(40);
    expect(controller.running).toBe(true);
    expect(advanceAutoReading).toHaveBeenCalled();
    act(() => controller.setMode('pixel'));
    expect(controller.running).toBe(false);
  });

  it('starts only explicitly, accumulates small steps and drops long frame delays', () => {
    advance(10);
    expect(step).not.toHaveBeenCalled();
    act(() => controller.setSpeed(1));
    act(() => controller.start());
    advance(21);
    expect(step.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBe(5);
    step.mockClear();
    tick(10000);
    expect(step.mock.calls.reduce((sum, [delta]) => sum + delta, 0)).toBeLessThanOrEqual(1);
  });

  it.each(['wheel', 'pointerdown', 'touchstart', 'keydown'])('stops immediately on %s', (event) => {
    act(() => controller.start());
    advance(3);
    act(() => {
      documentStub.dispatchEvent(new Event(event));
    });
    expect(controller.running).toBe(false);
    step.mockClear();
    advance(5);
    expect(step).not.toHaveBeenCalled();
  });

  it('stops on backgrounding, mode changes and manual chapter changes without resuming', () => {
    act(() => controller.start());
    documentStub.hidden = true;
    act(() => {
      documentStub.dispatchEvent(new Event('visibilitychange'));
    });
    expect(controller.running).toBe(false);
    documentStub.hidden = false;
    act(() => controller.start());
    allowed = false;
    render();
    allowed = true;
    render();
    expect(controller.running).toBe(false);
    act(() => controller.start());
    scope = 'book:2';
    render();
    expect(controller.running).toBe(false);
  });

  it('waits for restored content and ends without navigation by default', () => {
    ready = false;
    render();
    act(() => controller.start());
    expect(controller.running).toBe(false);
    ready = true;
    render();
    act(() => controller.start());
    step.mockReturnValue('waiting');
    advance(25);
    expect(controller.running).toBe(true);
    step.mockReturnValue('end');
    advance(20);
    expect(controller.running).toBe(false);
  });

  it('requires a stable end and opens the opted-in next chapter exactly once, then continues', async () => {
    const open = vi.fn(async () => undefined);
    next = { scope: 'book:2', open };
    render();
    act(() => controller.setContinueChapter(true));
    act(() => controller.start());
    step.mockReturnValue('end');
    advance(12);
    step.mockReturnValue('moving');
    advance(2);
    step.mockReturnValue('end');
    advance(12);
    expect(open).not.toHaveBeenCalled();
    await act(async () => advance(10));
    expect(open).toHaveBeenCalledOnce();
    advance(25);
    expect(open).toHaveBeenCalledOnce();
    scope = 'book:2';
    ready = false;
    render();
    step.mockClear();
    advance(5);
    expect(step).not.toHaveBeenCalled();
    ready = true;
    next = undefined;
    step.mockReturnValue('moving');
    render();
    advance(5);
    expect(controller.running).toBe(true);
    expect(step).toHaveBeenCalled();
  });

  it('invalidates an in-flight transition when stopped or unmounted', async () => {
    let isCurrent!: () => boolean;
    next = {
      scope: 'book:2',
      open: async (check) => {
        isCurrent = check;
      },
    };
    render();
    act(() => controller.setContinueChapter(true));
    act(() => controller.start());
    step.mockReturnValue('end');
    await act(async () => advance(20));
    expect(isCurrent()).toBe(true);
    act(() => controller.stop());
    expect(isCurrent()).toBe(false);
    act(() => controller.start());
    await act(async () => advance(20));
    act(() => renderer.unmount());
    expect(isCurrent()).toBe(false);
  });

  it('dispatches line/page/RSVP ticks in their own units and clears presentation on stop', () => {
    const advanceAutoReading = vi.fn(() => 'moving' as const);
    const resetAutoReading = vi.fn();
    viewport.current = { ...viewport.current, advanceAutoReading, resetAutoReading };
    act(() => controller.setMode('line'));
    act(() => controller.setSpeed(6));
    act(() => controller.start());
    advance(21);
    expect(advanceAutoReading).toHaveBeenCalledExactlyOnceWith('line', 1);
    act(() => controller.setMode('page'));
    expect(controller.running).toBe(false);
    expect(resetAutoReading).toHaveBeenCalled();
    advanceAutoReading.mockClear();
    act(() => controller.setSpeed(12));
    act(() => controller.start());
    advance(21);
    expect(advanceAutoReading).toHaveBeenCalledExactlyOnceWith('page', 1);
    act(() => controller.setMode('rsvp'));
    advanceAutoReading.mockClear();
    act(() => controller.setSpeed(4));
    act(() => controller.start());
    advance(21);
    expect(advanceAutoReading).toHaveBeenCalledTimes(3);
    expect(step).not.toHaveBeenCalled();
  });
  it('counts a full page interval only after readiness and never catches up delayed turns', () => {
    let result: 'moving' | 'waiting' | 'failed' = 'waiting';
    const turn = vi.fn(() => result);
    viewport.current = { ...viewport.current, flow: 'paginated', advanceAutoReading: turn };
    render();
    act(() => controller.setMode('page-turn'));
    act(() => controller.setInterval(3));
    act(() => controller.start());
    advance(100);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(0);
    result = 'moving';
    advance(59);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(0);
    advance(1);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(1);
    tick(60000);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(1);
    result = 'waiting';
    advance(80);
    result = 'moving';
    advance(59);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(1);
    advance(1);
    expect(turn.mock.calls.filter((call: unknown[]) => call[1] === 1)).toHaveLength(2);
    result = 'failed';
    advance(1);
    expect(controller.running).toBe(false);
  });

  it('stops on a flow switch even for a mode supported in both views', () => {
    viewport.current = { ...viewport.current, advanceAutoReading: () => 'moving' };
    act(() => controller.setMode('blind-line'));
    act(() => controller.start());
    expect(controller.running).toBe(true);
    viewport.current = { ...viewport.current, flow: 'paginated' };
    render();
    expect(controller.running).toBe(false);
  });
});
