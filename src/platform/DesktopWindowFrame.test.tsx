import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopWindowShell } from './DesktopWindowFrame';

afterEach(() => vi.unstubAllGlobals());
describe('desktop window shell runtime detection', () => {
  it.each([
    ['Windows NT 10.0', true, true],
    ['Windows NT 10.0', false, false],
    ['Macintosh', true, false],
    ['Android', true, false],
  ])('selects the frame for %s with native=%s', (userAgent, native, expected) => {
    vi.stubGlobal('window', { navigator: { userAgent }, ...(native ? { __TAURI_INTERNALS__: {} } : {}) });
    expect(
      renderToStaticMarkup(
        <DesktopWindowShell>
          <main>Reader</main>
        </DesktopWindowShell>,
      ).includes('desktop-window-frame'),
    ).toBe(expected);
  });
  it('renders content without window in server tests', () => {
    vi.stubGlobal('window', undefined);
    expect(
      renderToStaticMarkup(
        <DesktopWindowShell>
          <main>Reader</main>
        </DesktopWindowShell>,
      ),
    ).toBe('<main>Reader</main>');
  });
});
