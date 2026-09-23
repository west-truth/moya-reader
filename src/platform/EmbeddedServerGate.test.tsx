import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EmbeddedServerGate } from './EmbeddedServerGate';

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
