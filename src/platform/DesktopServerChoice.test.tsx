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

it('keeps the remote selection screen available after a connection failure', async () => {
  invoke.mockRejectedValueOnce(new Error('서버에 연결하지 못했습니다.'));
  await act(async () => {
    renderer = create(
      <DesktopRemoteHome selection={{ version: 1, mode: 'remote', serverUrl: 'https://reader.example/' }} />,
    );
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('서버에 연결하지 못했습니다.');
  const retry = renderer.root.findAllByType('button').find((button) => button.props.children === '서버 창 열기');
  expect(retry).toBeDefined();
  await act(async () => retry?.props.onClick());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(renderer.toJSON())).toContain('서버 창을 열었습니다.');
  const change = renderer.root.findAllByType('button').find((button) => button.props.children === '사용할 서재 변경');
  await act(async () => change?.props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain('사용할 서재 선택');
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

it('opens an older server in the system browser without native frontend compatibility', async () => {
  invoke.mockRejectedValueOnce(new Error('이 서버의 웹 화면은 앱 내 접속을 지원하지 않습니다.'));
  await act(async () => {
    renderer = create(
      <DesktopRemoteHome selection={{ version: 1, mode: 'remote', serverUrl: 'https://reader.example:18443/' }} />,
    );
  });
  const fallback = renderer.root
    .findAllByType('button')
    .find((button) => button.props.children === '일반 브라우저에서 열기');
  await act(async () => fallback?.props.onClick());
  expect(invoke).toHaveBeenLastCalledWith('desktop_remote_server_open_browser', {
    address: 'https://reader.example:18443/',
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('기본 브라우저에서 서버를 열었습니다.');
});

it('shows the failed connection stage and a copyable diagnostic without response bodies', async () => {
  invoke.mockRejectedValueOnce({
    message: '서버 화면이 앱 내 접속을 지원하지 않습니다.',
    stage: '웹 화면 호환성',
    code: 'frontend_incompatible',
    detail: '로그인 API 확인 성공. 호환 표식이 없습니다.',
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await act(async () => {
    renderer = create(
      <DesktopRemoteHome selection={{ version: 1, mode: 'remote', serverUrl: 'https://reader.example:18443/' }} />,
    );
  });
  const tree = JSON.stringify(renderer.toJSON());
  expect(tree).toContain('웹 화면 호환성');
  expect(tree).toContain('frontend_incompatible');
  expect(tree).not.toContain('[object Object]');
  const copy = renderer.root.findAllByType('button').find((button) => button.props.children === '진단 복사');
  await act(async () => copy?.props.onClick());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('로그인 API 확인 성공'));
});
