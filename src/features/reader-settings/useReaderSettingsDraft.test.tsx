import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { useReaderSettingsDraft, type ReaderSettingsController } from './useReaderSettingsDraft';

it('commits device settings without refreshing sync, and still refreshes after a shared change', async () => {
  const saveSettings = vi.fn(async () => undefined);
  const onSaved = vi.fn();
  const options = {
    repository: { saveSettings },
    initialSettings: defaultSettings,
    onSaved,
    onSaveError: vi.fn(),
    notify: vi.fn(),
  };
  let controller!: ReaderSettingsController;
  function Harness() {
    controller = useReaderSettingsDraft(options);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    controller.updateSettings({ fontSize: 28 });
    await controller.flush();
  });
  expect(saveSettings).toHaveBeenCalledOnce();
  expect(controller.persistedSettings.fontSize).toBe(28);
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => {
    controller.updateSettings({ ttsSpeed: 1.5 });
    await controller.flush();
  });
  expect(onSaved).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
});
