import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteAccessSettings } from './RemoteAccessSettings';
import { SyncSettings } from './SyncSettings';
import { EmbeddedAccessContext } from '../../platform/embedded-access-context';

afterEach(() => vi.unstubAllGlobals());
it('shares the self-host address without account credentials or desktop controls', () => {
  vi.stubGlobal('window', { location: { href: 'https://reader.example:18443/' } });
  const html = renderToStaticMarkup(<RemoteAccessSettings serverApiBaseUrl="/api" />);
  expect(html).toContain('https://reader.example:18443/');
  expect(html).toContain('서재 접속 QR 코드');
  expect(html).not.toContain('다른 기기 접속 허용');
  expect(renderToStaticMarkup(<SyncSettings openSync={() => {}} />)).not.toContain('사용할 서재 선택');
});
it('does not advertise loopback as a remote address', () => {
  vi.stubGlobal('window', { location: { href: 'http://localhost:18443/' } });
  const html = renderToStaticMarkup(<RemoteAccessSettings serverApiBaseUrl="/api" />);
  expect(html).toContain('현재 주소는 이 기기에서만');
  expect(html).not.toContain('서재 접속 QR 코드');
});
it('places native library selection inline in desktop sync settings', () => {
  vi.stubGlobal('window', { localStorage: { getItem: () => null } });
  const html = renderToStaticMarkup(
    <EmbeddedAccessContext.Provider
      value={{ connection: { url: 'http://127.0.0.1:1', authToken: 'secret' }, status: {} }}
    >
      <SyncSettings openSync={() => {}} />
    </EmbeddedAccessContext.Provider>,
  );
  expect(html).toContain('사용할 서재 선택');
  expect(html).not.toContain('modal-backdrop');
  expect(html).not.toContain('secret');
});
