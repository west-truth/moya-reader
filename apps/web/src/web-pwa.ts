import { useSyncExternalStore } from 'react';

export interface OfflineStatus {
  version: string;
  total: number;
  completed: number;
  totalBytes: number;
  cachedBytes: number;
}

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface WebPwaState {
  phase: 'starting' | 'ready' | 'unsupported' | 'error';
  online: boolean;
  busy: boolean;
  preparing: boolean;
  waiting?: ServiceWorker;
  offline?: OfflineStatus;
  error?: string;
  installPrompt?: InstallPrompt;
  installed: boolean;
}

let state: WebPwaState = {
  phase: 'starting',
  online: globalThis.navigator?.onLine !== false,
  busy: false,
  preparing: false,
  installed: false,
};
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | undefined;
let started = false;
let lastUpdateCheck = 0;
function change(update: Partial<WebPwaState>) {
  state = { ...state, ...update };
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useWebPwa = () => useSyncExternalStore(subscribe, () => state);

function requestWorker(type: 'OFFLINE_STATUS' | 'PREPARE_OFFLINE', onProgress?: (status: OfflineStatus) => void) {
  return new Promise<OfflineStatus>((resolve, reject) => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) {
      reject(new Error('worker-not-ready'));
      return;
    }
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      channel.port1.close();
    };
    const timeout = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          finish();
          reject(new Error('worker-timeout'));
        },
        type === 'PREPARE_OFFLINE' ? 120000 : 10000,
      );
    };
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === 'error') {
        finish();
        reject(new Error('offline-download-failed'));
        return;
      }
      if (!data || typeof data.version !== 'string' || !Number.isFinite(data.completed) || !Number.isFinite(data.total))
        return;
      if (data.type === 'progress') {
        timeout();
        onProgress?.(data);
        return;
      }
      finish();
      resolve(data);
    };
    timeout();
    worker.postMessage({ type }, [channel.port2]);
  });
}

export async function refreshOfflineStatus() {
  if (!navigator.serviceWorker?.controller || state.preparing) return;
  try {
    const offline = await requestWorker('OFFLINE_STATUS');
    if (!state.preparing) change({ phase: 'ready', offline });
  } catch {
    change({ error: '오프라인 상태를 확인하지 못했습니다. 새 버전 적용 또는 다시 확인을 눌러 주세요.' });
  }
}

export async function prepareWebOffline() {
  if (state.preparing) return;
  change({ preparing: true, error: undefined });
  try {
    const offline = await requestWorker('PREPARE_OFFLINE', (progress) => change({ offline: progress }));
    change({ offline, preparing: false, error: undefined });
  } catch {
    change({
      preparing: false,
      error: '준비가 중단되었습니다. 연결과 저장 공간을 확인한 뒤 다시 누르면 받은 파일부터 이어갑니다.',
    });
    await refreshOfflineStatus();
  }
}

export function setWebWorkBusy(busy: boolean) {
  change({ busy });
}

export async function checkWebUpdate() {
  if (!registration) {
    await register();
    return;
  }
  try {
    lastUpdateCheck = Date.now();
    await registration.update();
    change({ error: undefined });
    await refreshOfflineStatus();
  } catch {
    change({ error: '업데이트를 확인하지 못했습니다. 인터넷에 연결한 뒤 다시 시도하세요.' });
  }
}

export function applyWebUpdate() {
  if (!state.waiting || state.busy || state.preparing) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  state.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
}

export async function installWebApp() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  change({ installPrompt: undefined });
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch {
    change({ error: '브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택해 주세요.' });
  }
}

async function register() {
  change({ phase: 'starting', error: undefined });
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
    const inspect = () => {
      change({ waiting: navigator.serviceWorker.controller ? (registration?.waiting ?? undefined) : undefined });
      if (navigator.serviceWorker.controller) {
        change({ phase: 'ready' });
        void refreshOfflineStatus();
      }
      if (registration?.installing?.state === 'redundant' && !navigator.serviceWorker.controller)
        change({ phase: 'error' });
    };
    const update = () => {
      const installing = registration?.installing;
      installing?.addEventListener('statechange', () => {
        inspect();
        if (installing.state === 'redundant') {
          if (!navigator.serviceWorker.controller) change({ phase: 'error' });
          else change({ error: '새 버전을 받지 못해 현재 버전을 유지했습니다. 연결과 저장 공간을 확인해 주세요.' });
        }
      });
    };
    registration.addEventListener('updatefound', update);
    update();
    inspect();
    lastUpdateCheck = Date.now();
  } catch {
    change({ phase: 'error' });
  }
}

/** One registration and one set of browser listeners, shared by status/settings/lifecycle UI. */
export function startWebPwa() {
  if (started) return;
  started = true;
  if (!import.meta.env.PROD || !navigator.serviceWorker || !globalThis.isSecureContext) {
    change({ phase: 'unsupported' });
    return;
  }
  change({ installed: matchMedia('(display-mode: standalone)').matches });
  window.addEventListener('online', () => {
    change({ online: true });
    void refreshOfflineStatus();
  });
  window.addEventListener('offline', () => change({ online: false }));
  window.addEventListener('focus', () => {
    if (Date.now() - lastUpdateCheck > 60 * 60 * 1000 && navigator.onLine) void checkWebUpdate();
    else void refreshOfflineStatus();
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    change({ installPrompt: event as InstallPrompt });
  });
  window.addEventListener('appinstalled', () => change({ installed: true, installPrompt: undefined }));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    change({ phase: 'ready' });
    void refreshOfflineStatus();
  });
  void register();
}
