import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ReaderSettings } from '../../domain/types';
import type { ReaderRepository } from '../../repositories/reader-repository';
import { clamp } from '../../utils/format';
import {
  READER_CONTENT_WIDTH_MAX,
  READER_CONTENT_WIDTH_MIN,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  readerSettingsEqual,
  readingSettingsDefaults,
  type ReadingPreset,
} from './reader-settings-model';
import { SerializedSettingsSaveWriter, type SettingsSaveStatus } from './settings-save-writer';

interface ReaderSettingsDraftOptions {
  readonly repository: Pick<ReaderRepository, 'saveSettings'>;
  readonly initialSettings: ReaderSettings;
  readonly debounceMs?: number;
  readonly onSaved: () => Promise<unknown> | unknown;
  readonly onSaveError: (error: unknown) => Promise<void> | void;
  readonly notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'danger') => void;
}

function resolveSettingsAction(action: SetStateAction<ReaderSettings>, previous: ReaderSettings): ReaderSettings {
  return typeof action === 'function' ? action(previous) : action;
}

export function useReaderSettingsDraft(options: ReaderSettingsDraftOptions) {
  const [persistedSettings, setPersistedState] = useState(options.initialSettings);
  const [draftSettings, setDraftState] = useState(options.initialSettings);
  const [open, setOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>('idle');
  const [saveError, setSaveError] = useState(false);
  const persistedRef = useRef(persistedSettings);
  const draftRef = useRef(draftSettings);
  const mountedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const writer = useMemo(
    () =>
      new SerializedSettingsSaveWriter({
        delayMs: options.debounceMs ?? 320,
        write: (settings) => options.repository.saveSettings(settings),
        onCommitted: (settings) => {
          persistedRef.current = settings;
          if (mountedRef.current) {
            setPersistedState(settings);
            setSaveError(false);
          }
          void Promise.resolve(optionsRef.current.onSaved()).catch(() => {
            if (mountedRef.current) {
              optionsRef.current.notify('설정은 저장했지만 동기화 상태를 갱신하지 못했습니다.', 'warning');
            }
          });
        },
        onError: (error) => {
          if (mountedRef.current) setSaveError(true);
          void Promise.resolve(optionsRef.current.onSaveError(error)).catch(() => undefined);
        },
        onStatusChange: (status) => {
          if (mountedRef.current) setSaveStatus(status);
        },
      }),
    [options.debounceMs, options.repository],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void writer.dispose();
    };
  }, [writer]);

  const updateDraft = useCallback(
    (patch: Partial<ReaderSettings>) => {
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      setDraftState(next);
      setSaveError(false);
      writer.schedule(next);
    },
    [writer],
  );

  const setPersistedSettings = useCallback<Dispatch<SetStateAction<ReaderSettings>>>(
    (action) => {
      const previous = persistedRef.current;
      const next = resolveSettingsAction(action, previous);
      const hasLocalDraft = writer.hasUncommitted() || !readerSettingsEqual(draftRef.current, previous);
      persistedRef.current = next;
      setPersistedState(next);
      if (!hasLocalDraft) {
        draftRef.current = next;
        setDraftState(next);
      }
    },
    [writer],
  );

  const closePanel = useCallback(() => {
    setOpen(false);
    void writer.flush();
  }, [writer]);
  const retrySave = useCallback(() => {
    setSaveError(false);
    writer.schedule(draftRef.current);
    void writer.flush();
  }, [writer]);
  const toggleNightTheme = useCallback(
    () =>
      updateDraft({
        theme: draftRef.current.theme === 'dark' || draftRef.current.theme === 'midnight' ? 'light' : 'dark',
      }),
    [updateDraft],
  );
  const adjustFontSize = useCallback(
    (delta: number) =>
      updateDraft({ fontSize: clamp(draftRef.current.fontSize + delta, READER_FONT_SIZE_MIN, READER_FONT_SIZE_MAX) }),
    [updateDraft],
  );
  const adjustContentWidth = useCallback(
    (delta: number) =>
      updateDraft({
        contentWidth: clamp(draftRef.current.contentWidth + delta, READER_CONTENT_WIDTH_MIN, READER_CONTENT_WIDTH_MAX),
      }),
    [updateDraft],
  );
  const resetReadingSettings = useCallback(() => {
    updateDraft(readingSettingsDefaults);
    optionsRef.current.notify('읽기 화면 설정을 기본값으로 돌렸습니다.', 'success');
  }, [updateDraft]);
  const applyReadingPreset = useCallback(
    (preset: ReadingPreset) => {
      updateDraft(preset.settings);
      optionsRef.current.notify(`${preset.label} 프리셋을 적용했습니다.`, 'success');
    },
    [updateDraft],
  );

  return {
    persistedSettings,
    settings: draftSettings,
    setPersistedSettings,
    updateSettings: updateDraft,
    open,
    setOpen,
    openPanel: () => setOpen(true),
    closePanel,
    saveStatus,
    saveError,
    retrySave,
    isDirty: !readerSettingsEqual(draftSettings, persistedSettings),
    toggleNightTheme,
    adjustFontSize,
    adjustContentWidth,
    resetReadingSettings,
    applyReadingPreset,
    flush: () => writer.flush(),
  };
}

export type ReaderSettingsController = ReturnType<typeof useReaderSettingsDraft>;
