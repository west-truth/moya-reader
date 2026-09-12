import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Web update and offline lifecycle', () => {
  async function setup() {
    vi.resetModules();
    vi.stubEnv('PROD', true);
    vi.stubEnv('BASE_URL', '/reader/');
    const waiting = { postMessage: vi.fn() };
    const registration = Object.assign(new EventTarget(), { waiting, update: vi.fn(async () => {}) });
    const controller = {
      postMessage: vi.fn((message: { type: string }, ports: MessagePort[]) => {
        ports[0].postMessage({
          type: message.type === 'OFFLINE_STATUS' ? 'status' : 'complete',
          version: 'fixture',
          completed: 4,
          total: 4,
          totalBytes: 100,
          cachedBytes: 100,
        });
      }),
    };
    const serviceWorker = Object.assign(new EventTarget(), { controller, register: vi.fn(async () => registration) });
    vi.stubGlobal('navigator', { serviceWorker, onLine: true });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('isSecureContext', true);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const runtime = await import('./web-pwa');
    runtime.startWebPwa();
    await vi.waitFor(() => expect(controller.postMessage).toHaveBeenCalled());
    return { runtime, waiting, serviceWorker, registration, reload };
  }
  it('registers once and refuses to activate while import/backup/sync work is active', async () => {
    const { runtime, waiting, serviceWorker, reload } = await setup();
    runtime.startWebPwa();
    expect(serviceWorker.register).toHaveBeenCalledOnce();
    expect(serviceWorker.register).toHaveBeenCalledWith('/reader/sw.js', { scope: '/reader/' });
    runtime.setWebWorkBusy(true);
    runtime.applyWebUpdate();
    expect(waiting.postMessage).not.toHaveBeenCalled();
    runtime.setWebWorkBusy(false);
    runtime.applyWebUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'ACTIVATE_UPDATE' });
    expect(reload).not.toHaveBeenCalled();
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledOnce();
    await runtime.refreshOfflineStatus();
  });
  it('waits for explicit full-offline requests and accepts retry after a worker error', async () => {
    const { runtime, serviceWorker } = await setup();
    expect(
      serviceWorker.controller.postMessage.mock.calls.every(([message]) => message.type === 'OFFLINE_STATUS'),
    ).toBe(true);
    serviceWorker.controller.postMessage.mockImplementationOnce((_message, ports) =>
      ports[0].postMessage({ type: 'error' }),
    );
    await runtime.prepareWebOffline();
    await runtime.prepareWebOffline();
    expect(
      serviceWorker.controller.postMessage.mock.calls.filter(([message]) => message.type === 'PREPARE_OFFLINE'),
    ).toHaveLength(2);
  });
});
