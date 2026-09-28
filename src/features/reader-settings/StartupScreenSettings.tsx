import type { ReaderSettingsController } from './useReaderSettingsDraft';

export function StartupScreenSettings({
  controller,
  shelves = [],
  tabs = [],
}: {
  controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
  shelves?: readonly { id: string; name: string }[];
  tabs?: readonly { id: string; title: string; hidden?: boolean }[];
}) {
  const preference = controller.settings.startupScreen;
  const options = [
    { value: 'last', label: '라이브러리 · 마지막 책장', preference: undefined },
    { value: 'library', label: '라이브러리 · 전체', preference: { kind: 'library' as const } },
    ...shelves.map((shelf) => ({
      value: `shelf:${shelf.id}`,
      label: `라이브러리 · ${shelf.name}`,
      preference: { kind: 'library' as const, shelfId: shelf.id },
    })),
    { value: 'discovery', label: '탐색 · 첫 탭', preference: { kind: 'discovery' as const } },
    ...tabs
      .filter((tab) => !tab.hidden)
      .map((tab) => ({
        value: `tab:${tab.id}`,
        label: `탐색 · ${tab.title}`,
        preference: { kind: 'discovery' as const, tabId: tab.id },
      })),
  ];
  const value =
    preference?.kind === 'library'
      ? preference.shelfId
        ? `shelf:${preference.shelfId}`
        : 'library'
      : preference?.kind === 'discovery'
        ? preference.tabId
          ? `tab:${preference.tabId}`
          : 'discovery'
        : 'last';
  const missing = !options.some((option) => option.value === value);
  return (
    <section className="reader-settings-group">
      <h3>시작 화면</h3>
      <label className="reader-settings-select-row startup-screen-select">
        <span>앱을 열면</span>
        <select
          aria-label="시작 화면"
          value={value}
          onChange={(event) => {
            const next = options.find((option) => option.value === event.target.value);
            if (next) controller.updateSettings((previous) => ({ ...previous, startupScreen: next.preference }));
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {missing && <option value={value}>이전에 선택한 화면 · 현재 사용할 수 없음</option>}
        </select>
      </label>
      <p className="muted">
        다음에 앱을 열 때 적용됩니다.{missing ? ' 책장이 없으면 전체로, 탐색 탭이 없으면 첫 탭으로 열립니다.' : ''}
      </p>
    </section>
  );
}
