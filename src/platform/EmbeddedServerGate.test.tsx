import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmbeddedServerGate } from './EmbeddedServerGate';
import { DesktopServerChoice } from './DesktopServerChoice';
import { DESKTOP_SERVER_SELECTION_KEY } from './desktop-server-selection';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('keeps the library unmounted until native server readiness', async () => {
  let resolve: (value: unknown) => void = () => {};
  invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const reader = vi.fn(() => <main>내장 서재</main>);
  await act(async () => {
    renderer = create(<EmbeddedServerGate>{reader}</EmbeddedServerGate>);
  });
  expect(reader).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('모야 시작 중');
  await act(async () => resolve({ phase: 'ready', running: true, url: 'http://127.0.0.1:43127', authToken: 'secret' }));
  expect(JSON.stringify(renderer.toJSON())).toContain('내장 서재');
  expect(reader).toHaveBeenCalledWith({ url: 'http://127.0.0.1:43127', authToken: 'secret' });
});

it('shows startup failure and retry without creating a local library', async () => {
  invoke.mockRejectedValue('서버 실행 실패');
  const reader = vi.fn(() => <main>unexpected library</main>);
  await act(async () => {
    renderer = create(<EmbeddedServerGate>{reader}</EmbeddedServerGate>);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('서버 실행 실패');
  expect(JSON.stringify(renderer.toJSON())).toContain('다시 시도');
  expect(reader).not.toHaveBeenCalled();
});

it('allows selecting an external server when the local server cannot start', async () => {
  vi.stubEnv('VITE_DESKTOP_EMBEDDED_SERVER', 'true');
  const values = new Map<string, string>();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      isTauri: true,
      navigator: { userAgent: 'Windows NT 10.0' },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    }),
  );
  invoke.mockRejectedValue('서버 실행 실패');
  const reader = vi.fn(() => <main>unexpected library</main>);
  await act(async () => {
    renderer = create(
      <>
        <EmbeddedServerGate>{reader}</EmbeddedServerGate>
        <DesktopServerChoice current={{ version: 1, mode: 'embedded' }} />
      </>,
    );
  });
  const choose = renderer.root.findAllByType('button').find((button) => button.props.children === '서재 선택');
  expect(choose).toBeDefined();
  await act(async () => choose!.props.onClick());
  await act(async () => renderer.root.findAllByProps({ type: 'radio' })[1].props.onChange());
  await act(async () =>
    renderer.root.findByProps({ type: 'url' }).props.onChange({ target: { value: 'https://reader.example/' } }),
  );
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(JSON.parse(values.get(DESKTOP_SERVER_SELECTION_KEY)!)).toEqual({
    version: 1,
    mode: 'remote',
    serverUrl: 'https://reader.example/',
  });
  expect(reader).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('다른 기기 접속');
});

it('keeps reader state while recovering a temporary native status failure', async () => {
  vi.useFakeTimers();
  const ready = { phase: 'ready', running: true, url: 'http://127.0.0.1:43127', authToken: 'secret' };
  invoke.mockResolvedValue(ready).mockResolvedValueOnce(ready).mockRejectedValueOnce('일시적인 연결 오류');
  function Reader() {
    const [page, setPage] = useState(1);
    return (
      <main>
        <button onClick={() => setPage(2)}>다음 페이지</button>
        <span>내장 서재 {page}</span>
      </main>
    );
  }
  await act(async () => {
    renderer = create(<EmbeddedServerGate>{() => <Reader />}</EmbeddedServerGate>);
  });
  await act(async () => renderer.root.findByType('button').props.onClick());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('일시적인 연결 오류');
  expect(renderer.root.findAllByType(Reader)).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(renderer.root.findByType('span').children).toEqual(['내장 서재 ', '2']);
  expect(JSON.stringify(renderer.toJSON())).toContain('내장 서재');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('일시적인 연결 오류');
});

it('unmounts the reader when the native process confirms it stopped', async () => {
  vi.useFakeTimers();
  invoke
    .mockResolvedValueOnce({ phase: 'ready', running: true, url: 'http://127.0.0.1:43127', authToken: 'secret' })
    .mockResolvedValue({ phase: 'failed', running: false, error: '서버 종료 확인' });
  function Reader() {
    return <main>내장 서재</main>;
  }
  await act(async () => {
    renderer = create(<EmbeddedServerGate>{() => <Reader />}</EmbeddedServerGate>);
  });
  expect(renderer.root.findAllByType(Reader)).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(renderer.root.findAllByType(Reader)).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('서버 종료 확인');
});
