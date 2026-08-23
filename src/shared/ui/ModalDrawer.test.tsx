import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModalDrawer } from './ModalDrawer';
import { createDismissibleLayerStack } from './use-dismissible-layer';

describe('ModalDrawer', () => {
  it('renders a named modal drawer with explicit side and close control', () => {
    const markup = renderToStaticMarkup(
      <ModalDrawer open title="라이브러리 메뉴" onClose={vi.fn()} closeLabel="라이브러리 메뉴 닫기">
        <nav aria-label="라이브러리">전체 작품</nav>
      </ModalDrawer>,
    );

    expect(markup).toContain('class="modal-drawer-layer"');
    expect(markup).toContain('data-side="start"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toMatch(/aria-labelledby="[^"]+"/);
    expect(markup).toContain('aria-label="라이브러리 메뉴 닫기"');
    expect(markup).toContain('라이브러리 메뉴');
  });

  it('does not render a closed drawer', () => {
    expect(
      renderToStaticMarkup(
        <ModalDrawer open={false} title="메뉴" onClose={vi.fn()}>
          content
        </ModalDrawer>,
      ),
    ).toBe('');
  });

  it('gives keyboard dismissal ownership only to the top-most layer', () => {
    const stack = createDismissibleLayerStack();
    const drawer = stack.register();
    const dialog = stack.register();

    expect(drawer.isTop()).toBe(false);
    expect(dialog.isTop()).toBe(true);
    expect(stack.size()).toBe(2);

    dialog.release();
    expect(drawer.isTop()).toBe(true);
    expect(stack.size()).toBe(1);

    drawer.release();
    drawer.release();
    expect(stack.size()).toBe(0);
  });
});
