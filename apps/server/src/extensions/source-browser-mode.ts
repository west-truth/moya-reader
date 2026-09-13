import type { CompatibilityPreference } from '../../../../src/extensions/packages/compatibility-preferences';
export const SOURCE_BROWSER_MODE_KEY = '__moya_webview_mode';
export type SourceBrowserMode = 'browser' | 'broker' | 'patchright';
export function sourceBrowserMode(value: unknown): SourceBrowserMode | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value !== 'browser' && value !== 'broker' && value !== 'patchright')
    throw new Error('compatibility_preferences_invalid');
  return value;
}
export function sourceBrowserModeField(value?: SourceBrowserMode): CompatibilityPreference {
  return {
    key: SOURCE_BROWSER_MODE_KEY,
    title: 'WebView 연결 방식',
    kind: 'select' as const,
    secret: false,
    value: value ?? sourceBrowserMode(process.env.MOYA_SOURCE_BROWSER_MODE) ?? 'browser',
    summary:
      '브라우저가 직접 통신하고 세션을 유지합니다. 접속 문제가 있으면 탐지 대응 또는 기존 호환 방식을 선택하세요.',
    choices: [
      { label: '브라우저 방식', value: 'browser' },
      { label: '브라우저 방식 · 탐지 대응', value: 'patchright' },
      { label: '기존 호환 방식', value: 'broker' },
    ],
  };
}
