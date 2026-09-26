import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChapterPagination } from './ChapterPagination';

// Layout is supplied by the host; exercise the actual mounted keyboard listener.
class LayoutElement {
  visible = true;
  editable = false;
  parentElement = null;
  children: LayoutElement[] = [];
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  closest() {
    return this.editable ? this : null;
  }
  contains(element: LayoutElement) {
    return this.children.includes(element);
  }
  getBoundingClientRect() {
    return { top: 50 };
  }
}
let renderer: ReactTestRenderer;
let nav: LayoutElement;
let dialogs: LayoutElement[];
let pagers: LayoutElement[];
let onPage: ReturnType<typeof vi.fn<(page: number) => void>>;
beforeEach(() => {
  nav = new LayoutElement();
  dialogs = [];
  pagers = [nav];
  onPage = vi.fn();
  vi.stubGlobal('Element', LayoutElement);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => (selector === '.chapter-pagination' ? pagers : dialogs),
    scrollingElement: { scrollTop: 0 },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function render(page = 2) {
  await act(async () => {
    renderer = create(<ChapterPagination page={page} pageCount={3} onPage={onPage} />, {
      createNodeMock: (element) => (element.type === 'nav' ? nav : null),
    });
  });
}
function press(key: string, target = new LayoutElement(), options = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    target: { value: target },
    ...Object.fromEntries(Object.entries(options).map(([name, value]) => [name, { value }])),
  });
  window.dispatchEvent(event);
  return event;
}
it('uses left/right to select valid pages and removes the listener on unmount', async () => {
  await render();
  expect(press('ArrowRight').defaultPrevented).toBe(true);
  expect(onPage).toHaveBeenLastCalledWith(3);
  press('ArrowLeft');
  expect(onPage).toHaveBeenLastCalledWith(1);
  await act(async () => renderer.update(<ChapterPagination page={3} pageCount={3} onPage={onPage} />));
  onPage.mockClear();
  expect(press('ArrowRight').defaultPrevented).toBe(false);
  expect(onPage).not.toHaveBeenCalled();
  await act(async () => renderer.update(<ChapterPagination page={1} pageCount={3} onPage={onPage} />));
  expect(press('ArrowLeft').defaultPrevented).toBe(false);
  expect(onPage).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  press('ArrowRight');
  expect(onPage).not.toHaveBeenCalled();
});
it('leaves editable widgets, modified/repeated keys, hidden panels and other dialogs alone', async () => {
  await render();
  const input = new LayoutElement();
  input.editable = true;
  press('ArrowRight', input);
  for (const key of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'repeat', 'isComposing']) {
    press('ArrowRight', undefined, { [key]: true });
  }
  nav.visible = false;
  press('ArrowRight');
  nav.visible = true;
  dialogs = [new LayoutElement()];
  press('ArrowRight');
  expect(onPage).not.toHaveBeenCalled();
  dialogs[0].children = [nav];
  press('ArrowRight');
  expect(onPage).toHaveBeenCalledExactlyOnceWith(3);
});
it('allows only the foremost visible pager to handle the key', async () => {
  await render();
  const other = new LayoutElement();
  pagers.push(other);
  press('ArrowRight');
  expect(onPage).not.toHaveBeenCalled();
  other.visible = false;
  press('ArrowRight');
  expect(onPage).toHaveBeenCalledExactlyOnceWith(3);
});
