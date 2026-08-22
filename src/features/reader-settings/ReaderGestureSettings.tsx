import type { GestureBindings, ReaderAction } from '../../domain/types';
import { ReaderDeviceControls } from './ReaderDeviceControls';

const ACTIONS: Array<{ value: ReaderAction; label: string }> = [
  { value: 'previous_page', label: '이전 페이지' },
  { value: 'next_page', label: '다음 페이지' },
  { value: 'toggle_chrome', label: '도구 모음 표시/숨김' },
  { value: 'open_toc', label: '목차 열기' },
  { value: 'open_settings', label: '설정 열기' },
  { value: 'toggle_tts', label: '듣기 재생/일시정지' },
  { value: 'none', label: '사용 안 함' },
];

export function ReaderGestureSettings({
  bindings,
  update,
}: {
  bindings: GestureBindings;
  update: (patch: Partial<GestureBindings>) => void;
}) {
  const fields: Array<{ key: keyof GestureBindings; label: string }> = [
    { key: 'tapLeft', label: '왼쪽 탭' },
    { key: 'tapCenter', label: '가운데 탭' },
    { key: 'tapRight', label: '오른쪽 탭' },
    { key: 'swipeLeft', label: '왼쪽 스와이프' },
    { key: 'swipeRight', label: '오른쪽 스와이프' },
  ];
  return (
    <section className="reader-gesture-settings reader-settings-group">
      <h3>탭과 스와이프</h3>
      {fields.map((field) => (
        <label key={field.key}>
          <span>
            <strong>{field.label}</strong>
          </span>
          <select
            value={bindings[field.key] ?? 'none'}
            onChange={(event) => update({ [field.key]: event.target.value as ReaderAction })}
          >
            {ACTIONS.map((action) => (
              <option key={action.value} value={action.value}>
                {action.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <ReaderDeviceControls />
    </section>
  );
}
