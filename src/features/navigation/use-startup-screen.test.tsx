import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStartupScreen, useStartupScreen } from './use-startup-screen';
import { useNavigationViewState } from './navigation-view-state';

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());
const shelves = [{ id: 'normal' }, { id: 'other' }];
const tabs = [{ id: 'hidden', hidden: true }, { id: 'browse' }, { id: 'novels' }];

describe('startup destination', () => {
  it('preserves legacy behavior unless configured, and handles deleted/hidden destinations', () => {
    expect(resolveStartupScreen(undefined, shelves, tabs)).toBeUndefined();
    expect(resolveStartupScreen({ kind: 'library', shelfId: 'deleted' }, shelves, tabs)).toEqual({
      kind: 'library',
      shelfId: undefined,
    });
    expect(resolveStartupScreen({ kind: 'discovery', tabId: 'hidden' }, shelves, tabs)).toEqual({
      kind: 'discovery',
      tabId: 'browse',
    });
    expect(resolveStartupScreen({ kind: 'discovery', tabId: 'novels' }, shelves, tabs)).toEqual({
      kind: 'discovery',
      tabId: 'novels',
    });
  });

  function mount(patch: Partial<Parameters<typeof useStartupScreen>[0]> = {}) {
    let input = {
      ready: false,
      preference: { kind: 'library' as const, shelfId: 'normal' },
      shelvesReady: false,
      shelves,
      discoveryReady: true,
      tabs,
      discoveryScope: 'startup-test',
      atLibraryRoot: true,
      setShelf: vi.fn(),
      openDiscovery: vi.fn(),
      ...patch,
    };
    let settled = false;
    function Harness() {
      settled = useStartupScreen(input);
      return null;
    }
    let renderer!: ReactTestRenderer;
    const render = () => (
      <StrictMode>
        <Harness />
      </StrictMode>
    );
    act(() => {
      renderer = create(render());
    });
    return {
      input,
      get settled() {
        return settled;
      },
      update(patch: Partial<typeof input>) {
        input = { ...input, ...patch };
        act(() => renderer.update(render()));
      },
      unmount() {
        act(() => renderer.unmount());
      },
    };
  }
  it('waits for persisted settings and shelves, overrides the remembered shelf once, then leaves navigation alone', () => {
    const test = mount();
    test.update({ ready: true });
    expect(test.input.setShelf).not.toHaveBeenCalled();
    expect(test.settled).toBe(false);
    test.update({ shelvesReady: true });
    expect(test.input.setShelf).toHaveBeenCalledExactlyOnceWith('normal');
    expect(test.settled).toBe(true);
    test.update({ preference: { kind: 'library', shelfId: 'other' }, shelves: [] });
    expect(test.input.setShelf).toHaveBeenCalledTimes(1);
    test.unmount();
  });
  it('explicit all-books clears the remembered shelf', () => {
    const test = mount({ ready: true, shelvesReady: true, preference: { kind: 'library' } });
    expect(test.input.setShelf).toHaveBeenCalledExactlyOnceWith(undefined);
    test.unmount();
  });
  it.each(['pointerdown', 'keydown'])('does not override user navigation while booting (%s)', (event) => {
    const test = mount();
    window.dispatchEvent(new Event(event));
    test.update({ ready: true, shelvesReady: true });
    expect(test.input.setShelf).not.toHaveBeenCalled();
    expect(test.settled).toBe(true);
    test.unmount();
  });
  it('does not redirect an already opened source or reader', () => {
    const test = mount({ ready: true, atLibraryRoot: false });
    expect(test.input.setShelf).not.toHaveBeenCalled();
    expect(test.settled).toBe(true);
    test.unmount();
  });
  it('waits for discovery configuration and initializes the selected tab before opening it', () => {
    const test = mount({ ready: true, discoveryReady: false, preference: { kind: 'discovery', tabId: 'novels' } });
    expect(test.input.openDiscovery).not.toHaveBeenCalled();
    test.update({ discoveryReady: true });
    expect(test.input.openDiscovery).toHaveBeenCalledOnce();
    let selected: string | undefined;
    function Discovery() {
      [selected] = useNavigationViewState('discovery-tab:startup-test', 'browse');
      return null;
    }
    const renderer = create(<Discovery />);
    expect(selected).toBe('novels');
    renderer.unmount();
    test.unmount();
  });
});
