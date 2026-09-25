export const DESKTOP_SERVER_SELECTION_KEY = 'moya.desktopServerSelection';

export type DesktopServerSelection =
  | { readonly version: 1; readonly mode: 'embedded' }
  | { readonly version: 1; readonly mode: 'remote'; readonly serverUrl: string };

export function normalizeDesktopServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('서버 주소를 확인해 주세요.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('서버의 첫 화면 주소를 입력해 주세요. 계정 정보와 /api 경로는 넣지 않습니다.');
  }
  return url.origin + '/';
}

export function readDesktopServerSelection(storage: Pick<Storage, 'getItem'>): DesktopServerSelection {
  const raw = storage.getItem(DESKTOP_SERVER_SELECTION_KEY);
  if (raw === null) return { version: 1, mode: 'embedded' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('저장된 서재 선택을 읽을 수 없습니다. 서재 선택을 다시 저장해 주세요.');
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) {
    throw new Error('저장된 서재 선택 형식을 확인해 주세요.');
  }
  if (!('mode' in parsed)) throw new Error('저장된 서재 선택 형식을 확인해 주세요.');
  if (parsed.mode === 'embedded') return { version: 1, mode: 'embedded' };
  if (parsed.mode === 'remote' && 'serverUrl' in parsed && typeof parsed.serverUrl === 'string') {
    return { version: 1, mode: 'remote', serverUrl: normalizeDesktopServerUrl(parsed.serverUrl) };
  }
  throw new Error('저장된 서재 선택 형식을 확인해 주세요.');
}

export function saveDesktopServerSelection(storage: Pick<Storage, 'setItem'>, selection: DesktopServerSelection): void {
  const safe: DesktopServerSelection =
    selection.mode === 'remote'
      ? { version: 1, mode: 'remote', serverUrl: normalizeDesktopServerUrl(selection.serverUrl) }
      : { version: 1, mode: 'embedded' };
  storage.setItem(DESKTOP_SERVER_SELECTION_KEY, JSON.stringify(safe));
}
