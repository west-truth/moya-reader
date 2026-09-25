import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopRemoteHome, DesktopServerChoice } from './DesktopServerChoice';
import { DESKTOP_SERVER_SELECTION_KEY } from './desktop-server-selection';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

let renderer: ReactTestRenderer;
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      navigator: { userAgent: 'Windows NT 10.0' },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    }),
  );
  invoke.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('opens the selected external server without starting the embedded server', async () => {
  await act(async () => {
    renderer = create(
      <DesktopRemoteHome selection={{ version: 1, mode: 'remote', serverUrl: 'https://reader.example/' }} />,
    );
  });
  expect(invoke).toHaveBeenCalledWith('desktop_remote_server_open', { address: 'https://reader.example/' });
  expect(invoke).not.toHaveBeenCalledWith('desktop_embedded_server_start');
});

it('saves a new server for the next app start without switching the running library', async () => {
  await act(async () => {
    renderer = create(<DesktopServerChoice current={{ version: 1, mode: 'embedded' }} />);
  });
  await act(async () => {
    window.dispatchEvent(new Event('moya-open-server-choice'));
  });
  const radios = renderer.root.findAllByProps({ type: 'radio' });
  await act(async () => radios[1].props.onChange());
  const address = renderer.root.findByProps({ type: 'url' });
  await act(async () => address.props.onChange({ target: { value: 'https://reader.example/' } }));
  const form = renderer.root.findByType('form');
  await act(async () => form.props.onSubmit({ preventDefault: () => undefined }));
  expect(values.get(DESKTOP_SERVER_SELECTION_KEY)).toBe(
    JSON.stringify({ version: 1, mode: 'remote', serverUrl: 'https://reader.example/' }),
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('다음 앱 시작에 적용됩니다');
});
