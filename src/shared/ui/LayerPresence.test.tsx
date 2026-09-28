import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { LayerPresence } from './LayerPresence';

vi.mock('./use-dismissible-layer', () => ({ useDismissibleLayer: () => undefined }));

type Listener = (event: { target: unknown }) => void;

function animatedNode() {
  const listeners = new Map<string, Listener>();
  const node = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  return { node, finish: () => listeners.get('animationend')?.({ target: node }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LayerPresence', () => {
  it('keeps a closed layer mounted briefly so it can animate out', () => {
    vi.useFakeTimers();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <LayerPresence open>
          <p>panel</p>
        </LayerPresence>,
      );
    });
    expect(renderer.root.findAllByType('p')).toHaveLength(1);

    act(() => {
      renderer.update(
        <LayerPresence open={false}>
          <p>panel</p>
        </LayerPresence>,
      );
    });
    expect(renderer.root.findAllByType('p')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it('never mounts a layer that was not opened', () => {
    const renderer = create(
      <LayerPresence open={false}>
        <p>panel</p>
      </LayerPresence>,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('Dialog exit presence', () => {
  const dialog = (open: boolean) => (
    <Dialog open={open} title="설정" onClose={vi.fn()}>
      <p>content</p>
    </Dialog>
  );

  it('unmounts immediately when no exit animation runs', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(dialog(true));
    });
    act(() => renderer.update(dialog(false)));
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the closed state until the exit animation ends', () => {
    vi.stubGlobal('window', {
      getComputedStyle: () => ({ animationName: 'overlay-fade-out', animationDuration: '0.16s' }),
      setTimeout,
      clearTimeout,
    });
    const { node, finish } = animatedNode();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(dialog(true), { createNodeMock: () => node });
    });
    act(() => renderer.update(dialog(false)));
    const layer = renderer.root.findByProps({ className: 'modal-backdrop' });
    expect(layer.props['data-state']).toBe('closed');

    act(() => finish());
    expect(renderer.toJSON()).toBeNull();
  });
});
