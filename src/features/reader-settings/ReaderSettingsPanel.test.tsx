import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { DEFAULT_GESTURE_BINDINGS, DEFAULT_READING_PROFILE } from './reading-profile';
import ReaderSettingsPanel from './ReaderSettingsPanel';
import type { ReaderSettingsController } from './useReaderSettingsDraft';
import type { ExternalSourceController } from '../external-sources/useExternalSourceController';

const externalSources = { sources: [] } as unknown as ExternalSourceController;

function controller(overrides: Partial<ReaderSettingsController> = {}): ReaderSettingsController {
  return {
    open: true,
    settings: defaultSettings,
    saveStatus: 'idle',
    saveError: false,
    isDirty: false,
    closePanel: vi.fn(),
    retrySave: vi.fn(),
    updateSettings: vi.fn(),
    ...overrides,
  } as unknown as ReaderSettingsController;
}

describe('ReaderSettingsPanel', () => {
  it('renders the native reference navigation without replacing real reading controls', () => {
    const markup = renderToStaticMarkup(
      <ReaderSettingsPanel
        controller={controller()}
        profile={DEFAULT_READING_PROFILE}
        bookOverrideEnabled={false}
        contrastWarning={false}
        gestureBindings={DEFAULT_GESTURE_BINDINGS}
        platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' }}
        providerExecutionRuntime="none"
        extensions={[]}
        externalSources={externalSources}
        updateProfile={vi.fn()}
        setBookOverrideEnabled={vi.fn()}
        resetProfile={vi.fn()}
        updateGestureBindings={vi.fn()}
        setExtensionEnabled={vi.fn()}
      />,
    );

    expect(markup).toContain('reader-settings-dialog');
    expect(markup).toContain('reader-settings-backdrop');
    expect(markup.match(/role="tab"/g)).toHaveLength(6);
    expect(markup).toContain('Dropbox, 작품 저장소');
    expect(markup).toContain('테마, 글꼴, 밝기');
    expect(markup).toContain('글자, 여백, 읽기 방식');
    expect(markup).toContain('변경 사항은 이 기기에 자동 저장됩니다.');
    expect(markup).toContain('미드나이트');
    expect(markup).toContain('그래파이트');
    expect(markup).toContain('웜 페이퍼');
    expect(markup).toContain('사용자 설정');
    expect(markup).toContain('aria-label="테마 적용 대상"');
    expect(markup).toContain('앱 UI');
    expect(markup).toContain('책장과 설정 등 앱 화면에 적용됩니다.');
    expect(markup).not.toContain('이 책에만 적용');
  });

  it('announces the actual draft save state and keeps book controls out of the app theme scope', () => {
    const markup = renderToStaticMarkup(
      <ReaderSettingsPanel
        controller={controller({ saveStatus: 'saving', isDirty: true })}
        profile={DEFAULT_READING_PROFILE}
        bookOverrideEnabled
        contrastWarning
        gestureBindings={DEFAULT_GESTURE_BINDINGS}
        platformRuntime={{ kind: 'browser', hasTauri: false, isMobileWebView: false, userAgent: 'Test browser' }}
        providerExecutionRuntime="server"
        extensions={[]}
        externalSources={externalSources}
        updateProfile={vi.fn()}
        setBookOverrideEnabled={vi.fn()}
        resetProfile={vi.fn()}
        updateGestureBindings={vi.fn()}
        setExtensionEnabled={vi.fn()}
      />,
    );

    expect(markup).toContain('변경 사항을 저장하는 중입니다.');
    expect(markup).not.toContain('글자와 배경의 대비가 낮아');
    expect(markup).not.toContain('책 설정 초기화');
  });
});
