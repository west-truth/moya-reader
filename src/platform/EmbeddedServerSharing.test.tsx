import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { EmbeddedServerSharing } from './EmbeddedServerSharing';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../features/auth/self-host-auth-client', () => ({
  SelfHostAuthClient: class {
    async status() {
      return { setupRequired: false };
    }
  },
  selfHostAuthErrorMessage: String,
}));
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.clearAllMocks();
});
const connection = { url: 'http://127.0.0.1:43127', authToken: 'private-owner-token' };
async function open(status = {}) {
  await act(async () => {
    renderer = create(<EmbeddedServerSharing connection={connection} status={status} onClose={() => {}} />);
  });
}
async function click(label: string) {
  const button = renderer.root.findAllByType('button').find((item) => item.children.includes(label));
  expect(button).toBeDefined();
  await act(async () => button!.props.onClick());
}
it('defaults to Quick Tunnel even without a LAN address, and only starts on user action', async () => {
  await open();
  expect(renderer.root.findByProps({ 'aria-label': '접속 방식' }).props.value).toBe('cloudflare');
  expect(invoke).not.toHaveBeenCalled();
  await click('다른 기기 접속 허용');
  expect(invoke).toHaveBeenCalledWith('desktop_embedded_server_share', {
    mode: 'cloudflare',
    host: null,
    hostname: null,
    token: null,
  });
});
it('allows direct access as an alternative', async () => {
  await open({ interfaces: [{ name: 'Tailscale', address: '100.64.0.2' }] });
  await act(async () =>
    renderer.root.findByProps({ 'aria-label': '접속 방식' }).props.onChange({ target: { value: 'direct' } }),
  );
  await click('다른 기기 접속 허용');
  expect(invoke).toHaveBeenCalledWith('desktop_embedded_server_share', {
    mode: 'direct',
    host: '100.64.0.2',
    hostname: null,
    token: null,
  });
});
it('can cancel a pending connection', async () => {
  await open({ sharingPending: true });
  await click('연결 취소');
  expect(invoke).toHaveBeenCalledWith('desktop_embedded_server_share', {
    mode: 'off',
    host: null,
    hostname: null,
    token: null,
  });
});
