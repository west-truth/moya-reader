import type { ReaderSettingsController } from './useReaderSettingsDraft';

/** Rarely changed extension-source behavior, kept out of the main source list. */
export function SourceAdvancedSettings({
  controller,
}: {
  readonly controller: Pick<ReaderSettingsController, 'settings' | 'updateSettings'>;
}) {
  return (
    <details className="reader-source-advanced">
      <summary>확장 소스 고급</summary>
      <label className="reader-settings-control-toggle">
        <span>
          <strong>다운로드한 회차 기준 진행률</strong>
          <small>
            켜면 다운로드한 작품은 받은 회차 기준으로 표시합니다. 스트리밍 전용 작품은 소스의 전체 회차 기준을
            유지합니다.
          </small>
        </span>
        <input
          type="checkbox"
          checked={controller.settings.sourceProgressBasis === 'downloaded'}
          onChange={(event) =>
            controller.updateSettings({ sourceProgressBasis: event.target.checked ? 'downloaded' : 'source' })
          }
        />
      </label>
    </details>
  );
}
